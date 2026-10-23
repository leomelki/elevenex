import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  RequestTimeoutException,
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
  AgentRuntimeProvider,
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
  /** Total deadline including setup; expiry after dispatch returns a `running` handle. */
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
// Only lifecycle events trigger reads; token streams are covered by the 1s fallback.
const ANSWER_STATE_EVENTS = new Set([
  'run_state',
  'runtime_snapshot',
  'runtime_status',
  'complete',
  'result',
  'history_snapshot',
  'history',
  'background_work',
  'terminal',
  'interrupted',
  'stopped',
  'closed',
]);

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
        folderId: parent.folderId ?? undefined,
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
    const deadline =
      Date.now() + Math.max(0, dto.timeoutMs ?? DEFAULT_ASK_TIMEOUT_MS);
    const question = dto.question?.trim();
    if (!question) throw new BadRequestException('A question is required.');
    if (question.length > 8_000) {
      throw new BadRequestException('Question is too long.');
    }

    let child: { id: number } | null = null;
    let dispatched = false;
    let settled = false;
    let failure: { error: unknown } | null = null;
    const stopped = new AbortController();
    const timeoutError = new RequestTimeoutException(
      'The question was not submitted before the deadline. Try again.',
    );
    const result = (answer: string | null): AskPlanChatForkResult => ({
      forkId: child!.id,
      childSessionId: child!.id,
      answer,
      running: answer === null,
    });

    return new Promise<AskPlanChatForkResult>((resolve, reject) => {
      const finish = (
        outcome: { value: AskPlanChatForkResult } | { error: unknown },
      ) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        dto.signal?.removeEventListener('abort', onAbort);
        stopped.abort();
        if ('error' in outcome) reject(outcome.error);
        else resolve(outcome.value);
      };
      const expire = (error: unknown) => {
        if (failure) finish(failure);
        else if (dispatched) finish({ value: result(null) });
        else finish({ error });
      };
      const onAbort = () => expire(dto.signal!.reason);
      const timer = setTimeout(
        () => expire(timeoutError),
        Math.max(0, deadline - Date.now()),
      );
      dto.signal?.addEventListener('abort', onAbort, { once: true });
      const assertActive = () => {
        if (settled || dto.signal?.aborted || Date.now() >= deadline) {
          throw dto.signal?.aborted ? dto.signal.reason : timeoutError;
        }
      };
      // The outer deadline also bounds setup reads. Uncancellable provider
      // calls can finish later; guards prevent dispatch after expiry and the
      // catch cleans up any late-created child once setup settles.
      const run = async (): Promise<AskPlanChatForkResult> => {
        try {
          assertActive();
          const parent = await this.sessionsService.findOne(parentSessionId);
          assertActive();
          if (parent.status === 'archived') {
            throw new BadRequestException('Archived sessions are read-only.');
          }
          const provider = this.normalizeProvider(parent.activeAgentProvider);
          const registry = this.moduleRef.get(AgentRuntimeRegistryService, {
            strict: false,
          });
          const runtime = registry.getProvider(provider);
          const parentState = (await runtime.getRuntimeState(
            parentSessionId,
          )) as {
            sessionState?: string;
            runPhase?: string;
            pendingPrompts?: unknown[];
            backgroundWork?: unknown[];
          };
          assertActive();
          if (
            parentState.sessionState === 'running' ||
            parentState.runPhase === 'running' ||
            parentState.pendingPrompts?.length ||
            parentState.backgroundWork?.length
          ) {
            throw new BadRequestException(
              'The session is busy producing a response; ask again once it is idle.',
            );
          }
          const anchor = await this.resolveParentAnchor(
            registry,
            provider,
            parentSessionId,
          );
          assertActive();
          const childName = this.defaultAskName(parent.name);
          child = await this.sessionsService.create({
            repoId: parent.repoId,
            workspaceId: parent.workspaceId ?? undefined,
            folderId: parent.folderId ?? undefined,
            branchName: parent.branchName,
            worktreePath: parent.worktreePath,
            name: childName,
            surface: dto.surface ?? 'agent_query',
            activeAgentProvider: provider,
          });
          assertActive();
          const providerResult = await registry
            .getProviderFeature(provider, 'forkConversation')
            .forkConversation({
              parentSessionId,
              childSessionId: child.id,
              anchorMessageId: anchor.id,
              anchorMessageKind: anchor.kind,
              childSessionName: childName,
            });
          assertActive();
          if (!providerResult.providerSessionId?.trim()) {
            throw new BadRequestException(
              'Could not fork the conversation at that point.',
            );
          }
          await this.applyProviderResult(child.id, provider, providerResult);
          assertActive();
          await this.ensurePlanMode(registry, provider, child.id);
          assertActive();
          const baseline = await runtime.getHistory(child.id);
          assertActive();
          const answer = await this.waitForAnswer(
            runtime,
            child.id,
            baseline,
            () => {
              assertActive();
              dispatched = true;
              return runtime.submitPrompt(
                child!.id,
                this.buildGuardedQuestionPrompt(question, null),
                question,
              );
            },
            stopped.signal,
          );
          return result(answer);
        } catch (error) {
          failure = { error };
          // Keep dispatched children after timeout/cancel: their handles have
          // been returned. Setup failures still own their child cleanup.
          if (child && (!settled || !dispatched)) {
            await this.sessionsService
              .delete(child.id)
              .catch((cleanupError) => {
                this.logger.warn(
                  `Failed to clean up agent query child session ${child?.id}: ${String(cleanupError)}`,
                );
              });
          }
          throw error;
        }
      };
      // Observe failures immediately, even if setup outlives the caller.
      void run().then(
        (value) => finish({ value }),
        (error: unknown) => finish({ error }),
      );
    });
  }

  async delete(parentSessionId: number, planChatId: number) {
    const row = await this.findById(parentSessionId, planChatId);
    await this.sessionsService
      .delete(row.childSessionId)
      .catch(async (error) => {
        if (!(error instanceof NotFoundException)) throw error;
        // Runtime cleanup can itself report NotFound. Verify storage first.
        await this.sessionsService.findOne(row.childSessionId).then(
          () => {
            throw error;
          },
          (lookupError: unknown) => {
            if (!(lookupError instanceof NotFoundException)) throw lookupError;
          },
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
      } else if (provider === 'opencode') {
        await this.sessionsService.updateOpenCodeSessionId(
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
    if (
      provider === 'claude' ||
      provider === 'codex' ||
      provider === 'opencode'
    ) {
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
   * Observe answers alongside submission: some providers keep submit pending
   * for the whole turn. The caller aborts this waiter at its absolute deadline,
   * including during a hung state/history read.
   */
  private waitForAnswer(
    runtime: AgentRuntimeProvider,
    childSessionId: number,
    baseline: ClaudeTranscriptItem[],
    submit: () => Promise<void>,
    signal: AbortSignal,
  ): Promise<string | null> {
    const baselineIds = new Set(baseline.map((item) => this.messageId(item)));
    return new Promise((resolve, reject) => {
      let settled = false;
      let checking = false;
      let recheck = false;
      let poll: NodeJS.Timeout | undefined;
      const finish = (
        outcome: { answer: string | null } | { error: unknown },
      ) => {
        if (settled) return;
        settled = true;
        clearTimeout(poll);
        this.sessionsService.off('session-status-changed', onStatus);
        runtime.off('event', onEvent);
        signal.removeEventListener('abort', onAbort);
        if ('error' in outcome) reject(outcome.error);
        else resolve(outcome.answer);
      };
      const onAbort = () => finish({ answer: null });
      const onStatus = (payload: { sessionId: number }) => {
        if (payload.sessionId === childSessionId) check();
      };
      const onEvent = (event: {
        type: string;
        payload: {
          sessionId: number;
          runPhase?: string;
          message?: string;
          lastError?: string;
        };
      }) => {
        if (event.payload.sessionId !== childSessionId) return;
        if (event.type === 'error' || event.payload.runPhase === 'error') {
          finish({
            error: new Error(
              event.payload.message ??
                event.payload.lastError ??
                'Question failed.',
            ),
          });
        } else if (ANSWER_STATE_EVENTS.has(event.type)) {
          check();
        }
      };
      const check = () => {
        if (settled) return;
        if (checking) {
          recheck = true;
          return;
        }
        clearTimeout(poll);
        checking = true;
        recheck = false;
        const read = async () => {
          const state = (await runtime.getRuntimeState(childSessionId)) as {
            sessionState?: string;
            runPhase?: string;
            lastError?: string;
            pendingPrompts?: unknown[];
            backgroundWork?: unknown[];
          };
          if (settled) return;
          if (state.runPhase === 'error')
            throw new Error(state.lastError ?? 'Question failed.');
          if (
            state.sessionState === 'running' ||
            state.runPhase === 'running' ||
            state.sessionState === 'requires_action' ||
            state.pendingPrompts?.length ||
            state.backgroundWork?.length
          )
            return;
          if (state.sessionState !== 'idle' && state.runPhase !== 'idle')
            return;
          const history = await runtime.getHistory(childSessionId);
          // A status event during the read invalidates the earlier idle
          // snapshot. Re-check before treating streamed text as a final answer.
          if (settled || recheck) return;
          for (let i = history.length - 1; i >= 0; i--) {
            const item = history[i];
            if (
              !baselineIds.has(this.messageId(item)) &&
              item.kind === 'assistant' &&
              item.content?.trim()
            ) {
              finish({ answer: item.content.trim() });
              return;
            }
          }
        };
        void read().then(
          () => {
            checking = false;
            if (settled) return;
            if (recheck) check();
            else poll = setTimeout(check, 1_000);
          },
          (error: unknown) => finish({ error }),
        );
      };
      this.sessionsService.on('session-status-changed', onStatus);
      runtime.on('event', onEvent);
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) {
        onAbort();
        return;
      }
      try {
        // Observe rejection before the first state/history await, including
        // failures arriving after timeout, cancellation or a returned answer.
        void submit().then(check, (error: unknown) => {
          if (settled) {
            this.logger.error(
              `Agent query failed session=${childSessionId}: ${String(error)}`,
            );
          } else finish({ error });
        });
        check();
      } catch (error) {
        finish({ error });
      }
    });
  }

  private messageId(item: ClaudeTranscriptItem): string {
    return item.transcriptMessageId ?? item.sourceMessageId ?? item.id;
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
