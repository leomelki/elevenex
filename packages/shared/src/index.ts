/** Serializable contracts only. Node and Electron APIs never enter the renderer. */
export type Theme = 'light' | 'dark';
export type DesktopPlatform = 'darwin' | 'win32' | 'linux';

/** A snapshot is always available; URLs are usable only while phase is ready. */
export type BackendStatus =
  | { readonly phase: 'idle' | 'checking' | 'extracting' | 'starting' | 'stopping' | 'stopped'; readonly version: string | null }
  | { readonly phase: 'downloading'; readonly version: string; readonly receivedBytes: number; readonly totalBytes: number | null }
  | { readonly phase: 'ready'; readonly version: string; readonly url: string }
  | { readonly phase: 'failed'; readonly version: string | null; readonly message: string };

export interface GitStatus {
  readonly path: string;
  readonly branch: string;
  readonly staged: readonly string[];
  readonly modified: readonly string[];
  readonly untracked: readonly string[];
  readonly mock: true;
}

export interface InvokeContracts {
  'app:version': { args: []; result: string };
  'git:status': { args: [path: string]; result: GitStatus };
  'backend:status': { args: []; result: BackendStatus };
  'backend:retry': { args: []; result: BackendStatus };
  'backend:restart': { args: []; result: BackendStatus };
}

export interface EventContracts {
  'theme:changed': Theme;
  'backend:changed': BackendStatus;
}

export type Invoke = <C extends keyof InvokeContracts>(
  channel: C,
  ...args: InvokeContracts[C]['args']
) => Promise<InvokeContracts[C]['result']>;

export type Subscribe = <C extends keyof EventContracts>(
  channel: C,
  listener: (value: EventContracts[C]) => void,
) => () => void;

/** The entire public preload API; raw IPC and Electron events stay private. */
export interface ElevenexBridge {
  readonly platform: DesktopPlatform;
  appVersion(): Promise<InvokeContracts['app:version']['result']>;
  gitStatus(...args: InvokeContracts['git:status']['args']): Promise<InvokeContracts['git:status']['result']>;
  onThemeChanged(listener: (theme: EventContracts['theme:changed']) => void): () => void;
  backendStatus(): Promise<BackendStatus>;
  retryBackend(): Promise<BackendStatus>;
  restartBackend(): Promise<BackendStatus>;
  onBackendChanged(listener: (status: BackendStatus) => void): () => void;
}
