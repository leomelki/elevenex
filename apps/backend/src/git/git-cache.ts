/** Conservative retained-size accounting; this is a budget, not a heap profiler. */
export function retainedBytes(value: unknown): number {
  if (typeof value === 'string') return 24 + value.length * 2;
  if (value === null || value === undefined) return 8;
  if (typeof value !== 'object') return 8;
  if (Array.isArray(value)) {
    const items: unknown[] = value;
    return (
      32 + items.reduce<number>((sum, item) => sum + retainedBytes(item), 0)
    );
  }
  if (value instanceof Set) {
    const items: Set<unknown> = value;
    let bytes = 48;
    for (const item of items) bytes += retainedBytes(item);
    return bytes;
  }
  if (value instanceof Map)
    return (
      48 +
      [...value].reduce(
        (sum, [key, item]) => sum + retainedBytes(key) + retainedBytes(item),
        0,
      )
    );
  return (
    64 +
    Object.entries(value).reduce(
      (sum, [key, item]) => sum + key.length * 2 + retainedBytes(item),
      0,
    )
  );
}

/** Small cached slices must not retain an entire Git/status output string. */
export function copyCacheString(value: string): string {
  return Buffer.from(value, 'utf8').toString('utf8');
}

export class GitCacheBudget {
  private readonly entries = new Map<
    object,
    { bytes: number; evict: () => void }
  >();
  bytes = 0;
  hits = 0;
  constructor(readonly maxBytes = 64 * 1024 * 1024) {}
  touch(token: object): void {
    const entry = this.entries.get(token);
    if (!entry) return;
    this.hits++;
    this.entries.delete(token);
    this.entries.set(token, entry);
  }
  remove(token: object): void {
    const entry = this.entries.get(token);
    if (entry) {
      this.bytes -= entry.bytes;
      this.entries.delete(token);
    }
  }
  add(token: object, bytes: number, evict: () => void): void {
    this.remove(token);
    this.entries.set(token, { bytes, evict });
    this.bytes += bytes;
    while (this.bytes > this.maxBytes) {
      for (const entry of this.entries.values()) {
        entry.evict();
        break;
      }
    }
  }
}

export class GitByteLru<T> extends Map<string, T> {
  private readonly tokens = new Map<string, object>();
  constructor(private readonly budget: GitCacheBudget) {
    super();
  }
  override get(key: string): T | undefined {
    const value = super.get(key);
    const token = this.tokens.get(key);
    if (token) {
      this.budget.touch(token);
      super.delete(key);
      super.set(key, value!);
    }
    return value;
  }
  override set(key: string, value: T): this {
    this.delete(key);
    const token = {};
    super.set(key, value);
    this.tokens.set(key, token);
    this.budget.add(token, retainedBytes(key) + retainedBytes(value), () => {
      this.delete(key);
    });
    return this;
  }
  override delete(key: string): boolean {
    const token = this.tokens.get(key);
    if (token) this.budget.remove(token);
    this.tokens.delete(key);
    return super.delete(key);
  }
  override clear(): void {
    for (const key of this.keys()) this.delete(key);
  }
}
