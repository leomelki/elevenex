/** Task-owned browser contracts. Page content never receives this bridge. */
export interface BrowserRect { readonly x: number; readonly y: number; readonly width: number; readonly height: number }
export interface BrowserElement extends BrowserRect { readonly selector: string; readonly tag: string }
export interface TaskBrowserTab {
  readonly id: string;
  readonly title: string;
  readonly url: string;
  readonly by: 'you' | 'agent';
  readonly driver: 'you' | 'agent' | 'needs';
  readonly agentSessionId: number | null;
  readonly generation: number;
  readonly loading: boolean;
  readonly ready: boolean;
  readonly canGoBack: boolean;
  readonly error: string | null;
  readonly errors: number;
  readonly width: 'full' | 'phone';
  readonly theme: 'light' | 'dark' | 'system';
  readonly slowNetwork: boolean;
  readonly waiting: boolean;
  readonly server?: string;
  readonly step?: { readonly n: number; readonly total?: number; readonly text: string };
  readonly target?: BrowserElement;
}
export interface TaskBrowserState {
  readonly scopeId: string;
  readonly taskId: number;
  readonly revision: number;
  readonly surfaceEpoch: number;
  readonly controlsFocus: number;
  readonly active: string | null;
  readonly tabs: readonly TaskBrowserTab[];
  readonly picked: BrowserElement | null;
  readonly picking: boolean;
  readonly pickerMessage: string | null;
  readonly feedback: boolean;
  readonly ports: readonly number[];
  /** Deliberately withheld: arbitrary pages cannot prove complete secret redaction. */
  readonly privacy: 'content-withheld';
}
export type TaskBrowserCommand =
  | { readonly kind: 'open'; readonly url: string }
  | { readonly kind: 'select' | 'close' | 'back' | 'reload' | 'takeover' | 'outside' | 'focus'; readonly tabId: string }
  | { readonly kind: 'handoff'; readonly tabId: string; readonly sessionId: number }
  | { readonly kind: 'navigate'; readonly tabId: string; readonly url: string }
  | { readonly kind: 'width'; readonly tabId: string; readonly width: 'full' | 'phone' }
  | { readonly kind: 'pick'; readonly enabled: boolean }
  | { readonly kind: 'feedback'; readonly enabled: boolean }
  | { readonly kind: 'theme'; readonly tabId: string; readonly theme: 'light' | 'dark' | 'system' }
  | { readonly kind: 'network'; readonly tabId: string; readonly slow: boolean };
export interface TaskBrowserLayout {
  /** Monotonic document-local ordering prevents a late frame reattaching a hidden page. */
  readonly sequence: number;
  readonly surfaceEpoch: number;
  readonly reducedMotion: boolean;
  readonly visible: boolean;
  readonly inputReady: boolean;
  readonly ownerGeneration: number;
  readonly bounds: BrowserRect;
}
export type BrowserAgentCommand =
  | { readonly kind: 'list' }
  | { readonly kind: 'open'; readonly url: string }
  | { readonly kind: 'navigate'; readonly tabId: string; readonly generation: number; readonly url: string }
  | { readonly kind: 'back' | 'reload' | 'needs-user' | 'select' | 'close'; readonly tabId: string; readonly generation: number }
  | { readonly kind: 'click'; readonly tabId: string; readonly generation: number; readonly x: number; readonly y: number; readonly step: string; readonly n?: number; readonly total?: number }
  | { readonly kind: 'scroll'; readonly tabId: string; readonly generation: number; readonly x: number; readonly y: number; readonly atX?: number; readonly atY?: number };
export interface BrowserAgentState {
  readonly active: string | null;
  readonly tabs: readonly { readonly id: string; readonly by: 'you' | 'agent'; readonly agentSessionId: number | null; readonly driver: 'you' | 'agent' | 'needs'; readonly generation: number; readonly loading: boolean; readonly ready: boolean; readonly error: string | null; readonly errors?: number }[];
  readonly observation: 'withheld';
  readonly message: string;
}
