export interface FileRead { readonly generation: string; readonly content: string; readonly revision: string }
export interface DirectoryPage { readonly generation: string; readonly entries: readonly { readonly name: string; readonly type: number }[]; readonly next: string | null }
export interface SearchPage {
  readonly id: string;
  readonly rows: readonly { readonly path: string; readonly line: number; readonly start: number; readonly end: number; readonly text: string }[];
  readonly done: boolean;
  readonly limited: boolean;
  readonly error?: string;
}
export interface Changes {
  readonly generation?: string;
  readonly paused?: boolean;
  readonly sequence: number;
  readonly reset: boolean;
  readonly paths: readonly string[];

}

export interface TransferState {
  readonly id: string;
  phase: 'running' | 'complete' | 'cancelled' | 'failed';
  files: number;
  skipped: number;
  bytes: number;
  size: number;
  name: string;
  message?: string;
}
