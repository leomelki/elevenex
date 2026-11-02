import type { SessionChatAction } from './session-chat';
import type { WorkspaceCreateTask } from './workspace';

export type WaitingWritingStatus = 'waiting' | 'sending' | 'unknown' | 'failed';
export interface SavedWaitingChat {
  readonly id: string;
  readonly taskId: number;
  readonly sessionId: number;
  readonly action: Extract<SessionChatAction, { readonly type: 'send' | 'stop' | 'answer' | 'permission' }>;
  readonly label: string;
  readonly turnId: string | null;
  readonly status: WaitingWritingStatus;
  readonly error?: string;
}
export interface SavedWaitingTask {
  readonly id: string;
  readonly projectId: number;
  readonly input: WorkspaceCreateTask & { readonly branchName: string; readonly mode: 'new' | 'existing' };
  readonly planned: boolean;
  readonly status: WaitingWritingStatus;
  readonly error?: string;
}
export interface SavedWaitingSession {
  readonly id: string;
  readonly taskId: number;
  readonly taskName: string;
  readonly status: WaitingWritingStatus;
  readonly error?: string;
}
/** Main-owned per-window/configured-machine journal. No opaque backend scope IDs or credentials. */
export interface WaitingWriting {
  readonly chat: readonly SavedWaitingChat[];
  readonly tasks: readonly SavedWaitingTask[];
  readonly sessions?: readonly SavedWaitingSession[];
}
export interface WaitingWritingSnapshot extends WaitingWriting {
  /** Reject writes retained across a change to the configured SSH destination. */
  readonly identity: string;
}
