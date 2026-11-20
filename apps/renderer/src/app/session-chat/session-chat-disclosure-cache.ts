/** A window-local LRU for completed disclosure snapshots, bounded by entries and serialized size. */
export class ChatDisclosureCache<T> {
  private scope: string | undefined;
  private bytes = 0;
  private readonly entries = new Map<string, { value: T; bytes: number }>();
  private readonly encoder = new TextEncoder();

  constructor(private readonly maxEntries: number, private readonly maxBytes: number) {}

  get(scope: string, key: string): T | undefined {
    this.selectScope(scope);
    const entry = this.entries.get(key);
    if (entry) {
      this.entries.delete(key);
      this.entries.set(key, entry);
    }
    return entry?.value;
  }

  put(scope: string, key: string, value: T): void {
    this.selectScope(scope);
    const bytes = this.encoder.encode(JSON.stringify(value)).byteLength;
    this.bytes -= this.entries.get(key)?.bytes ?? 0;
    this.entries.delete(key);
    if (bytes > this.maxBytes) return;
    this.entries.set(key, { value, bytes });
    this.bytes += bytes;
    for (const [id, entry] of this.entries) {
      if (this.entries.size <= this.maxEntries && this.bytes <= this.maxBytes) break;
      this.entries.delete(id);
      this.bytes -= entry.bytes;
    }
  }

  private selectScope(scope: string): void {
    if (scope === this.scope) return;
    this.scope = scope;
    this.entries.clear();
    this.bytes = 0;
  }
}
