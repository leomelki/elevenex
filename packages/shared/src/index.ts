/** Serializable contracts only. Node and Electron APIs never enter the renderer. */
export type Theme = 'light' | 'dark';
export type DesktopPlatform = 'darwin' | 'win32' | 'linux';

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
}

export interface EventContracts {
  'theme:changed': Theme;
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
}
