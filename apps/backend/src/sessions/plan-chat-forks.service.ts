import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  forwardRef,
} from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { and, asc, eq, type SQL } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDB } from '../database/database.provider.js';
import * as schema from '../database/schema/index.js';
import { AgentRuntimeRegistryService } from '../agent-runtime/agent-runtime-registry.service.js';
import type {
  AgentForkConversationResult,
  AgentProviderId,
} from '../agent-runtime/agent-runtime.types.js';
import { SessionsService, type SessionSurface } from './sessions.service.js';
import type { ClaudeTranscriptItem } from '../claude-runtime/claude-runtime.types.js';

type PlanChatForkRow = typeof schema.planChatForks.$inferSelect;
type PlanChatAnchorKind = 'user' | 'assistant';
type SessionWithContext = Awaited<ReturnType<SessionsService['findOne']>>;

export interface EnsurePlanChatForkDto {
  reviewId?: string;
  reviewSource?: string;
  anchorMessageId?: string;
  anchorMessageKind?: string;
  permissionRequestId?: string;
  toolUseId?: string;
  planMarkdown?: string;
  name?: string;
}

export interface SubmitPlanChatQuestionDto {
  question?: string;
}

export interface AskPlanChatForkDto {
  question: string;
  /** Surface for the hidden child fork. Defaults to `agent_query`. */
  surface?: SessionSurface;
  /** Max time to wait for an answer before returning a `running` handle. */
  timeoutMs?: number;
  /** Cancellation signal (e.g. the MCP request abort). */
  signal?: AbortSignal;
}

export interface AskPlanChatForkResult {
  forkId: number;
  childSessionId: number;
  answer: string | null;
  running: boolean;
}

const DEFAULT_ASK_TIMEOUT_MS = 30_000;

@Injectable()
export class PlanChatForksService {
  private readonly logger = new Logger(PlanChatForksService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    @Inject(forwardRef(() => SessionsService))
    private readonly sessionsService: SessionsService,
    private readonly moduleRef: ModuleRef,
  ) {}

  async findByParent(parentSessionId: number, reviewId?: string) {
    await this.sessionsService.findOne(parentSessionId);

    const predicates: SQL[] = [
      eq(schema.planChatForks.parentSessionId, parentSessionId),
    ];
    const normalizedReviewId = reviewId?.trim();
    if (normalizedReviewId) {
      predicates.push(eq(schema.planChatForks.reviewId, normalizedReviewId));
    }

    const rows = await this.db
      .select()
      .from(schema.planChatForks)
      .where(and(...predicates))
      .orderBy(asc(schema.planChatForks.createdAt));

    return Promise.all(
      rows.map(async (row) => ({
        ...this.toPlanChatDto(row),
        childSession: await this.sessionsService
          .findOne(row.childSessionId)
          .catch(() => null),
      })),
    );
  }

  async ensure(parentSessionId: number, dto: EnsurePlanChatForkDto) {
    const parent = await this.sessionsService.findOne(parentSessionId);
    if (parent.status === 'archived') {
      throw new BadRequestException('Archived sessions are read-only.');
    }

    const provider = this.normalizeProvider(parent.activeAgentProvider);
    const reviewId = dto.reviewId?.trim();
    const anchorMessageId = dto.anchorMessageId?.trim();
    const anchorMessageKind = dto.anchorMessageKind
      ? this.parseAnchorKind(dto.anchorMessageKind)
      : null;
    const permissionRequestId = dto.permissionRequestId?.trim();
    const toolUseId = dto.toolUseId?.trim();
    const canUseUnanchoredPlan =
      dto.reviewSource === 'exit-plan-permission' ||
      reviewId?.startsWith('exit-plan:') ||
      reviewId?.startsWith('exit-plan-history:');

    if (!reviewId) {
      throw new BadRequestException('A plan review id is required.');
    }
    if (!anchorMessageId && !canUseUnanchoredPlan) {
      throw new BadRequestException(
        'A plan chat anchor message id is required.',
      );
    }
    if (!anchorMessageId && (!permissionRequestId || !toolUseId)) {
      throw new BadRequestException(
        'A pending plan chat fork requires the permission request and tool use ids.',
      );
    }
    if (anchorMessageId && !anchorMessageKind) {
      throw new BadRequestException(
        'Plan chat anchor kind must be "user" or "assistant".',
      );
    }

    const existing = await this.findExisting(parentSessionId, reviewId);
    if (existing) {
      const childSession = await this.sessionsService
        .findOne(existing.childSessionId)
        .catch(() => null);
      if (childSession) {
        return {
          planChat: {
            ...this.toPlanChatDto(existing),
            childSession,
          },
          session: childSession,
        };
      }
      await this.deleteRow(existing.id);
    }

    const registry = this.moduleRef.get(AgentRuntimeRegistryService, {
      strict: false,
    });
    const childName = dto.name?.trim() || this.defaultPlanChatName(parent.name);
    let child: { id: number } | null = null;

    try {
      child = await this.sessionsService.create({
        repoId: parent.repoId,
        workspaceId: parent.workspaceId ?? undefined,
        branchName: parent.branchName,
        worktreePath: parent.worktreePath,
        name: childName,
        surface: 'embedded_plan_chat',
        activeAgentProvider: provider,
      });

      const providerResult = await registry
        .getProviderFeature(provider, 'forkConversation')
        .forkConversation({
          parentSessionId,
          childSessionId: child.id,
          ...(anchorMessageId && anchorMessageKind
            ? { anchorMessageId, anchorMessageKind }
            : {
                anchorToolUseId: toolUseId,
                activePermissionRequestId: permissionRequestId,
              }),
          childSessionName: childName,
        });

      const updatedChild = await this.applyProviderResult(
        child.id,
        provider,
        providerResult,
      );
      await this.ensurePlanMode(registry, provider, updatedChild.id);

      const rows = await this.db
        .insert(schema.planChatForks)
        .values({
          parentSessionId,
          childSessionId: updatedChild.id,
          provider,
          reviewId,
          anchorMessageId: anchorMessageId ?? `plan-review:${reviewId}`,
          anchorMessageKind: anchorMessageKind ?? 'assistant',
          anchorExcerpt: this.truncateNullable(
            providerResult.anchorExcerpt ?? null,
            500,
          ),
          planExcerpt: this.truncateNullable(dto.planMarkdown ?? null, 4_000),
        })
        .returning();

      return {
        planChat: {
          ...this.toPlanChatDto(rows[0]),
          childSession: updatedChild,
        },
        session: updatedChild,
      };
    } catch (error) {
      if (child) {
        await this.sessionsService.delete(child.id).catch((cleanupError) => {
          this.logger.warn(
            `Failed to clean up plan chat child session ${child?.id}: ${String(cleanupError)}`,
          );
        });
      }
      throw error;
    }
  }

  async submitQuestion(
    parentSessionId: number,
    planChatId: number,
    dto: SubmitPlanChatQuestionDto,
  ) {
    const row = await this.findById(parentSessionId, planChatId);
    const childSession = await this.sessionsService.findOne(row.childSessionId);
    if (childSession.status === 'archived') {
      throw new BadRequestException('Archived plan chats are read-only.');
    }

    const question = dto.question?.trim();
    if (!question) {
      throw new BadRequestException('A question is required.');
    }
    if (question.length > 8_000) {
      throw new BadRequestException('Question is too long.');
    }

    const registry = this.moduleRef.get(AgentRuntimeRegistryService, {
      strict: false,
    });
    const provider = this.normalizeProvider(row.provider);
    await this.ensurePlanMode(registry, provider, row.childSessionId);
    void registry
      .getProvider(provider)
      .submitPrompt(
        row.childSessionId,
        this.buildGuardedQuestionPrompt(question, row.planExcerpt),
        question,
      )
      .catch((error) => {
        this.logger.error(
          `Plan chat question failed session=${row.childSessionId}: ${String(error)}`,
        );
      });

    return {
      planChat: {
        ...this.toPlanChatDto(row),
        childSession,
      },
      session: childSession,
      question,
    };
  }

  /**
   * Fork the parent at its current conversation head onto a hidden surface
   * (default `agent_query`), submit a question, and wait — event-driven, bounded
   * by `timeoutMs` and cancellable via `signal` — for the fork to go idle and
   * produce an answer. Reuses the same fork/submit machinery as the plan chat.
   * Returns the trimmed answer when ready, or `{ answer: null, running: true }`
   * with the fork handle so the caller can poll later.
   */
  async ask(
    parentSessionId: number,
    dto: AskPlanChatForkDto,
  ): Promise<AskPlanChatForkResult> {
    const parent = await this.sessionsService.findOne(parentSessionId);
    if (parent.status === 'archived') {
      throw new BadRequestException('Archived sessions are read-only.');
    }

    const question = dto.question?.trim();
    if (!question) {
      throw new BadRequestException('A question is required.');
    }
    if (question.length > 8_000) {
      throw new BadRequestException('Question is too long.');
    }

    const provider = this.normalizeProvider(parent.activeAgentProvider);
    const surface = dto.surface ?? 'agent_query';
    const registry = this.moduleRef.get(AgentRuntimeRegistryService, {
      strict: false,
    });

    // Parent-idle guard: a fork copies the parent's conversation head, so the
    // parent must not be mid-run or the fork would race an in-flight turn.
    if (await this.isRuntimeRunning(registry, provider, parentSessionId)) {
      throw new BadRequestException(
        'The session is busy producing a response; ask again once it is idle.',
      );
    }

    const anchor = await this.resolveParentAnchor(
      registry,
      provider,
      parentSessionId,
    );

    const childName = this.defaultAskName(parent.name);
    let child: { id: number } | null = null;

    try {
      child = await this.sessionsService.create({
        repoId: parent.repoId,
        workspaceId: parent.workspaceId ?? undefined,
        branchName: parent.branchName,
        worktreePath: parent.worktreePath,
        name: childName,
        surface,
        activeAgentProvider: provider,
      });

      const providerResult = await registry
        .getProviderFeature(provider, 'forkConversation')
        .forkConversation({
          parentSessionId,
          childSessionId: child.id,
          anchorMessageId: anchor.id,
          anchorMessageKind: anchor.kind,
          childSessionName: childName,
        });

      const updatedChild = await this.applyProviderResult(
        child.id,
        provider,
        providerResult,
      );
      await this.ensurePlanMode(registry, provider, updatedChild.id);

      await registry
        .getProvider(provider)
        .submitPrompt(
          updatedChild.id,
          this.buildGuardedQuestionPrompt(question, null),
          question,
        );

      const answer = await this.waitForAnswer(
        registry,
        provider,
        updatedChild.id,
        dto.timeoutMs ?? DEFAULT_ASK_TIMEOUT_MS,
        dto.signal,
      );

      return {
        forkId: updatedChild.id,
        childSessionId: updatedChild.id,
        answer,
        running: answer === null,
      };
    } catch (error) {
      // A setup/submit failure leaves a useless child — clean it up. A timeout
      // does NOT throw (waitForAnswer returns null), so a still-producing fork
      // is intentionally kept alive for the caller to poll later.
      if (child) {
        await this.sessionsService.delete(child.id).catch((cleanupError) => {
          this.logger.warn(
            `Failed to clean up agent query child session ${child?.id}: ${String(cleanupError)}`,
          );
        });
      }
      throw error;
    }
  }

  async delete(parentSessionId: number, planChatId: number) {
    const row = await this.findById(parentSessionId, planChatId);
    await this.sessionsService
      .delete(row.childSessionId)
      .catch(async (error) => {
        this.logger.warn(
          `Failed to delete plan chat child session ${row.childSessionId}: ${String(error)}`,
        );
        await this.deleteRow(row.id);
      });
    return { id: planChatId, deleted: true };
  }

  private async applyProviderResult(
    childSessionId: number,
    provider: AgentProviderId,
    result: AgentForkConversationResult,
  ): Promise<SessionWithContext> {
    const providerSessionId = result.providerSessionId?.trim() || null;

    if (providerSessionId) {
      if (provider === 'claude') {
        await this.sessionsService.updateClaudeSessionId(
          childSessionId,
          providerSessionId,
        );
      } else if (provider === 'codex') {
        await this.sessionsService.updateCodexSessionId(
          childSessionId,
          providerSessionId,
        );
      }
    } else {
      await this.sessionsService.updateActiveAgentProvider(
        childSessionId,
        provider,
      );
    }

    return this.sessionsService.findOne(childSessionId);
  }

  private async ensurePlanMode(
    registry: AgentRuntimeRegistryService,
    provider: AgentProviderId,
    sessionId: number,
  ): Promise<void> {
    await registry
      .getProviderFeature(provider, 'setPlanMode')
      .setPlanMode(sessionId, true);
  }

  private async findExisting(parentSessionId: number, reviewId: string) {
    const rows = await this.db
      .select()
      .from(schema.planChatForks)
      .where(
        and(
          eq(schema.planChatForks.parentSessionId, parentSessionId),
          eq(schema.planChatForks.reviewId, reviewId),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  private async findById(parentSessionId: number, planChatId: number) {
    const rows = await this.db
      .select()
      .from(schema.planChatForks)
      .where(
        and(
          eq(schema.planChatForks.parentSessionId, parentSessionId),
          eq(schema.planChatForks.id, planChatId),
        ),
      )
      .limit(1);
    if (!rows[0]) {
      throw new NotFoundException('Plan chat not found.');
    }
    return rows[0];
  }

  private deleteRow(planChatId: number) {
    return this.db
      .delete(schema.planChatForks)
      .where(eq(schema.planChatForks.id, planChatId));
  }

  private parseAnchorKind(value: string | undefined): PlanChatAnchorKind {
    if (value === 'user' || value === 'assistant') {
      return value;
    }
    throw new BadRequestException(
      'Plan chat anchor kind must be "user" or "assistant".',
    );
  }

  private normalizeProvider(provider: AgentProviderId): AgentProviderId {
    if (provider === 'claude' || provider === 'codex') {
      return provider;
    }
    throw new BadRequestException(
      `Plan Q&A is not supported for agent provider "${provider}".`,
    );
  }

  private buildGuardedQuestionPrompt(
    question: string,
    planExcerpt: string | null,
  ): string {
    return [
      '<elevenex-plan-chat>',
      'You are in a hidden Q&A fork for the plan already present in this conversation.',
      'Answer only the user question about that plan.',
      'Do not write a new plan, do not continue the original task, do not implement changes, and do not modify files.',
      'Do not include proposed_plan tags in your response.',
      'If the question asks you to implement, continue, or create a revised plan, explain that this panel is only for questions about the existing plan.',
      planExcerpt
        ? [
            '',
            '<elevenex_plan_excerpt>',
            planExcerpt,
            '</elevenex_plan_excerpt>',
          ].join('\n')
        : '',
      '',
      '<elevenex_plan_question>',
      question,
      '</elevenex_plan_question>',
      '</elevenex-plan-chat>',
    ]
      .filter(Boolean)
      .join('\n');
  }

  private defaultPlanChatName(parentName: string | null | undefined): string {
    return `${parentName?.trim() || 'Session'} plan Q&A`;
  }

  private defaultAskName(parentName: string | null | undefined): string {
    return `${parentName?.trim() || 'Session'} agent Q&A`;
  }

  /** True when the provider runtime reports the session is actively producing. */
  private async isRuntimeRunning(
    registry: AgentRuntimeRegistryService,
    provider: AgentProviderId,
    sessionId: number,
  ): Promise<boolean> {
    try {
      const state = (await registry
        .getProvider(provider)
        .getRuntimeState(sessionId)) as {
        sessionState?: string | null;
        runPhase?: string | null;
      };
      return state.sessionState === 'running' || state.runPhase === 'running';
    } catch {
      return false;
    }
  }

  /**
   * Anchor a fork at the parent's current conversation head — the last
   * message in its history. ask() guards that the parent is idle first, so the
   * head is stable.
   */
  private async resolveParentAnchor(
    registry: AgentRuntimeRegistryService,
    provider: AgentProviderId,
    parentSessionId: number,
  ): Promise<{ id: string; kind: PlanChatAnchorKind }> {
    const history = await registry
      .getProvider(provider)
      .getHistory(parentSessionId);
    for (let i = history.length - 1; i >= 0; i--) {
      const item = history[i];
      if (item.kind === 'user' || item.kind === 'assistant') {
        return {
          id: item.transcriptMessageId ?? item.sourceMessageId ?? item.id,
          kind: item.kind,
        };
      }
    }
    throw new BadRequestException(
      'The session has no conversation yet to ask about.',
    );
  }

  /**
   * Event-driven wait for the child fork to go idle and produce an assistant
   * answer, bounded by `timeoutMs` and cancellable via `signal`. Returns the
   * trimmed answer, or null on timeout/cancel (the fork keeps running).
   */
  private async waitForAnswer(
    registry: AgentRuntimeRegistryService,
    provider: AgentProviderId,
    childSessionId: number,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<string | null> {
    const deadline = Date.now() + Math.max(0, timeoutMs);

    const isIdleWithAnswer = async (): Promise<string | null> => {
      if (await this.isRuntimeRunning(registry, provider, childSessionId)) {
        return null;
      }
      const history = await registry
        .getProvider(provider)
        .getHistory(childSessionId);
      return this.extractLastAssistantAnswer(history);
    };

    // Fast path: already idle with an answer.
    const immediate = await isIdleWithAnswer();
    if (immediate !== null) {
      return immediate;
    }

    return new Promise<string | null>((resolve) => {
      let settled = false;
      let timer: NodeJS.Timeout | null = null;
      let poll: NodeJS.Timeout | null = null;

      const onStatus = (payload: { sessionId: number }) => {
        if (payload.sessionId === childSessionId) check();
      };
      const onAbort = () => finish(null);

      const finish = (value: string | null) => {
        if (settled) return;
        settled = true;
        this.sessionsService.off('session-status-changed', onStatus);
        if (signal) signal.removeEventListener('abort', onAbort);
        if (timer) clearTimeout(timer);
        if (poll) clearInterval(poll);
        resolve(value);
      };

      const check = () => {
        if (settled) return;
        void isIdleWithAnswer()
          .then((answer) => {
            if (answer !== null) finish(answer);
            else if (Date.now() >= deadline) finish(null);
          })
          .catch(() => {
            if (Date.now() >= deadline) finish(null);
          });
      };

      this.sessionsService.on('session-status-changed', onStatus);
      if (signal) {
        if (signal.aborted) {
          finish(null);
          return;
        }
        signal.addEventListener('abort', onAbort);
      }

      timer = setTimeout(() => finish(null), Math.max(0, deadline - Date.now()));
      // Poll fallback in case a status-changed event is missed.
      poll = setInterval(check, 1_000);
    });
  }

  /** Last contentful assistant message in a transcript, trimmed; null if none. */
  private extractLastAssistantAnswer(
    history: ClaudeTranscriptItem[],
  ): string | null {
    for (let i = history.length - 1; i >= 0; i--) {
      const item = history[i];
      if (
        item.kind === 'assistant' &&
        typeof item.content === 'string' &&
        item.content.trim().length > 0
      ) {
        return item.content.trim();
      }
    }
    return null;
  }

  private truncateNullable(
    value: string | null,
    maxLength: number,
  ): string | null {
    if (!value) return null;
    return value.length > maxLength ? value.slice(0, maxLength) : value;
  }

  private toPlanChatDto(row: PlanChatForkRow) {
    if (!row) {
      throw new NotFoundException('Plan chat metadata not found.');
    }
    return {
      id: row.id,
      parentSessionId: row.parentSessionId,
      childSessionId: row.childSessionId,
      provider: row.provider,
      reviewId: row.reviewId,
      anchorMessageId: row.anchorMessageId,
      anchorMessageKind: row.anchorMessageKind,
      anchorExcerpt: row.anchorExcerpt,
      planExcerpt: row.planExcerpt,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}
