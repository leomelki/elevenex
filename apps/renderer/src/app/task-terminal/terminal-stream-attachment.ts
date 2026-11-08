import type { ElevenexBridge, TaskTerminal, TaskTerminalAttach, TaskTerminalAttachment, TaskTerminalList, TaskTerminalStreamPacket } from '@elevenex/shared';
import type { TerminalSurface } from './terminal-surface';

interface AttachmentOwner {
  inputIdle(): boolean;
  terminal(value: TaskTerminal): void;
  metadata(value: TaskTerminalList): void;
  changed(): void;
  interrupted(message: string, uncertain: boolean): void;
}

/** Visible-view lifetime. Owns its subscription, cursor commits and end-to-end
 * render credits. Detach never owns or terminates the backend process. */
export class TerminalStreamAttachment {
  readonly target: TaskTerminalAttach;
  private readonly identity: TaskTerminalAttachment;
  private stopEvents?: () => void;
  private disposed = false;
  private applying = Promise.resolve();
  private sequence = 0;
  private acknowledgedInput = 0;
  private connected = false;
  private caughtUp = false;
  private writable = false;
  get ready(): boolean { return this.connected && this.caughtUp && this.writable && !this.disposed; }
  get uncertain(): boolean { return this.sequence > this.acknowledgedInput; }

  constructor(private readonly bridge: ElevenexBridge, private readonly scope: string,
    target: Omit<TaskTerminalAttach, 'attachmentId'>, private readonly surface: TerminalSurface, private readonly owner: AttachmentOwner) {
    this.target = { ...target, attachmentId: crypto.randomUUID() };
    this.identity = { taskId: target.taskId, terminalId: target.terminalId, attachmentId: this.target.attachmentId };
  }
  async start(): Promise<void> {
    this.surface.setServerProtocol(true); this.surface.setEnabled(false);
    this.stopEvents = this.bridge.onTaskTerminalStream(event => {
      if (this.disposed || event.scopeId !== this.scope || event.attachmentId !== this.target.attachmentId ||
          event.taskId !== this.target.taskId || event.terminalId !== this.target.terminalId) return;
      const packet = event.packet;
      if (packet.type === 'metadata') this.owner.metadata(packet.list);
      else if (packet.type === 'control') { this.writable = packet.writable; this.owner.changed(); }
      else if (packet.type === 'input-ack') this.acknowledgedInput = packet.sequence;
      else if (packet.type === 'closed') this.fail(packet.message, packet.uncertain || this.sequence > this.acknowledgedInput);
      else {
        // Capture causality at arrival, before waiting behind another write.
        // An unsent local key is just as important as an unacknowledged one.
        const revision = this.surface.localEcho.inputRevision;
        const allowPrompt = this.sequence === this.acknowledgedInput && this.owner.inputIdle();
        this.applying = this.applying.then(() => this.apply(packet, revision, allowPrompt))
          .catch(() => this.fail('Terminal output was interrupted. Reattach to recover.', this.sequence > this.acknowledgedInput));
      }
    });
    try {
      const reply = await this.bridge.taskTerminalAttach(this.scope, this.target);
      if (this.disposed) return;
      if (!reply.ok) { this.fail(reply.error.message, false); return; }
      this.connected = true; this.owner.changed();
    } catch { this.fail('Could not attach the terminal stream.', false); }
  }
  async input(data: string, generation: string, kind: 'text' | 'binary'): Promise<boolean> {
    if (!this.ready) return false;
    const reply = await this.bridge.taskTerminalStreamWrite(this.scope, { ...this.identity, generation, sequence: ++this.sequence, kind, data });
    return reply.ok && !this.disposed;
  }
  async resize(cols: number, rows: number): Promise<void> {
    if (!this.ready) return;
    const reply = await this.bridge.taskTerminalStreamResize(this.scope, { ...this.identity, cols, rows });
    if (!reply.ok) throw new Error(reply.error.message);
  }
  focus(): void {
    if (!this.disposed && this.connected) void this.bridge.taskTerminalStreamFocus(this.scope, this.identity).catch(() => {});
  }
  async settled(): Promise<void> { await this.applying; }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true; this.connected = false;
    this.stopEvents?.(); this.surface.localEcho.suspend(); this.surface.setEnabled(false);
    void this.bridge.taskTerminalDetach(this.scope, this.identity).catch(() => {});
  }
  private async apply(packet: Extract<TaskTerminalStreamPacket, { type: 'output' | 'snapshot' }>, inputRevision: number, allowPrompt: boolean): Promise<void> {
    if (this.disposed) return;
    if (packet.type === 'snapshot') {
      this.caughtUp = false; this.surface.setEnabled(false);
      if (packet.first) this.surface.reset();
      await this.surface.write((packet.first ? '\x1bc' : '') + packet.data, packet.size, !packet.last);
      this.surface.generation = packet.terminal.generation; this.surface.sequence = packet.sequence;
      this.owner.terminal(packet.terminal);
      if (packet.last) this.caughtUp = true;
    } else {
      const output = packet.output;
      if (!this.caughtUp) this.surface.setEnabled(false);
      await this.surface.write(output.data, output.size, output.more, output.commandStarts, output.from);
      this.surface.generation = output.generation; this.surface.sequence = output.next;
      this.caughtUp = !output.more; this.owner.terminal(output.terminal);
      this.surface.localEcho.reconcile(output.inputPreview?.prompt, inputRevision, allowPrompt, output.data.length > 0);
    }
    if (this.disposed) return;
    this.owner.changed();
    await this.bridge.taskTerminalStreamAcknowledge(this.scope, { ...this.identity, delivery: packet.delivery });
  }
  private fail(message: string, uncertain: boolean): void {
    if (this.disposed) return;
    this.dispose(); this.owner.interrupted(message, uncertain);
  }
}
