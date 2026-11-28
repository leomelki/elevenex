import { describe, expect, it } from 'vitest';
import { retainListRows } from './list-presence';

interface Item { readonly id: string; readonly label: string }
const keyOf = (item: Item): string => item.id;
const original: readonly Item[] = Array.from({ length: 10 }, (_, index) => ({ id: `task-${index + 1}`, label: `Task ${index + 1}` }));

describe('retained list identities', () => {
  it('shows initial history immediately and marks only later additions as entering', () => {
    const initial = retainListRows(original, [], keyOf, false);
    expect(initial.every(row => row.present && !row.entering)).toBe(true);
    const first = { id: 'new-first', label: 'At start' };
    const middle = { id: 'new-middle', label: 'In middle' };
    const last = { id: 'new-last', label: 'At end' };
    const values = [first, ...original.slice(0, 4), middle, ...original.slice(4), last];
    const added = retainListRows(values, initial, keyOf, true);
    expect(added.map(row => row.key)).toEqual(values.map(keyOf));
    expect(added.filter(row => row.entering).map(row => row.key)).toEqual([first.id, middle.id, last.id]);
    expect(added.every(row => row.present)).toBe(true);
    expect(initial.every(row => row.present && !row.entering)).toBe(true);
  });

  it.each([[4], [4, 7], []])('retains removed identities around surviving original indices %j', (...indices: number[]) => {
    const initial = retainListRows(original, [], keyOf, false);
    const keep = new Set(indices.map(index => `task-${index}`));
    const values = original.filter(item => keep.has(item.id));
    const removed = retainListRows(values, initial, keyOf, true);
    expect(removed.map(row => row.key)).toEqual(original.map(keyOf));
    expect(removed.filter(row => row.present).map(row => row.key)).toEqual(values.map(keyOf));
    expect(removed.filter(row => !row.present)).toHaveLength(original.length - values.length);
    expect(removed.every(row => !row.entering)).toBe(true);
  });

  it('revives a removed key once, with its latest value and without a second entry animation', () => {
    const initial = retainListRows(original, [], keyOf, false);
    const removed = retainListRows([], initial, keyOf, true);
    const latest = { id: 'task-4', label: 'Updated while returning' };
    const revived = retainListRows([latest], removed, keyOf, true);
    expect(revived.filter(row => row.key === latest.id)).toEqual([{ key: latest.id, value: latest, present: true, entering: false }]);
    expect(new Set(revived.map(row => row.key)).size).toBe(revived.length);
    expect(revived.filter(row => !row.present)).toHaveLength(9);
    expect(removed.every(row => !row.present)).toBe(true);
  });

  it('keeps current order during interrupted bulk removal, reorder and insertion', () => {
    const initial = retainListRows(original, [], keyOf, false);
    const sparse = original.filter(item => item.id === 'task-4' || item.id === 'task-7');
    const leaving = retainListRows(sparse, initial, keyOf, true);
    const added = { id: 'new-task', label: 'Arrived during exit' };
    const latest = [sparse[1]!, added, sparse[0]!];
    const interrupted = retainListRows(latest, leaving, keyOf, true);
    expect(interrupted.filter(row => row.present).map(row => row.value)).toEqual(latest);
    expect(new Set(interrupted.map(row => row.key)).size).toBe(interrupted.length);
    expect(interrupted.filter(row => row.entering).map(row => row.key)).toEqual([added.id]);
    expect(interrupted.filter(row => !row.present)).toHaveLength(8);
  });

  it('applies the latest list immediately when motion is disabled, including pending exits and entries', () => {
    const initial = retainListRows(original, [], keyOf, false);
    const replacement = { id: 'new-task', label: 'Replacement' };
    const moving = retainListRows([replacement], initial, keyOf, true);
    const settled = retainListRows([replacement], moving, keyOf, false);
    expect(settled).toEqual([{ key: replacement.id, value: replacement, present: true, entering: false }]);
    expect(retainListRows([], moving, keyOf, false)).toEqual([]);
  });
});
