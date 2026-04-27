export type WorktreeContextGenerationStatus = 'idle' | 'generating' | 'ready' | 'failed';

export interface WorktreeContextSnapshot {
  repoId: number;
  worktreePath: string;
  contextSentence: string | null;
  rootRef: string | null;
  generationStatus: WorktreeContextGenerationStatus;
  generatedAt: string | null;
  lastUsedAt: string | null;
  canGenerate: boolean;
  hasChanges: boolean;
  usingRepoDefaultRootRef: boolean;
  errorMessage: string | null;
  hasRecord: boolean;
}

export interface ConsumeWorktreeContextResult {
  shouldInject: boolean;
  contextSentence: string | null;
}
