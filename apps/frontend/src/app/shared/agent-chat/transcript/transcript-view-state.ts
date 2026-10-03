import type { AgentToolProgress, AgentTranscriptItem } from '@/shared/models/agent-runtime.model';
import type { ReviewChat } from '@/shared/models/review-chat.model';
import type { AgentConversation } from '../agent-conversation';

export interface TranscriptToolState {
  readonly children: Readonly<Record<string, readonly AgentTranscriptItem[]>>;
  readonly liveIds: ReadonlySet<string>;
  readonly progress: Readonly<Record<string, AgentToolProgress>>;
}

export interface TranscriptTurnExpansion {
  readonly turns: Readonly<Record<string, boolean>>;
  readonly changes: Readonly<Record<string, boolean>>;
}

export interface TranscriptTurnReviews {
  readonly threads: Readonly<Record<string, readonly ReviewChat[]>>;
  readonly unreadIds: ReadonlySet<number>;
}

export const EMPTY_TRANSCRIPT_TOOLS: TranscriptToolState = {
  children: {},
  liveIds: new Set(),
  progress: {},
};
export const EMPTY_TURN_EXPANSION: TranscriptTurnExpansion = { turns: {}, changes: {} };
export const EMPTY_TURN_REVIEWS: TranscriptTurnReviews = { threads: {}, unreadIds: new Set() };

/** Stable projection shared by the session, review, and plan conversation hosts. */
export function transcriptToolState(conversation: AgentConversation | null): TranscriptToolState {
  if (!conversation) return EMPTY_TRANSCRIPT_TOOLS;
  return {
    children: conversation.childItemsByParentToolUseId(),
    liveIds: conversation.liveToolUseIds(),
    progress: conversation.toolProgressByToolUseId(),
  };
}
