export interface BrowserIsolationConfig {
  projectId: number;
  mode: 'shared' | 'isolated';
  sharedGlobs: string[];
}
