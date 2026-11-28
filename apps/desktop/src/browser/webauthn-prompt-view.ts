import type { BrowserWebAuthnRequest } from '@elevenex/shared';

/** What the authentication sheet shows. Pure data: the fixed in-page controller
 * writes these strings with `textContent`, never as markup. */
export type PromptPhase = 'confirm' | 'waiting' | 'accounts' | 'failed';
export type PromptChoice = 'continue' | 'retry' | 'cancel' | `account:${number}`;
export interface PromptAccount { readonly name: string; readonly detail: string; readonly initial: string }
export interface PromptView {
  readonly phase: PromptPhase;
  readonly title: string;
  /** The exact engine-validated origin, shown in mono beside the title. */
  readonly origin: string;
  readonly detail: string;
  /** Quiet line under the detail; empty hides it. */
  readonly note: string;
  /** Live progress line in the footer; empty hides it. */
  readonly status: string;
  readonly primary: { readonly label: string; readonly choice: 'continue' | 'retry' } | null;
  readonly secondary: string;
  readonly accounts: readonly PromptAccount[];
  /** Read to assistive technology when the sheet changes phase. */
  readonly announce: string;
}
export interface AuthenticatorAccount { readonly displayName?: string; readonly name?: string }
export type PromptPlatform = 'win32' | 'other';

const MAX_LABEL = 120;
const bounded = (value: string) => value.length > MAX_LABEL ? value.slice(0, MAX_LABEL - 1) + '…' : value;

/** The host as URL parsing normalizes it: IDNs stay in punycode, so a lookalike
 * name cannot borrow another site's letters, and a non-default port stays visible. */
export function promptHost(origin: string): string {
  try { return new URL(origin).host || origin; } catch { return origin; }
}

export function promptPlatform(platform: NodeJS.Platform): PromptPlatform {
  return platform === 'win32' ? 'win32' : 'other';
}

export function confirmView(request: BrowserWebAuthnRequest): PromptView {
  const host = promptHost(request.origin);
  const title = request.operation === 'create' ? 'Create a passkey for ' + host : 'Sign in to ' + host;
  return {
    phase: 'confirm', title, origin: request.origin,
    detail: request.operation === 'create'
      ? 'A page in this task’s browser wants to create a passkey with your device or security key.'
      : 'A page in this task’s browser wants you to sign in with your passkey or security key.',
    note: 'Your device does the signing and the key never leaves it. Agents can’t use it.',
    status: '', primary: { label: 'Continue', choice: 'continue' }, secondary: 'Cancel', accounts: [],
    announce: title,
  };
}

export function waitingView(request: BrowserWebAuthnRequest, platform: PromptPlatform): PromptView {
  // Electron has no authenticator UI of its own except the OS's Windows Hello
  // dialog; elsewhere only roaming keys are available (see task-browser-webauthn.md).
  const title = platform === 'win32' ? 'Follow your device’s prompt' : 'Touch your security key';
  return {
    phase: 'waiting', title, origin: request.origin,
    detail: platform === 'win32'
      ? 'Windows asks for Windows Hello or a security key. Finish there to continue.'
      : 'Insert it if it isn’t plugged in, then touch it when it blinks.',
    note: '', status: platform === 'win32' ? 'Waiting for Windows…' : 'Waiting for your key…',
    primary: null, secondary: 'Cancel', accounts: [], announce: title,
  };
}

export function accountsView(request: BrowserWebAuthnRequest, accounts: readonly AuthenticatorAccount[]): PromptView {
  const title = 'Choose an account';
  return {
    phase: 'accounts', title, origin: request.origin,
    detail: 'Your key holds more than one passkey for ' + promptHost(request.origin) + '.',
    note: '', status: '', primary: null, secondary: 'Cancel',
    accounts: accounts.map(account => {
      const name = bounded(account.displayName || account.name || 'Account');
      const detail = account.displayName && account.name && account.name !== account.displayName ? bounded(account.name) : '';
      return { name, detail, initial: [...name.trim()][0]?.toLocaleUpperCase() ?? '·' };
    }),
    announce: title + ', ' + accounts.length + ' accounts',
  };
}

/** `name` is the DOMException name from the local `navigator.credentials` call. */
export function failedView(request: BrowserWebAuthnRequest, name: string): PromptView {
  const host = promptHost(request.origin);
  const title = request.operation === 'create' ? 'Couldn’t create a passkey for ' + host : 'Couldn’t sign in to ' + host;
  const detail =
    name === 'InvalidStateError' ? 'This key already holds a passkey for this site. Try another key.'
    : name === 'NotSupportedError' ? 'Your device can’t do what this site asks for.'
    : name === 'SecurityError' ? 'This site isn’t allowed to use that passkey.'
    : name === 'NotAllowedError' ? 'Your device didn’t respond in time, or the request was canceled.'
    : 'Your device couldn’t finish the request.';
  return {
    phase: 'failed', title, origin: request.origin, detail,
    // Electron 45 exposes no security-key PIN entry; such keys fail as NotAllowedError.
    note: name === 'NotAllowedError' ? 'Keys that ask for a PIN can’t be used here yet.' : '',
    status: '', primary: { label: 'Try again', choice: 'retry' }, secondary: 'Close', accounts: [],
    announce: title + '. ' + detail,
  };
}

/** Choices come back from the document as strings; accept only known ones. */
export function promptChoice(value: unknown, accounts = 0): PromptChoice {
  if (value === 'continue' || value === 'retry') return value;
  if (typeof value === 'string' && /^account:\d{1,2}$/.test(value)) {
    const index = Number(value.slice('account:'.length));
    if (index < accounts) return `account:${index}`;
  }
  return 'cancel';
}
