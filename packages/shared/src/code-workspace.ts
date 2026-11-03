import type { EnvironmentSelection } from './remote';
/** Task-owned native workbench controls. No URLs, credentials or absolute paths. */
export interface CodeTarget {
  readonly scopeId: string;
  readonly taskId: number;
}
export interface CodeBounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}
/** Fixed editor intents, never arbitrary VS Code command IDs. */
export type CodeAction = 'find-file' | 'search-text' | 'save';
export interface CodeOpenFile {
  readonly path: string;
  readonly line?: number;
  readonly column?: number;
}
export interface CodeSurfaceState {
  readonly taskId: number;
  readonly identity: string;
  readonly phase: 'loading' | 'ready' | 'disconnected' | 'failed';
  readonly message: string;
  readonly detached?: boolean;
  readonly relocated?: boolean;
  readonly taskName?: string;
  readonly branch?: string;
  readonly recovery?: boolean;
  readonly recoveryAvailable?: boolean;
}

export interface CodeFileIntent extends CodeTarget { readonly file: CodeOpenFile }

export interface CodeWindowContext { readonly target: CodeTarget; readonly state: CodeSurfaceState; readonly selection: EnvironmentSelection; readonly machineName: string }
