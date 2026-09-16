/** A worktree-relative file location that can be opened in the embedded editor. */
export interface LocalFileTarget {
  path: string;
  line?: number;
  column?: number;
}
