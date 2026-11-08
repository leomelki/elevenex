export interface TerminalInputTarget {
  readonly scopeId: string;
  readonly taskId: number;
  readonly terminalId: number;
  readonly generation: string;
}

/** Ordered, bounded input. A queued chunk can never acquire a replacement process. */
export class TerminalInputQueue {
  private target?: TerminalInputTarget;
  private pending: { data: string; kind: 'text' | 'binary' }[] = [];
  private pendingBytes = 0;
  private readonly encoder = new TextEncoder();
  private sending = false;
  private closed = false;
  private revision = 0;
  blocked = false;
  get idle(): boolean {
    return !this.sending && !this.pending.length && !this.blocked && !this.closed && !!this.target;
  }
  constructor(
    private readonly send: (data: string, target: TerminalInputTarget, kind: 'text' | 'binary') => Promise<boolean>,
    private readonly failed: (message: string) => void,
  ) {}
  bind(target: TerminalInputTarget): void {
    const old = this.target;
    if (old && old.scopeId === target.scopeId && old.taskId === target.taskId &&
        old.terminalId === target.terminalId && old.generation === target.generation) return;
    this.reconnect();
    this.target = { ...target };
  }
  push(data: string, kind: 'text' | 'binary' = 'text'): boolean {
    if (this.closed || this.blocked || !this.target) return false;
    const bytes = this.encoder.encode(data).byteLength;
    if (this.pendingBytes + bytes > 128 * 1024) {
      this.failed("Paste is too large. Send at most 128 KiB at a time.");
      return false;
    }
    this.pendingBytes += bytes;
    const last = this.pending.at(-1);
    if (last?.kind === kind) last.data += data;
    else this.pending.push({ data, kind });
    if (!this.sending) void this.flush();
    return true;
  }
  private async flush(): Promise<void> {
    const target = this.target;
    if (!target) return;
    this.sending = true;
    const revision = this.revision;
    // Coalesce keyboard/paste events in this task before crossing IPC.
    await Promise.resolve();
    try {
      while (
        this.pending.length &&
        !this.closed &&
        !this.blocked &&
        revision === this.revision
      ) {
        const pending = this.pending[0]!;
        let end = Math.min(4096, pending.data.length);
        if (
          pending.kind === 'text' && end < pending.data.length &&
          /[\uDC00-\uDFFF]/.test(pending.data[end]!)
        )
          end--;
        const data = pending.data.slice(0, end);
        pending.data = pending.data.slice(end);
        if (!pending.data) this.pending.shift();
        this.pendingBytes -= this.encoder.encode(data).byteLength;
        if (!(await this.send(data, target, pending.kind)))
          throw new Error("Input outcome is unknown");
      }
    } catch {
      if (revision !== this.revision) return;
      this.pending = [];
      this.pendingBytes = 0;
      this.blocked = true;
      this.failed(
        "Input may have been interrupted. Nothing will be replayed. Inspect the terminal, then resume typing.",
      );
    } finally {
      this.sending = false;
      if (this.pending.length && !this.closed && !this.blocked) void this.flush();
    }
  }
  reconnect(): void {
    const interrupted = this.sending || !!this.pending.length;
    this.revision++;
    this.pending = [];
    this.pendingBytes = 0;
    if (interrupted) {
      this.blocked = true;
      this.failed(
        "Input may have been interrupted. Nothing will be replayed. Inspect the terminal, then resume typing.",
      );
    }
  }
  interrupt(message: string): void {
    this.revision++; this.pending = []; this.pendingBytes = 0; this.blocked = true; this.failed(message);
  }
  resume(): void {
    this.revision++;
    this.pending = [];
    this.pendingBytes = 0;
    this.blocked = false;
  }
  dispose(): void {
    this.revision++;
    this.closed = true;
    this.pending = [];
    this.pendingBytes = 0;
  }
}
