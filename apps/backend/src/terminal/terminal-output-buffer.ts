/** Recent direct-PTY output, retained while the UI is disconnected. */
export class TerminalOutputBuffer {
  private chunks: string[] = [];
  private head = 0;
  private length = 0;

  constructor(private readonly maxChars = 256 * 1024) {}

  append(data: string): void {
    if (!data) return;
    this.chunks.push(data);
    this.length += data.length;

    while (this.length > this.maxChars) {
      const chunk = this.chunks[this.head];
      const excess = this.length - this.maxChars;
      if (chunk.length > excess) {
        this.chunks[this.head] = chunk.slice(excess);
        this.length -= excess;
      } else {
        this.length -= chunk.length;
        this.chunks[this.head++] = '';
      }
    }

    if (this.head > 1024) {
      this.chunks = this.chunks.slice(this.head);
      this.head = 0;
    }
  }

  snapshot(): string {
    return this.chunks.slice(this.head).join('');
  }
}
