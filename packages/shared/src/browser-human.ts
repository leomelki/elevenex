export type BrowserHumanCommand =
  | {
      readonly kind: 'request';
      readonly tabId: string;
      readonly requestKind: 'action' | 'element';
      readonly message: string;
    }
  | { readonly kind: 'read' | 'cancel'; readonly requestId: string };

export interface BrowserHumanElement {
  readonly snapshot?: import('./browser-element-reference.js').BrowserElementSnapshot;
  readonly selector: string;
  readonly frames: readonly string[];
  readonly tag: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly documentId: string;
  readonly frameId?: string;
  readonly loaderId?: string;
}
export interface BrowserHumanRequest {
  readonly id: string;
  readonly sessionId: number;
  readonly tabId: string;
  readonly kind: 'action' | 'element';
  readonly message: string;
  readonly status: 'pending' | 'completed' | 'cancelled' | 'expired';
  readonly expiresAt: number;
  readonly selection?: BrowserHumanElement;
}
