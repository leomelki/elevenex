export interface ViewTab {
  readonly id: string;
  readonly title: string;
  readonly tip?: string;
  readonly icon?: string;
  readonly status?: 'idle' | 'running' | 'serving' | 'failed';
  readonly unread?: boolean;
  readonly agent?: boolean;
  readonly agentDriving?: boolean;
}

export interface BrowserTab extends ViewTab {
  readonly url?: string;
  readonly server?: string;
  readonly by?: 'agent' | 'you';
}

export type BrowserDriver = 'agent' | 'you' | 'needs';
export interface BrowserStep { readonly n: number; readonly total?: number; readonly text: string }
export interface BrowserTarget {
  readonly x: number; readonly y: number; readonly w: number; readonly h: number;
  readonly label: string; readonly file?: string;
}
export interface BrowserQuestion { readonly tabId: string; readonly target: BrowserTarget; readonly text: string }

export interface TerminalTab extends ViewTab {
  readonly cmd?: string;
  readonly port?: number;
  readonly cwd?: string;
  readonly branch?: string;
}
export interface TerminalScript { readonly id: string; readonly name: string; readonly cmd: string }
export interface TerminalLine {
  readonly id: string;
  readonly kind: 'cmd' | 'dim' | 'ok' | 'err' | 'warn' | 'info';
  readonly text: string;
}
export interface TerminalFailure { readonly code: number; readonly cmd: string }
export interface TerminalFailureEvent { readonly tabId: string; readonly failure: TerminalFailure }

export type ChangeStatus = 'M' | 'A' | 'D' | 'R';
export type ReviewMode = 'changes' | 'full';
export interface ChangeFile {
  readonly id: string;
  readonly path: string;
  readonly repository?: string;
  readonly status: ChangeStatus;
  readonly add: number;
  readonly del: number;
  readonly oldPath?: string;
  readonly binary?: boolean;
  readonly viewed?: boolean;
  readonly changedSinceViewed?: boolean;
  readonly rev?: string | number;
}
export interface CodeSpan {
  readonly text: string;
  readonly token?: 'keyword' | 'string' | 'number' | 'function' | 'comment';
  readonly changed?: boolean;
}
export interface DiffLine {
  readonly id: string;
  readonly kind: 'context' | 'add' | 'del';
  readonly oldNumber?: number;
  readonly newNumber?: number;
  readonly text: string;
  readonly spans?: readonly CodeSpan[];
}
export interface DiffHunk {
  readonly id: string;
  readonly heading: string;
  readonly lines: readonly DiffLine[];
  readonly before?: number;
  readonly after?: number;
}
/** Precompute diffs outside the renderer (worker/main); never build an unbounded LCS on the UI thread. */
export interface DiffFileContent {
  readonly fileId: string;
  readonly rev?: string | number;
  readonly mode: ReviewMode;
  readonly state: 'loading' | 'ready' | 'error';
  readonly hunks?: readonly DiffHunk[];
  readonly error?: string;
  /** When a full file was paginated, ask its owner for the next bounded page. */
  readonly remainingLines?: number;
  /** A paged source may know there is another page without its total line count. */
  readonly hasMoreLines?: boolean;
  readonly hasPreviousLines?: boolean;
}
export interface DiffFileRequest {
  readonly fileId: string;
  readonly rev?: string | number;
  readonly mode: ReviewMode;
  readonly reason: 'visible' | 'selected' | 'retry' | 'large' | 'deleted' | 'more' | 'previous';
}
export interface DiffContextRequest {
  readonly fileId: string;
  readonly rev?: string | number;
  readonly mode: ReviewMode;
  readonly hunkId: string;
  readonly direction: 'before' | 'after';
  readonly count: number;
}
export interface DiffComment {
  readonly fileId: string;
  readonly path: string;
  readonly rev?: string | number;
  readonly line: number;
  readonly side: 'old' | 'new';
  readonly text: string;
}

export const CHANGE_STATUS_LABEL: Readonly<Record<ChangeStatus, string>> = {
  M: 'Modified', A: 'Added', D: 'Deleted', R: 'Renamed',
};

export function fileName(path: string): string { return path.split('/').at(-1) ?? path; }
export function folderName(path: string): string { return path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''; }
