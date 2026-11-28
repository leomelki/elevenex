/** Bounded direct-PTY history. Small writes coalesce; absolute chunk offsets
 * permit logarithmic cursor lookup without repeatedly flattening all history. */
export class TerminalOutputBuffer {
  private chunks: { data: string; from: number }[] = [];
  private head = 0;
  private length = 0;
  private sequence = 0;

  constructor(private readonly maxChars = 256 * 1024) {}

  append(data: string): void {
    if (!data) return;
    const last = this.chunks.at(-1);
    if (last && this.chunks.length > this.head && last.data.length < 4096) last.data += data;
    else this.chunks.push({ data, from: this.sequence });
    this.length += data.length; this.sequence += data.length;
    while (this.length > this.maxChars) {
      const chunk = this.chunks[this.head], excess = this.length - this.maxChars;
      if (chunk.data.length > excess) {
        chunk.data = chunk.data.slice(excess); chunk.from += excess; this.length -= excess;
      } else {
        this.length -= chunk.data.length; chunk.data = ''; this.head++;
      }
    }
    if (this.head > 1024) { this.chunks = this.chunks.slice(this.head); this.head = 0; }
  }
  snapshot(): string { return this.read(0, this.length); }
  read(offset: number, length: number): string {
    if (length <= 0 || offset >= this.length || !this.length) return '';
    const from = this.sequence - this.length + Math.max(0, offset);
    let low = this.head, high = this.chunks.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (this.chunks[middle].from <= from) low = middle + 1;
      else high = middle;
    }
    let index = Math.max(this.head, low - 1), remaining = length;
    const result: string[] = [];
    while (index < this.chunks.length && remaining > 0) {
      const chunk = this.chunks[index++];
      const start = Math.max(0, from - chunk.from);
      const part = chunk.data.slice(start, start + remaining);
      result.push(part); remaining -= part.length;
    }
    return result.join('');
  }
  get size(): number { return this.length; }
}
