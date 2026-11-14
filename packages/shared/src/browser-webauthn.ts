/** Public ceremony metadata only. Options and results stay on the private viewer transport. */
export interface BrowserWebAuthnRequest {
  readonly id: string;
  readonly origin: string;
  readonly operation: 'create' | 'get';
}
export interface BrowserWebAuthnOptions extends BrowserWebAuthnRequest {
  readonly optionsJson: string;
}
export type BrowserWebAuthnResult =
  | { readonly responseJson: string }
  | { readonly error: { readonly name: 'NotAllowedError' | 'AbortError' | 'NotSupportedError'; readonly message: string } };
