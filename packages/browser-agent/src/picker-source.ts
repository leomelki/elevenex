import type { BrowserElement } from '@elevenex/shared';

/** Development source hints are optional. Slow source maps must not hold a
 * captured visual reference; the predicate stops further reads after the budget. */
export async function resolvePickedBrowserSources<T extends BrowserElement>(
  element: T,
  read: (current: () => boolean) => Promise<BrowserElement | null>,
  current: () => boolean,
): Promise<T> {
  let active = true, timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const hint = await Promise.race([
      read(() => active && current()).catch(() => null),
      new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), 250); }),
    ]);
    if (!current() || !hint || hint.tag !== element.tag || !(['x', 'y', 'width', 'height'] as const).every(field => Math.abs(hint[field] - element[field]) < 0.5) || !element.snapshot) return element;
    const sources = { ...(hint.source ? { source: hint.source } : {}), ...(hint.componentSource ? { componentSource: hint.componentSource } : {}) };
    return { ...element, ...sources, snapshot: { ...element.snapshot, reference: { ...element.snapshot.reference, ...sources } } };
  } finally { active = false; clearTimeout(timer); }
}
