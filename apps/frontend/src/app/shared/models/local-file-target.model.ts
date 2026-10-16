/** A file location on the backend host that can be opened in VS Code Web. */
export interface LocalFileTarget {
  path: string;
  line?: number;
  column?: number;
  /** Override the file's directory for links outside the current checkout. */
  rootPath?: string;
}
