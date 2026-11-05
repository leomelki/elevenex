/** Task-owned browser contracts. Page content never receives this bridge. */
export interface BrowserRect { readonly x: number; readonly y: number; readonly width: number; readonly height: number }
export interface BrowserElement extends BrowserRect { readonly selector: string; readonly tag: string }
/** Engine placement and task-server routing, independent of embedded/stream display. */
export type TaskBrowserPlacement = 'desktop' | 'desktop-proxy' | 'machine';
export interface TaskBrowserCapabilities {
  readonly embedded: boolean;
  readonly audio: boolean;
  readonly accessibility: boolean;
  readonly filePicker: boolean;
  readonly downloads: boolean;
}
/** Trusted presentation descriptors. Never supplied to a website or agent tool. */
export interface TaskBrowserSurface {
  readonly scopeId: string;
  readonly taskId: number;
  readonly tabId: string;
  readonly partition: string;
  readonly bootstrap: string;
  /** Native guest identity, absent for a machine stream. Legacy fields remain for older renderers. */
  readonly guest?: { readonly partition: string; readonly bootstrap: string };
  readonly bounds: BrowserRect;
  readonly viewport?: { readonly width: number; readonly height: number };
  readonly zoom: number;
  readonly visible: boolean;
  readonly generation: number;
  readonly interactive: boolean;
  readonly driver: 'you' | 'agent' | 'needs';
  readonly presentation: 'embedded' | 'stream';
}
export interface TaskBrowserFrame {
  readonly scopeId: string;
  readonly taskId: number;
  readonly tabId: string;
  readonly streamId: string;
  readonly sequence: number;
  readonly width: number;
  readonly height: number;
  readonly jpeg: Uint8Array;
  /** Negotiated Annex B access unit. JPEG is empty for video packets. */
  readonly video?: { readonly epoch: string; readonly codec: 'avc1.42E02A'; readonly key: boolean; readonly timestamp: number; readonly data: Uint8Array };
}
export type TaskBrowserStreamEvent =
  | { readonly kind: 'pointer'; readonly type: 'down' | 'up' | 'move'; readonly x: number; readonly y: number; readonly button: 'left' | 'middle' | 'right' | 'none'; readonly buttons: number; readonly clicks: number; readonly modifiers: number }
  | { readonly kind: 'wheel'; readonly x: number; readonly y: number; readonly deltaX: number; readonly deltaY: number; readonly modifiers: number }
  | { readonly kind: 'key'; readonly type: 'down' | 'up'; readonly key: string; readonly code: string; readonly keyCode: number; readonly modifiers: number }
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'composition'; readonly text: string; readonly selectionStart: number; readonly selectionEnd: number }
  | { readonly kind: 'edit'; readonly operation: 'undo' | 'redo' }
  | { readonly kind: 'clipboard'; readonly operation: 'copy' | 'cut' | 'paste' | 'selectAll' };
/** Human-only ordered input. No nesting; clipboard operations travel separately. */
export type TaskBrowserStreamInput = TaskBrowserStreamEvent | { readonly kind: 'batch'; readonly events: readonly TaskBrowserStreamEvent[] };
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
  /** Omitted by older runtimes that do not support forward navigation. */
  readonly canGoForward?: boolean;
  readonly error: string | null;
  readonly errors: number;
  readonly width: 'full' | 'phone';
  readonly theme: 'light' | 'dark' | 'system';
  readonly slowNetwork: boolean;
  readonly waiting: boolean;
  readonly detached?: boolean;
  readonly server?: string;
  readonly step?: { readonly n: number; readonly total?: number; readonly text: string };
  readonly target?: BrowserElement;
}
export interface TaskBrowserState {
  /** Independent panel/tab ordering; omitted by older machine hosts. */
  readonly layoutLanes?: true;
  readonly placement?: TaskBrowserPlacement;
  /** Main-issued location choices; older desktops omit this field. */
  readonly availablePlacements?: readonly TaskBrowserPlacement[];
  readonly capabilities?: TaskBrowserCapabilities;
  /** Older remote runtimes omit this capability. */
  readonly canDetach?: boolean;
  /** Private persistent stream protocol; omitted by older runtime hosts. */
  readonly streamVersion?: 1;
  /** Optional push video; older clients continue to request JPEG frames. */
  readonly videoStream?: 'h264';
  /** Negotiated maximum video delivery window; older hosts use three. */
  readonly videoWindow?: 8;
  /** Human tab ordering; absent on older machine hosts. */
  readonly canReorder?: boolean;
  readonly scopeId: string;
  readonly taskId: number;
  readonly revision: number;
  readonly surfaceEpoch: number;
  readonly controlsFocus: number;
  readonly attention?: { readonly kind: 'popup' | 'dialog' | 'file-picker' | 'download'; readonly message: string; readonly outside: boolean; readonly tabId?: string };
  readonly connection?: { readonly phase: 'idle' | 'connecting' | 'ready' | 'blocked'; readonly message?: string };
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
  | { readonly kind: 'dismiss-attention' }
  | { readonly kind: 'new-tab' }
  | { readonly kind: 'open'; readonly url: string }
  /** Move an existing tab before another, or to the end. Never replaces the tab set. */
  | { readonly kind: 'move-tab'; readonly tabId: string; readonly beforeTabId: string | null }
  | { readonly kind: 'select' | 'close' | 'back' | 'forward' | 'reload' | 'takeover' | 'outside' | 'focus'; readonly tabId: string }
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
  readonly viewport?: { readonly width: number; readonly height: number };
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

/** Labels are presentation data, never authority to access a task or machine. */
export interface TaskBrowserWindowContext {
  readonly projectName: string;
  readonly taskName: string;
  readonly branchName: string;
  readonly machineName: string;
  readonly stage: 'planned' | 'active' | 'waiting' | 'closed';
  readonly hue: 'ocean' | 'pine' | 'plum' | 'rust' | 'steel' | 'rose';
}
export interface TaskBrowserWindowInfo {
  readonly scopeId: string;
  readonly taskId: number;
  readonly tabId: string;
  readonly context: TaskBrowserWindowContext;
  readonly available: boolean;
}
