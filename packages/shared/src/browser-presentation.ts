/** Agent-authored, task-local presentation metadata. Never page HTML or CSS. */
export interface BrowserAgentStep {
  readonly n: number;
  readonly total?: number;
  readonly text: string;
  readonly status?: 'running' | 'waiting' | 'done' | 'error';
}
export interface BrowserAgentPoint { readonly x: number; readonly y: number }
export interface BrowserAgentHighlight extends BrowserAgentPoint {
  readonly width: number;
  readonly height: number;
  readonly label?: string;
}
export interface BrowserAgentCursor extends BrowserAgentPoint {
  /** Host-issued, monotonically increasing click/attention pulse identity. */
  readonly pulse: number;
}
export type BrowserPresentationCommand =
  | { readonly kind: 'step'; readonly step: BrowserAgentStep }
  | { readonly kind: 'cursor'; readonly point: BrowserAgentPoint; readonly highlight?: BrowserAgentHighlight; readonly pulse?: boolean }
  | { readonly kind: 'hide-cursor' };
