import { afterRenderEffect, DestroyRef, linkedSignal, WritableSignal } from '@angular/core';

export interface ListRow<T> {
  readonly key: string;
  readonly value: T;
  readonly present: boolean;
  readonly entering: boolean;
}

/** Keep removed identities in their old gaps until Fold closes. A key that
 * returns during its exit revives the same component and its local state. */
export function retainListRows<T>(values: readonly T[], previous: readonly ListRow<T>[], keyOf: (value: T) => string, animate: boolean): readonly ListRow<T>[] {
  const previousByKey = new Map(previous.map(row => [row.key, row]));
  const current = values.map(value => {
    const key = keyOf(value);
    const before = previousByKey.get(key);
    return { key, value, present: true, entering: before?.entering ?? (animate && !before) };
  });
  if (!animate) return current.map(row => ({ ...row, entering: false }));
  const keys = new Set(current.map(row => row.key));
  const before = new Map<string, ListRow<T>[]>();
  let next = '';
  for (let index = previous.length - 1; index >= 0; index--) {
    const row = previous[index]!;
    if (keys.has(row.key)) next = row.key;
    else {
      const group = before.get(next) ?? [];
      group.push({ ...row, present: false, entering: false });
      before.set(next, group);
    }
  }
  return current.flatMap(row => [...(before.get(row.key) ?? []).reverse(), row])
    .concat((before.get('') ?? []).reverse());
}

/** Owned by a list component; Fold supplies geometry/ink transitions.
 * One frame and one fallback timer per list, never one timer per row. */
export class ListPresence<T> {
  readonly rows: WritableSignal<readonly ListRow<T>[]>;
  private readonly media = matchMedia('(prefers-reduced-motion: reduce)');
  private frame?: number;
  private cleanup?: ReturnType<typeof setTimeout>;
  private exits = '';
  private readonly deadlines = new Map<string, number>();

  constructor(source: () => readonly T[], keyOf: (value: T) => string, host: HTMLElement, destroy: DestroyRef) {
    this.rows = linkedSignal<readonly T[], readonly ListRow<T>[]>({
      source,
      computation: (values, previous) => retainListRows(values, previous?.value ?? [], keyOf, !!previous && !this.media.matches),
    });
    const finish = () => {
      if (!this.media.matches) return;
      if (this.frame !== undefined) cancelAnimationFrame(this.frame);
      this.frame = undefined;
      clearTimeout(this.cleanup);
      this.deadlines.clear();
      this.rows.update(rows => rows.filter(row => row.present).map(row => ({ ...row, entering: false })));
    };
    this.media.addEventListener('change', finish);
    afterRenderEffect(() => {
      const rows = this.rows();
      if (rows.some(row => row.entering) && this.frame === undefined) {
        // Establish the closed track before opening it on the next frame.
        // The initial list already starts open, so history never animates.
        this.frame = requestAnimationFrame(() => {
          this.frame = undefined;
          this.rows.update(current => current.map(row => row.entering ? { ...row, entering: false } : row));
        });
      }
      const exits = JSON.stringify(rows.filter(row => !row.present).map(row => row.key));
      if (exits === this.exits) return;
      this.exits = exits;
      clearTimeout(this.cleanup);
      const leaving = new Set(rows.filter(row => !row.present).map(row => row.key));
      for (const key of this.deadlines.keys()) if (!leaving.has(key)) this.deadlines.delete(key);
      if (!leaving.size) return;
      // Hidden/zero-height rows may not emit transitionend. The fallback allows
      // the next paint to start the transition before discarding closed rows.
      const duration = parseFloat(getComputedStyle(host).getPropertyValue('--dur-base')) || 200;
      for (const key of leaving) if (!this.deadlines.has(key)) this.deadlines.set(key, performance.now() + duration + 64);
      this.scheduleCleanup();
    });
    destroy.onDestroy(() => {
      if (this.frame !== undefined) cancelAnimationFrame(this.frame);
      clearTimeout(this.cleanup);
      this.media.removeEventListener('change', finish);
    });
  }

  settled(key: string, event: TransitionEvent): void {
    if (event.target !== event.currentTarget || event.propertyName !== 'grid-template-rows') return;
    this.rows.update(rows => rows.filter(row => row.key !== key || row.present));
  }

  private scheduleCleanup(): void {
    let next = Infinity;
    for (const deadline of this.deadlines.values()) next = Math.min(next, deadline);
    if (!Number.isFinite(next)) return;
    this.cleanup = setTimeout(() => {
      const now = performance.now();
      const expired = new Set([...this.deadlines].filter(([, deadline]) => deadline <= now).map(([key]) => key));
      for (const key of expired) this.deadlines.delete(key);
      this.rows.update(rows => rows.filter(row => row.present || !expired.has(row.key)));
      // A stream of later changes must not postpone earlier exits indefinitely.
      this.scheduleCleanup();
    }, Math.max(0, next - performance.now()));
  }
}
