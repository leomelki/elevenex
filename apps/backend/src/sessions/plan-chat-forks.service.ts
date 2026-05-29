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
import { SessionsService } from './sessions.service.js';

type PlanChatForkRow = typeof schema.planChatForks.$inferSelect;
type PlanChatAnchorKind = 'user' | 'assistant';
type SessionWithContext = Awaited<ReturnType<SessionsService['findOne']>>;

export interface EnsurePlanChatForkDto {
  reviewId?: string;
  anchorMessageId?: string;
  anchorMessageKind?: string;
  planMarkdown?: string;
  name?: string;
}

export interface SubmitPlanChatQuestionDto {
  question?: string;
}

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
    const anchorMessageKind = this.parseAnchorKind(dto.anchorMessageKind);

    if (!reviewId) {
      throw new BadRequestException('A plan review id is required.');
    }
    if (!anchorMessageId) {
      throw new BadRequestException('A plan chat anchor message id is required.');
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
    const runtime = registry.getProviderFeature(provider, 'forkConversation');
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

      const providerResult = await runtime.forkConversation({
        parentSessionId,
        childSessionId: child.id,
        anchorMessageId,
        anchorMessageKind,
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
          anchorMessageId,
          anchorMessageKind,
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
    await registry
      .getProvider(provider)
      .submitPrompt(
        row.childSessionId,
        this.buildGuardedQuestionPrompt(question, row.planExcerpt),
        question,
      );

    return {
      planChat: {
        ...this.toPlanChatDto(row),
        childSession,
      },
      session: childSession,
      question,
    };
  }

  async delete(parentSessionId: number, planChatId: number) {
    const row = await this.findById(parentSessionId, planChatId);
    await this.sessionsService.delete(row.childSessionId).catch(async (error) => {
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
