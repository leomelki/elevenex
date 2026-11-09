/** Private main/backend automation transport. Never exposed through the renderer bridge. */
export interface BrowserCodeCommand {
  readonly kind: 'code';
  readonly code: string;
  readonly timeoutMs: number;
  readonly reset?: boolean;
}
export interface BrowserCodeImage {
  readonly data: string;
  readonly mimeType: 'image/jpeg' | 'image/png';
  readonly width: number;
  readonly height: number;
}
export interface BrowserCodeResult {
  readonly sandboxId: string;
  readonly value: unknown;
  readonly logs: readonly string[];
  readonly images: readonly BrowserCodeImage[];
  readonly error?: { readonly message: string; readonly outcomeUnknown: boolean };
}
