export interface TerminalInputTarget {
  readonly scopeId: string;
  readonly taskId: number;
  readonly terminalId: number;
  readonly generation: string;
}

/** Ordered, bounded input. A queued chunk can never acquire a replacement process. */
export class TerminalInputQueue {
  private target?: TerminalInputTarget;
  private pending = "";
  private pendingBytes = 0;
  private readonly encoder = new TextEncoder();
  private sending = false;
  private closed = false;
  private revision = 0;
  blocked = false;
  get idle(): boolean {
    return !this.sending && !this.pending && !this.blocked && !this.closed && !!this.target;
  }
  constructor(
    private readonly send: (data: string, target: TerminalInputTarget) => Promise<boolean>,
    private readonly failed: (message: string) => void,
  ) {}
  bind(target: TerminalInputTarget): void {
    const old = this.target;
    if (old && old.scopeId === target.scopeId && old.taskId === target.taskId &&
        old.terminalId === target.terminalId && old.generation === target.generation) return;
    this.reconnect();
    this.target = { ...target };
  }
  push(data: string): boolean {
    if (this.closed || this.blocked || !this.target) return false;
    if (this.pending.length + data.length > 128 * 1024) {
      this.failed("Paste is too large. Send at most 128 KiB at a time.");
      return false;
    }
    const bytes = this.encoder.encode(data).byteLength;
    if (this.pendingBytes + bytes > 128 * 1024) {
      this.failed("Paste is too large. Send at most 128 KiB at a time.");
      return false;
    }
    this.pendingBytes += bytes;
    this.pending += data;
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
        this.pending &&
        !this.closed &&
        !this.blocked &&
        revision === this.revision
      ) {
        let end = Math.min(4096, this.pending.length);
        if (
          end < this.pending.length &&
          /[\uDC00-\uDFFF]/.test(this.pending[end]!)
        )
          end--;
        const data = this.pending.slice(0, end);
        this.pending = this.pending.slice(end);
        this.pendingBytes -= this.encoder.encode(data).byteLength;
        if (!(await this.send(data, target)))
          throw new Error("Input outcome is unknown");
      }
    } catch {
      if (revision !== this.revision) return;
      this.pending = "";
      this.pendingBytes = 0;
      this.blocked = true;
      this.failed(
        "Input may have been interrupted. Nothing will be replayed. Inspect the terminal, then resume typing.",
      );
    } finally {
      this.sending = false;
      if (this.pending && !this.closed && !this.blocked) void this.flush();
    }
  }
  reconnect(): void {
    const interrupted = this.sending || !!this.pending;
    this.revision++;
    this.pending = "";
    this.pendingBytes = 0;
    if (interrupted) {
      this.blocked = true;
      this.failed(
        "Input may have been interrupted. Nothing will be replayed. Inspect the terminal, then resume typing.",
      );
    }
  }
  resume(): void {
    this.revision++;
    this.pending = "";
    this.pendingBytes = 0;
    this.blocked = false;
  }
  dispose(): void {
    this.revision++;
    this.closed = true;
    this.pending = "";
    this.pendingBytes = 0;
  }
}
