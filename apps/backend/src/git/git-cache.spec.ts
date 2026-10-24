import { GitByteLru, GitCacheBudget } from './git-cache.js';

describe('Git byte budget', () => {
  it('does not evict useful entries for a value larger than the whole budget', () => {
    const budget = new GitCacheBudget(800);
    const cache = new GitByteLru<string>(budget);
    cache.set('kept', 'x'.repeat(100));
    const retained = budget.bytes;
    cache.set('oversized', 'x'.repeat(1000));
    expect(cache.has('oversized')).toBe(false);
    expect(cache.get('kept')).toBe('x'.repeat(100));
    expect(budget.bytes).toBe(retained);
  });

  it('evicts the least recently used value across cache types and drops oversized entries', () => {
    const budget = new GitCacheBudget(800);
    const rows = new GitByteLru<string>(budget),
      blobs = new GitByteLru<string>(budget);
    rows.set('a', 'a'.repeat(100));
    blobs.set('b', 'b'.repeat(100));
    expect(rows.get('a')).toBeDefined();
    rows.set('c', 'c'.repeat(150));
    expect(blobs.has('b')).toBe(false);
    expect(rows.has('a')).toBe(true);
    for (let i = 0; i < 1000; i++) blobs.set(String(i), 'x'.repeat(50));
    expect(budget.bytes).toBeLessThanOrEqual(800);
    blobs.set('huge', 'x'.repeat(1000));
    expect(blobs.has('huge')).toBe(false);
    rows.clear();
    blobs.clear();
    expect(budget.bytes).toBe(0);
  });
});
