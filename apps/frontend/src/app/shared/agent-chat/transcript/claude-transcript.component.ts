import { ClaudeToolCallComponent } from '@/shared/agent-chat/tools/claude-tool-call.component';
import { ToolDenialComponent } from '@/shared/agent-chat/tools/tool-denial.component';
import { ClaudeMessageComponent } from '@/shared/agent-chat/transcript/claude-message.component';
import { ClaudeThinkingComponent } from '@/shared/agent-chat/transcript/claude-thinking.component';
import { ClaudeTurnChangesComponent } from '@/shared/agent-chat/transcript/claude-turn-changes.component';
import { ClaudeTurnSummaryComponent } from '@/shared/agent-chat/transcript/claude-turn-summary.component';
import { ReviewThreadsCardComponent } from '@/shared/agent-chat/transcript/review-threads-card.component';
import type { TranscriptRenderItem } from '@/shared/agent-chat/transcript/transcript-render-items';
import type {
  AgentPermissionApproval,
  AgentToolProgress,
  AgentTranscriptItem,
} from '@/shared/models/agent-runtime.model';
import type { LocalFileTarget } from '@/shared/models/local-file-target.model';
import type { PlanReviewRequest } from '@/shared/models/plan-review.model';
import type { ReviewChat } from '@/shared/models/review-chat.model';
import type { SessionFork } from '@/shared/models/session.model';
import { parseTaskNotifications } from '@/shared/utils/task-notification';
import { CommonModule } from '@angular/common';
import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { TranscriptUnitTemplateDirective } from './transcript-unit-template.directive';
import {
  EMPTY_TRANSCRIPT_TOOLS,
  EMPTY_TURN_EXPANSION,
  EMPTY_TURN_REVIEWS,
  type TranscriptToolState,
  type TranscriptTurnExpansion,
  type TranscriptTurnReviews,
} from './transcript-view-state';

const EMPTY_FORKS: readonly SessionFork[] = [];
const EMPTY_CHILD_ITEMS: readonly AgentTranscriptItem[] = [];
const EMPTY_REVIEW_THREADS: readonly ReviewChat[] = [];

/**
 * Per-message affordances, resolved by the host.
 *
 * These depend on host state the transcript has no business knowing (provider
 * capabilities, fork drafts, plan reviews), but they are decided *per item*, so
 * they arrive as lookups rather than flat inputs. Surfaces that offer none of
 * this pass {@link READ_ONLY_MESSAGE_AFFORDANCES}.
 */
export interface TranscriptMessageAffordances {
  canCopy(item: AgentTranscriptItem): boolean;
  canEdit(item: AgentTranscriptItem): boolean;
  canFork(item: AgentTranscriptItem): boolean;
  isForking(item: AgentTranscriptItem): boolean;
  isEditArmed(item: AgentTranscriptItem): boolean;
  forks(item: AgentTranscriptItem): readonly SessionFork[];
  forksExpanded(item: AgentTranscriptItem): boolean;
  canReviewPlan(item: AgentTranscriptItem): boolean;
  planReview(item: AgentTranscriptItem): PlanReviewRequest | null;
  actionsDisabled(): boolean;
  forkDisabled(): boolean;
  forkDisabledReason(): string;
}

/** Copy only — everything else needs a full session behind it. */
export const READ_ONLY_MESSAGE_AFFORDANCES: TranscriptMessageAffordances = {
  canCopy: (item) =>
    (item.kind === 'user' || item.kind === 'assistant') && Boolean(item.content?.trim()),
  canEdit: () => false,
  canFork: () => false,
  isForking: () => false,
  isEditArmed: () => false,
  forks: () => EMPTY_FORKS,
  forksExpanded: () => false,
  canReviewPlan: () => false,
  planReview: () => null,
  actionsDisabled: () => false,
  forkDisabled: () => false,
  forkDisabledReason: () => '',
};

/**
 * The agent conversation, rendered.
 *
 * The single owner of how a transcript looks: messages, thinking, tool calls,
 * and the collapsed "Worked for X" turns that hide a turn's tool work. Every
 * surface showing an agent conversation renders through this — the session
 * workspace and the embedded review/fork chats — so none of them can drift.
 *
 * It is deliberately stateless: expansion state and every action live with the
 * host, which owns the socket and knows what a click should do.
 */
@Component({
  selector: 'cw-transcript',
  standalone: true,
  imports: [
    CommonModule,
    TranscriptUnitTemplateDirective,
    ClaudeMessageComponent,
    ClaudeThinkingComponent,
    ClaudeToolCallComponent,
    ClaudeTurnChangesComponent,
    ClaudeTurnSummaryComponent,
    ReviewThreadsCardComponent,
    ToolDenialComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './claude-transcript.component.html',
  styles: [
    `
      :host {
        display: flex;
        width: 100%;
        max-width: 52rem;
        flex-direction: column;
        gap: 0.875rem;
        margin: 0 auto;
      }
    `,
  ],
})
export class ClaudeTranscriptComponent {
  readonly items = input.required<readonly TranscriptRenderItem[]>();
  readonly worktreePath = input<string | null>(null);
  /** The one item currently receiving deltas, if any. */
  readonly streamingMessageId = input<string | null>(null);
  /** Renders the empty pulsing reply bubble while the first token is awaited. */
  readonly pendingReply = input(false);

  readonly toolState = input<TranscriptToolState>(EMPTY_TRANSCRIPT_TOOLS);
  readonly turnExpansion = input<TranscriptTurnExpansion>(EMPTY_TURN_EXPANSION);
  readonly canInspectAgents = input(false);
  readonly canReviewChanges = input(false);

  readonly messageAffordances = input<TranscriptMessageAffordances>(READ_ONLY_MESSAGE_AFFORDANCES);

  /** Review discussions anchored to a turn, keyed by turn id. Empty when unused. */
  readonly turnReviews = input<TranscriptTurnReviews>(EMPTY_TURN_REVIEWS);

  readonly approve = output<AgentPermissionApproval>();
  readonly deny = output<string | undefined>();

  readonly toggleTurn = output<string>();
  readonly toggleTurnChanges = output<string>();
  readonly closeTurnChanges = output<string>();
  readonly inspectTurn = output<string>();

  readonly messageCopy = output<{ item: AgentTranscriptItem; text: string | null }>();
  readonly fork = output<AgentTranscriptItem>();
  readonly armEdit = output<AgentTranscriptItem>();
  readonly confirmEdit = output<AgentTranscriptItem>();
  readonly cancelEdit = output<void>();
  readonly toggleForks = output<AgentTranscriptItem>();
  readonly openFork = output<SessionFork>();
  readonly openPlanReview = output<PlanReviewRequest>();
  readonly openPlanChat = output<PlanReviewRequest>();
  readonly openLocalFile = output<LocalFileTarget>();

  /** Emitted for the turn-changes panel and the anchored discussion cards. */
  readonly openReview = output<{ path?: string; thread?: number }>();

  isStreaming(itemId: string): boolean {
    return this.streamingMessageId() === itemId;
  }

  userPromptId(item: AgentTranscriptItem): string | null {
    if (item.kind !== 'user' || item.isSynthetic || item.parentToolUseId) return null;
    return parseTaskNotifications(item.content).text.trim() ? item.id : null;
  }

  isTurnExpanded(turnId: string): boolean {
    return !!this.turnExpansion().turns[turnId];
  }

  isTurnChangesExpanded(turnId: string): boolean {
    return !!this.turnExpansion().changes[turnId];
  }

  childItemsFor(toolUseId: string): readonly AgentTranscriptItem[] {
    return this.toolState().children[toolUseId] ?? EMPTY_CHILD_ITEMS;
  }

  isLiveToolUse(toolUseId: string): boolean {
    return this.toolState().liveIds.has(toolUseId);
  }

  progressFor(toolUseId: string): AgentToolProgress | null {
    return this.toolState().progress[toolUseId] ?? null;
  }

  reviewThreadsFor(turnId: string): readonly ReviewChat[] {
    return this.turnReviews().threads[turnId] ?? EMPTY_REVIEW_THREADS;
  }
}
