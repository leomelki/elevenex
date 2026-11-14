import type { BrowserComponentSource, BrowserSourceLocation } from '@elevenex/shared';

/** Private, bounded page-to-host protocol. Only metadata is copied; no framework objects escape. */
export type SourceCandidate =
  | { readonly type: 'location'; readonly file: string; readonly line: number; readonly column?: number; readonly kind: BrowserSourceLocation['kind'] }
  | { readonly type: 'stack'; readonly stack: string }
  | ({ readonly type: 'component' } & BrowserComponentSource);
export interface ProbeHelpers {
  readonly own: (value: unknown, key: string) => unknown;
  readonly attribute: (element: Element, name: string) => string | undefined;
}
/** Adapters must be closure-free: they are serialized into the unprivileged main world. */
export type SourceAdapter = (element: Element, helpers: ProbeHelpers) => readonly SourceCandidate[];
