export interface FileStatus {
  path: string;
  status: 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked' | 'conflicted';
  staged: boolean;
  oldPath?: string;
}

export interface CommitMessageSuggestion {
  subject: string;
  body: string | null;
  confidence: 'high' | 'medium' | 'low';
  source: 'external' | 'claude' | 'codex' | 'fallback';
}

export interface GitScopeSummary {
  files: number;
  additions: number;
  deletions: number;
}

export interface GitStatusSummary {
  branch: string;
  upstream: string | null;
  ahead: number;
  behind: number;
  hasChanges: boolean;
  files: FileStatus[];
  staged: GitScopeSummary;
  unstaged: GitScopeSummary;
  total: GitScopeSummary;
}

export interface CommitResult {
  hash: string;
  message: string;
  generatedMessage: boolean;
}

export interface PushResult {
  pushed: boolean;
  remote: string | null;
  branch: string;
  upstream: string | null;
  createdUpstream: boolean;
  nonFastForward: boolean;
  rejected: boolean;
  message: string;
}
