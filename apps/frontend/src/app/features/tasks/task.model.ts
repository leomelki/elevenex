import { Session } from '@/shared/models/session.model';

export interface TaskSetup {
  requestId: string;
  name?: string;
  mode: 'new' | 'existing';
  branchName: string;
  baseRef?: string;
  checkoutMode?: 'branch' | 'snapshot';
  environment?: 'automatic' | 'new' | 'existing';
  worktreeId?: number;
  confirmOverLimit?: boolean;
  confirmExternal?: boolean;
  useSavedRef?: boolean;
}

export interface Task {
  id: number;
  repoId: number;
  name: string;
  path: string;
  taskState: 'preparing' | 'ready' | 'failed' | 'finishing';
  taskBranch: string | null;
  sourceRef: string | null;
  startingCommit: string | null;
  finalCommit: string | null;
  archivedAt: string | null;
  linkStatus: 'linked' | 'unlinked';
  checkoutMode: 'branch' | 'snapshot';
  taskConfig: string | null;
  taskDraft: string;
  preparationStage?: 'refreshing_ref' | 'preparing_checkout' | 'restoring_sessions' | null;
  error: {
    code?: string;
    message?: string;
    existingTaskId?: number;
    localBranch?: string;
    savedCommit?: string;
    canSnapshot?: boolean;
  } | null;
  sessions: Session[];
}

export function taskSlug(name: string): string {
  return (
    name
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 100)
      .replace(/-+$/g, '') || 'task'
  );
}

export function taskError(error: unknown): string {
  const response = error as { error?: { message?: string | string[] }; message?: string };
  const message = response?.error?.message;
  return Array.isArray(message)
    ? message.join('. ')
    : message || response?.message || 'Something went wrong. Try again.';
}
