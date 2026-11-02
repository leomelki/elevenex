/** Ordered, bounded, single-dispatch input. Unknown outcomes are never retried. */
export class TerminalInputQueue {
  private pending = "";
  private pendingBytes = 0;
  private readonly encoder = new TextEncoder();
  private sending = false;
  private closed = false;
  private revision = 0;
  blocked = false;
  constructor(
    private readonly send: (data: string) => Promise<boolean>,
    private readonly failed: (message: string) => void,
  ) {}
  push(data: string): void {
    if (this.closed || this.blocked) return;
    if (this.pending.length + data.length > 128 * 1024) {
      this.failed("Paste is too large. Send at most 128 KiB at a time.");
      return;
    }
    const bytes = this.encoder.encode(data).byteLength;
    if (this.pendingBytes + bytes > 128 * 1024) {
      this.failed("Paste is too large. Send at most 128 KiB at a time.");
      return;
    }
    this.pendingBytes += bytes;
    this.pending += data;
    if (!this.sending) void this.flush();
  }
  private async flush(): Promise<void> {
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
        if (!(await this.send(data)))
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
