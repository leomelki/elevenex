import type { AgentProviderId } from './agent-runtime.model';
import type { DiffSelectionMention } from './diff-selection-mention.model';
import type { SessionInTree } from './session.model';

export type ReviewChatMode = 'readonly' | 'write';
export type ReviewChatStatus = 'open' | 'resolved' | 'promoted';

/**
 * A code anchor is a `DiffSelectionMention` round-tripped through the backend,
 * so the panel's existing selection machinery produces them unchanged.
 */
export type ReviewAnchor = DiffSelectionMention;

export interface ReviewChat {
  id: number;
  parentSessionId: number;
  childSessionId: number;
  provider: AgentProviderId;
  title: string;
  mode: ReviewChatMode;
  status: ReviewChatStatus;
  scope: string;
  filePath: string | null;
  anchors: ReviewAnchor[];
  changeHash: string | null;
  fingerprint: string | null;
  anchorMessageId: string;
  anchorMessageKind: string;
  turnKey: string | null;
  promotedForkId: number | null;
  lastReadAt: string | null;
  createdAt: string;
  updatedAt: string;
  childSession?: SessionInTree | null;
}

export interface CreateReviewChatRequest {
  anchors: ReviewAnchor[];
  title?: string;
  scope?: string;
  anchorMessageId?: string;
  anchorMessageKind?: string;
  turnKey?: string;
}

export interface CreateReviewChatResponse {
  reviewChat: ReviewChat;
  session: SessionInTree;
}

export interface UpdateReviewChatRequest {
  title?: string;
  mode?: ReviewChatMode;
  status?: ReviewChatStatus;
  markRead?: boolean;
}

/**
 * How an anchor lines up with the code as it stands now.
 *
 * `drifted` is deliberately surfaced rather than silently re-anchored: pointing
 * a discussion at the wrong lines is worse than admitting the code moved.
 */
export type ReviewAnchorState = 'exact' | 'moved' | 'drifted';
