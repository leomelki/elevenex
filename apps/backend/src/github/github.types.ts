export interface GitHubCapabilities {
  ghInstalled: boolean;
  authenticated: boolean;
  hasGitHubRemote: boolean;
  hasUpstream: boolean;
  linkedPullRequest: boolean;
  defaultRemote: string | null;
  host: string | null;
  repoOwner: string | null;
  repoName: string | null;
  message: string | null;
}

export interface GitHubBranchContext {
  repoRoot: string;
  worktreePath: string;
  branch: string;
  upstream: string | null;
  ahead: number;
  behind: number;
  remoteName: string | null;
  host: string | null;
  owner: string | null;
  name: string | null;
  linkedPullRequest: LinkedPullRequestSummary | null;
}

export interface LinkedPullRequestSummary {
  number: number;
  title: string;
  url: string;
  state: string;
  isDraft: boolean;
}

export interface PullRequestReviewer {
  login: string;
  name: string | null;
  avatarUrl: string | null;
  state: string | null;
}

export interface PullRequestDetail extends LinkedPullRequestSummary {
  body: string;
  author: {
    login: string;
    name: string | null;
    avatarUrl: string | null;
  } | null;
  baseRefName: string;
  headRefName: string;
  createdAt: string;
  updatedAt: string;
  mergeable: string;
  mergeStateStatus: string;
  commentsCount: number;
  reviewDecision: string | null;
  checksSummary: {
    total: number;
    passing: number;
    failing: number;
    pending: number;
  };
  reviewers: PullRequestReviewer[];
}

export interface PullRequestFileDiff {
  path: string;
  oldPath: string | null;
  status: 'added' | 'removed' | 'modified' | 'renamed';
  additions: number;
  deletions: number;
  patch: string;
  threads: PullRequestReviewThread[];
}

export interface PullRequestReviewThread {
  id: string;
  path: string;
  line: number | null;
  originalLine: number | null;
  isResolved: boolean;
  comments: PullRequestReviewComment[];
}

export interface PullRequestReviewComment {
  id: string;
  authorLogin: string;
  authorAvatarUrl: string | null;
  body: string;
  createdAt: string;
  url: string | null;
}

export interface PullRequestConversation {
  reviews: Array<{
    id: string;
    authorLogin: string;
    authorAvatarUrl: string | null;
    state: string;
    body: string;
    submittedAt: string | null;
  }>;
  comments: Array<{
    id: string;
    authorLogin: string;
    authorAvatarUrl: string | null;
    body: string;
    createdAt: string;
    url: string | null;
  }>;
  threads: PullRequestReviewThread[];
}

export interface PullRequestCheckRollup {
  summary: {
    total: number;
    passing: number;
    failing: number;
    pending: number;
  };
  checks: Array<{
    name: string;
    workflow: string | null;
    state: string;
    bucket: string;
    description: string | null;
    link: string | null;
    startedAt: string | null;
    completedAt: string | null;
  }>;
}
