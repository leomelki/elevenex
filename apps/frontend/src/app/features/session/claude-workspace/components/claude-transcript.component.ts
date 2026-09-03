import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { CommonModule } from '@angular/common';
import type {
  ClaudePermissionApproval,
  ClaudeToolProgress,
  ClaudeTranscriptItem,
} from '@/shared/models/claude-runtime.model';
import type { ReviewChat } from '@/shared/models/review-chat.model';
import type { SessionFork } from '@/shared/models/session.model';
import type { PlanReviewRequest } from '@/features/plan-annotator';
import type { PairedTranscriptUnit } from '../util/paired-transcript';
import type { TranscriptRenderItem } from '../util/transcript-render-items';

type CollapsedTurnRenderItem = Extract<TranscriptRenderItem, { kind: 'collapsed-turn' }>;
import { ClaudeMessageComponent } from './claude-message.component';
import { ClaudeThinkingComponent } from './claude-thinking.component';
import { ClaudeToolCallComponent } from './claude-tool-call.component';
import { ClaudeTurnChangesComponent } from './claude-turn-changes.component';
import { ClaudeTurnSummaryComponent } from './claude-turn-summary.component';
import { ReviewThreadsCardComponent } from './cw-review-threads-card.component';

/**
 * Per-message affordances, resolved by the host.
 *
 * These depend on host state the transcript has no business knowing (provider
 * capabilities, fork drafts, plan reviews), but they are decided *per item*, so
 * they arrive as lookups rather than flat inputs. Surfaces that offer none of
 * this pass {@link READ_ONLY_MESSAGE_AFFORDANCES}.
 */
export interface TranscriptMessageAffordances {
  canCopy(item: ClaudeTranscriptItem): boolean;
  canEdit(item: ClaudeTranscriptItem): boolean;
  canFork(item: ClaudeTranscriptItem): boolean;
  isForking(item: ClaudeTranscriptItem): boolean;
  isEditArmed(item: ClaudeTranscriptItem): boolean;
  forks(item: ClaudeTranscriptItem): SessionFork[];
  forksExpanded(item: ClaudeTranscriptItem): boolean;
  canReviewPlan(item: ClaudeTranscriptItem): boolean;
  planReview(item: ClaudeTranscriptItem): PlanReviewRequest | null;
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
  forks: () => [],
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
    ClaudeMessageComponent,
    ClaudeThinkingComponent,
    ClaudeToolCallComponent,
    ClaudeTurnChangesComponent,
    ClaudeTurnSummaryComponent,
    ReviewThreadsCardComponent,
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
  readonly items = input.required<TranscriptRenderItem[]>();
  readonly worktreePath = input<string | null>(null);
  /** The one item currently receiving deltas, if any. */
  readonly streamingMessageId = input<string | null>(null);
  /** Renders the empty pulsing reply bubble while the first token is awaited. */
  readonly pendingReply = input(false);

  readonly childItemsByParentToolUseId = input<Record<string, ClaudeTranscriptItem[]>>({});
  readonly liveToolUseIds = input<ReadonlySet<string>>(new Set<string>());
  readonly toolProgressByToolUseId = input<Record<string, ClaudeToolProgress>>({});

  readonly expandedTurns = input<Record<string, boolean>>({});
  readonly expandedTurnChanges = input<Record<string, boolean>>({});

  readonly messageAffordances = input<TranscriptMessageAffordances>(
    READ_ONLY_MESSAGE_AFFORDANCES,
  );

  /** Review discussions anchored to a turn, keyed by turn id. Empty when unused. */
  readonly reviewThreadsByTurnId = input<Record<string, readonly ReviewChat[]>>({});
  readonly unreadReviewThreadIds = input<ReadonlySet<number>>(new Set<number>());

  readonly approve = output<ClaudePermissionApproval>();
  readonly deny = output<string | undefined>();

  readonly toggleTurn = output<string>();
  readonly toggleTurnChanges = output<string>();
  readonly closeTurnChanges = output<string>();
  readonly inspectTurn = output<string>();

  readonly messageCopy = output<{ item: ClaudeTranscriptItem; text: string | null }>();
  readonly fork = output<ClaudeTranscriptItem>();
  readonly armEdit = output<ClaudeTranscriptItem>();
  readonly confirmEdit = output<ClaudeTranscriptItem>();
  readonly cancelEdit = output<void>();
  readonly toggleForks = output<ClaudeTranscriptItem>();
  readonly openFork = output<SessionFork>();
  readonly openPlanReview = output<PlanReviewRequest>();
  readonly openPlanChat = output<PlanReviewRequest>();

  /** Emitted for the turn-changes panel and the anchored discussion cards. */
  readonly openReview = output<{ path?: string; thread?: number }>();

  trackItem(_index: number, item: TranscriptRenderItem): string {
    return item.id;
  }

  /**
   * `ng-template` context values reach the template untyped. Casting once
   * through `@let` restores full type-checking inside the unit template.
   */
  asUnit(value: unknown): PairedTranscriptUnit {
    return value as PairedTranscriptUnit;
  }

  asTurn(value: unknown): CollapsedTurnRenderItem | null {
    return (value as CollapsedTurnRenderItem | null) ?? null;
  }

  isStreaming(itemId: string): boolean {
    return this.streamingMessageId() === itemId;
  }

  isTurnExpanded(turnId: string): boolean {
    return !!this.expandedTurns()[turnId];
  }

  isTurnChangesExpanded(turnId: string): boolean {
    return !!this.expandedTurnChanges()[turnId];
  }

  childItemsFor(toolUseId: string): ClaudeTranscriptItem[] {
    return this.childItemsByParentToolUseId()[toolUseId] ?? [];
  }

  isLiveToolUse(toolUseId: string): boolean {
    return this.liveToolUseIds().has(toolUseId);
  }

  progressFor(toolUseId: string): ClaudeToolProgress | null {
    return this.toolProgressByToolUseId()[toolUseId] ?? null;
  }

  reviewThreadsFor(turnId: string): readonly ReviewChat[] {
    return this.reviewThreadsByTurnId()[turnId] ?? [];
  }
}
