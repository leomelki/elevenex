import { WebSocket } from 'ws';
import type { DesktopTerminalService } from '../desktop-terminal.service.js';

type Attachment = Awaited<ReturnType<DesktopTerminalService['attach']>>;
type Output = ReturnType<Attachment['read']>;
interface Snapshot { sequence: number; cols: number; rows: number; data: string; position: number }

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid terminal frame');
  return value as Record<string, unknown>;
}
function integer(value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) throw new Error('Invalid terminal number');
  return value;
}

/** One independent consumer cursor/credit window. A stalled view cannot pause
 * another window or retain an unbounded copy of the PTY output. */
export class DesktopTerminalConnection {
  private attachment?: Attachment;
  private stop?: () => void;
  private metadataTimer?: ReturnType<typeof setInterval>;
  private metadataPending?: Promise<void>;
  private metadata = '';
  private closed = false;
  private pumping = false;
  private requested = false;
  private initialized = false;
  private cursor: number;
  private generation: string | null;
  private snapshot?: Snapshot;
  private delivery = 0;
  private acknowledged = 0;
  private readonly outstanding = new Map<number, number>();
  private outstandingChars = 0;
  private inputSequence = 0;
  private queuedInput = 0;
  private queuedOperations = 0;
  private operations = Promise.resolve();
  writable = false;

  constructor(
    readonly ws: WebSocket,
    readonly taskId: number,
    readonly terminalId: number,
    generation: string | null,
    after: number,
    private readonly service: DesktopTerminalService,
    private readonly focus: (connection: DesktopTerminalConnection) => void,
    private readonly departed: (connection: DesktopTerminalConnection) => void,
  ) {
    this.generation = generation; this.cursor = after;
    ws.on('message', (data, binary) => {
      try {
        if (binary) throw new Error('Expected a terminal control frame');
        this.receive(JSON.parse(data.toString()));
      } catch { this.close('Terminal protocol rejected an invalid frame.'); }
    });
    ws.once('close', () => this.dispose());
    ws.on('error', () => this.dispose());
  }
  async start(): Promise<void> {
    try {
      const attachment = await this.service.attach(this.taskId, this.terminalId);
      if (this.closed) return;
      this.attachment = attachment;
      this.stop = attachment.stream.subscribe(() => this.wake());
      this.initialized = true;
      this.focus(this);
      await this.refreshMetadata();
      // OS listener discovery is sampled; PTY output is event-driven. No
      // unchanged metadata is sent and no renderer HTTP polling is necessary.
      this.metadataTimer = setInterval(() => void this.refreshMetadata(), 1800);
      this.metadataTimer.unref();
      this.wake();
    } catch { this.close('This terminal could not be attached.'); }
  }
  control(writable: boolean): void {
    if (this.writable === writable) return;
    this.writable = writable; this.send({ type: 'control', writable });
  }
  dispose(): void {
    if (this.closed) return;
    this.closed = true;
    this.stop?.(); clearInterval(this.metadataTimer);
    this.outstanding.clear(); this.snapshot = undefined;
    this.departed(this);
  }
  private close(message: string): void {
    if (this.closed) return;
    this.send({ type: 'closed', uncertain: this.queuedInput > 0, message });
    this.dispose(); this.ws.close(1008, 'Terminal stream closed');
  }
  private send(value: unknown): void {
    if (this.closed || this.ws.readyState !== WebSocket.OPEN) return;
    if (this.ws.bufferedAmount > 1024 * 1024) { this.dispose(); this.ws.terminate(); return; }
    this.ws.send(JSON.stringify(value));
  }
  private receive(raw: unknown): void {
    const value = object(raw);
    if (!this.initialized || !this.attachment?.current()) throw new Error('Terminal is not attached');
    if (value.type === 'ack') {
      const delivery = integer(value.delivery, this.acknowledged, this.delivery);
      for (const [id, count] of this.outstanding) if (id <= delivery) { this.outstandingChars -= count; this.outstanding.delete(id); }
      this.acknowledged = delivery; this.wake(); return;
    }
    if (value.type === 'focus') { this.focus(this); return; }
    if (!this.writable && value.type !== 'resize') throw new Error('Another terminal view owns input');
    const generation = this.attachment.stream.generation;
    let command: Record<string, unknown>, sequence: number | undefined, size = 0;
    if (value.type === 'input') {
      sequence = integer(value.sequence, this.inputSequence + 1, this.inputSequence + 1);
      if (value.generation !== generation || (value.kind !== 'text' && value.kind !== 'binary') ||
          typeof value.data !== 'string' || !value.data || value.data.length > 4096 || Buffer.byteLength(value.data) > 16384)
        throw new Error('Invalid terminal input');
      size = Buffer.byteLength(value.data);
      if (this.queuedInput + size > 128 * 1024) throw new Error('Terminal input queue is full');
      this.inputSequence = sequence; this.queuedInput += size;
      command = { type: value.kind === 'text' ? 'input' : 'binary', generation, data: value.data };
    } else if (value.type === 'resize') command = { type: 'resize', generation, cols: integer(value.cols, 2, 500), rows: integer(value.rows, 1, 300) };
    else throw new Error('Unknown terminal operation');
    if (!this.writable) return;
    if (++this.queuedOperations > 256) throw new Error('Terminal operation queue is full');
    this.operations = this.operations.then(async () => {
      if (this.closed) return;
      // Focus can change while an asynchronous ownership check is running.
      if (!this.writable) {
        // A queued geometry update from the previous owner is obsolete. It
        // must not disconnect an otherwise healthy output observer.
        if (sequence === undefined) return;
        throw new Error('Terminal control changed');
      }
      await this.service.command(this.taskId, this.terminalId, command);
      if (sequence !== undefined) this.send({ type: 'input-ack', sequence });
      this.wake();
    }).catch(() => this.close(this.queuedInput > 0
      ? 'Some keystrokes may not have reached the terminal. Check the output before resuming; nothing will be resent.'
      : 'Terminal connection lost. Reconnecting…'))
      .finally(() => { this.queuedInput -= size; this.queuedOperations--; });
  }
  private wake(): void {
    this.requested = true;
    if (!this.pumping) void this.pump();
  }
  private async pump(): Promise<void> {
    if (!this.attachment || this.closed) return;
    this.pumping = true;
    try {
      do {
        this.requested = false;
        if (!this.attachment.current()) { this.close('The terminal process changed. Reattach to inspect it.'); return; }
        while (!this.closed && this.outstandingChars < 128 * 1024 && this.outstanding.size < 128) {
          if (this.snapshot) {
            const snapshot = this.snapshot;
            let end = Math.min(snapshot.data.length, snapshot.position + 32768);
            if (end < snapshot.data.length && /[\uDC00-\uDFFF]/.test(snapshot.data[end])) end--;
            const data = snapshot.data.slice(snapshot.position, end);
            const delivery = this.credit(data.length);
            this.send({ type: 'snapshot', delivery, terminal: this.attachment.read(this.generation, this.cursor).terminal,
              sequence: snapshot.sequence, size: { cols: snapshot.cols, rows: snapshot.rows }, data,
              first: snapshot.position === 0, last: end === snapshot.data.length });
            snapshot.position = end;
            if (end === snapshot.data.length) { this.cursor = snapshot.sequence; this.snapshot = undefined; }
            continue;
          }
          const output: Output = this.attachment.read(this.generation, this.cursor);
          if (output.gap) {
            // Drain already delivered events before replacing their screen.
            if (this.outstanding.size) break;
            const snapshot = await this.attachment.snapshot();
            if (this.closed) return;
            this.generation = this.attachment.stream.generation;
            this.snapshot = { ...snapshot, position: 0 };
            continue;
          }
          // Empty packets carry geometry, process state and prompt revocation.
          if (!output.data) {
            const signature = JSON.stringify(output);
            if (signature === this.lastOutput) break;
            this.lastOutput = signature;
          } else this.lastOutput = '';
          this.send({ type: 'output', delivery: this.credit(Math.max(1, output.data.length)), output });
          this.cursor = output.next;
          if (!output.more) break;
        }
      } while (this.requested && !this.closed);
    } catch { this.close('Terminal screen recovery failed. Reattach to try again.'); }
    finally { this.pumping = false; }
  }
  private lastOutput = '';
  private credit(count: number): number {
    const delivery = ++this.delivery;
    this.outstanding.set(delivery, count); this.outstandingChars += count;
    return delivery;
  }
  private refreshMetadata(): Promise<void> {
    if (this.metadataPending) return this.metadataPending;
    const pending = Promise.all([this.service.list(this.taskId), this.attachment?.refresh()]).then(([list]) => {
      const metadata = JSON.stringify(list);
      if (metadata !== this.metadata) { this.metadata = metadata; this.send({ type: 'metadata', list }); }
    }).catch(() => this.close('Terminal ownership is no longer available.'))
      .finally(() => { if (this.metadataPending === pending) this.metadataPending = undefined; });
    this.metadataPending = pending;
    return pending;
  }
}
