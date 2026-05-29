import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  forwardRef,
} from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { asc, eq } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDB } from '../database/database.provider.js';
import * as schema from '../database/schema/index.js';
import { AgentRuntimeRegistryService } from '../agent-runtime/agent-runtime-registry.service.js';
import type {
  AgentForkConversationResult,
  AgentProviderId,
} from '../agent-runtime/agent-runtime.types.js';
import { SessionsService } from './sessions.service.js';

export type SessionForkAnchorKind = 'user' | 'assistant';

export interface CreateSessionForkDto {
  anchorMessageId?: string;
  anchorMessageKind?: string;
  anchorExcerpt?: string;
  name?: string;
}

type SessionForkRow = typeof schema.sessionForks.$inferSelect;
type SessionWithContext = Awaited<ReturnType<SessionsService['findOne']>>;

@Injectable()
export class SessionForksService {
  private readonly logger = new Logger(SessionForksService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    @Inject(forwardRef(() => SessionsService))
    private readonly sessionsService: SessionsService,
    private readonly moduleRef: ModuleRef,
  ) {}

  async findByParent(parentSessionId: number) {
    await this.sessionsService.findOne(parentSessionId);

    const rows = await this.db
      .select()
      .from(schema.sessionForks)
      .where(eq(schema.sessionForks.parentSessionId, parentSessionId))
      .orderBy(asc(schema.sessionForks.createdAt));

    return Promise.all(
      rows.map(async (row) => ({
        ...this.toForkDto(row),
        childSession: await this.sessionsService
          .findOne(row.childSessionId)
          .catch(() => null),
      })),
    );
  }

  async create(parentSessionId: number, dto: CreateSessionForkDto) {
    const parent = await this.sessionsService.findOne(parentSessionId);
    const anchorMessageId = dto.anchorMessageId?.trim();
    const anchorMessageKind = this.parseAnchorKind(dto.anchorMessageKind);

    if (!anchorMessageId) {
      throw new BadRequestException('A fork anchor message id is required.');
    }

    const provider = parent.activeAgentProvider;
    const childName = dto.name?.trim() || this.defaultForkName(parent.name);
    const registry = this.moduleRef.get(AgentRuntimeRegistryService, {
      strict: false,
    });
    const runtime = registry.getProviderFeature(provider, 'forkConversation');

    let child: { id: number } | null = null;
    try {
      child = await this.sessionsService.create({
        repoId: parent.repoId,
        workspaceId: parent.workspaceId ?? undefined,
        branchName: parent.branchName,
        worktreePath: parent.worktreePath,
        name: childName,
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
      const anchorExcerpt = this.truncateNullable(
        providerResult.anchorExcerpt ?? dto.anchorExcerpt ?? null,
        500,
      );
      const draft = this.truncateNullable(providerResult.draft ?? null, 50_000);

      const forkRows = await this.db
        .insert(schema.sessionForks)
        .values({
          parentSessionId,
          childSessionId: updatedChild.id,
          provider,
          anchorMessageId,
          anchorMessageKind,
          anchorExcerpt,
          draft,
        })
        .returning();

      return {
        fork: {
          ...this.toForkDto(forkRows[0]),
          childSession: updatedChild,
        },
        session: updatedChild,
        draft,
      };
    } catch (error) {
      if (child) {
        await this.sessionsService.delete(child.id).catch((cleanupError) => {
          this.logger.warn(
            `Failed to clean up child session ${child?.id} after fork failure: ${String(cleanupError)}`,
          );
        });
      }
      throw error;
    }
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
      } else if (provider === 'pi') {
        await this.sessionsService.updatePiSessionPath(
          childSessionId,
          providerSessionId,
        );
      } else {
        await this.sessionsService.updateActiveAgentProvider(
          childSessionId,
          provider,
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

  private parseAnchorKind(value: string | undefined): SessionForkAnchorKind {
    if (value === 'user' || value === 'assistant') {
      return value;
    }
    throw new BadRequestException(
      'Fork anchor kind must be "user" or "assistant".',
    );
  }

  private defaultForkName(parentName: string | null | undefined): string {
    return `${parentName?.trim() || 'Session'} (fork)`;
  }

  private truncateNullable(
    value: string | null,
    maxLength: number,
  ): string | null {
    if (!value) return null;
    return value.length > maxLength ? value.slice(0, maxLength) : value;
  }

  private toForkDto(row: SessionForkRow) {
    if (!row) {
      throw new NotFoundException('Fork metadata not found.');
    }
    return {
      id: row.id,
      parentSessionId: row.parentSessionId,
      childSessionId: row.childSessionId,
      provider: row.provider,
      anchorMessageId: row.anchorMessageId,
      anchorMessageKind: row.anchorMessageKind,
      anchorExcerpt: row.anchorExcerpt,
      draft: row.draft,
      createdAt: row.createdAt,
    };
  }
}
