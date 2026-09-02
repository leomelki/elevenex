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

type ReviewChatRow = typeof schema.reviewChats.$inferSelect;
type ReviewChatAnchorKind = 'user' | 'assistant';
type SessionWithContext = Awaited<ReturnType<SessionsService['findOne']>>;

export type ReviewChatMode = 'readonly' | 'write';
export type ReviewChatStatus = 'open' | 'resolved' | 'promoted';

/**
 * A code anchor for a review discussion. This is the frontend's
 * `DiffSelectionMention` with the bulky context blocks optional — we keep the
 * shape identical so the client can round-trip its own selections.
 */
export interface ReviewAnchorDto {
  filePath: string;
  oldPath?: string | null;
  scope?: string;
  changeHash?: string | null;
  fingerprint?: string | null;
  oldLineStart?: number | null;
  oldLineEnd?: number | null;
  newLineStart?: number | null;
  newLineEnd?: number | null;
  selectedText?: string;
  compareLabel?: string | null;
  [key: string]: unknown;
}

export interface CreateReviewChatDto {
  anchors?: ReviewAnchorDto[];
  title?: string;
  scope?: string;
  /** Explicit fork point. When omitted the last completed turn is used. */
  anchorMessageId?: string;
  anchorMessageKind?: string;
  /** Parent turn this thread belongs to, for grouping in the main chat. */
  turnKey?: string;
}

export interface SubmitReviewChatMessageDto {
  message?: string;
}

export interface UpdateReviewChatDto {
  title?: string;
  mode?: string;
  status?: string;
  markRead?: boolean;
}

/**
 * Each open thread is a forked session, and each forked session eventually
 * spawns its own agent process. Six is generous for human review and low
 * enough that an automated caller cannot quietly exhaust the machine.
 */
const MAX_OPEN_REVIEW_CHATS = 6;
const MAX_ANCHORS_PER_CHAT = 10;
const MAX_MESSAGE_LENGTH = 8_000;
const MAX_ANCHORS_JSON_LENGTH = 100_000;

@Injectable()
export class ReviewChatsService {
  private readonly logger = new Logger(ReviewChatsService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    @Inject(forwardRef(() => SessionsService))
    private readonly sessionsService: SessionsService,
    private readonly moduleRef: ModuleRef,
  ) {}

  async findByParent(parentSessionId: number, filePath?: string) {
    await this.sessionsService.findOne(parentSessionId);

    const predicates: SQL[] = [
      eq(schema.reviewChats.parentSessionId, parentSessionId),
    ];
    const normalizedPath = filePath?.trim();
    if (normalizedPath) {
      predicates.push(eq(schema.reviewChats.filePath, normalizedPath));
    }

    const rows = await this.db
      .select()
      .from(schema.reviewChats)
      .where(and(...predicates))
      .orderBy(asc(schema.reviewChats.createdAt));

    return Promise.all(
      rows.map(async (row) => ({
        ...this.toDto(row),
        childSession: await this.sessionsService
          .findOne(row.childSessionId)
          .catch(() => null),
      })),
    );
  }

  async create(parentSessionId: number, dto: CreateReviewChatDto) {
    const parent = await this.sessionsService.findOne(parentSessionId);
    if (parent.status === 'archived') {
      throw new BadRequestException('Archived sessions are read-only.');
    }

    const provider = this.normalizeProvider(parent.activeAgentProvider);
    const anchors = this.normalizeAnchors(dto.anchors);
    const registry = this.moduleRef.get(AgentRuntimeRegistryService, {
      strict: false,
    });

    await this.assertUnderThreadLimit(parentSessionId);

    const anchor = await this.resolveForkAnchor(
      registry,
      provider,
      parentSessionId,
      dto,
    );

    const title = dto.title?.trim() || this.defaultTitle(anchors);
    let child: { id: number } | null = null;

    try {
      child = await this.sessionsService.create({
        repoId: parent.repoId,
        workspaceId: parent.workspaceId ?? undefined,
        branchName: parent.branchName,
        worktreePath: parent.worktreePath,
        name: title,
        surface: 'embedded_review_chat',
        activeAgentProvider: provider,
      });

      const providerResult = await registry
        .getProviderFeature(provider, 'forkConversation')
        .forkConversation({
          parentSessionId,
          childSessionId: child.id,
          anchorMessageId: anchor.id,
          anchorMessageKind: anchor.kind,
          childSessionName: title,
        });

      // A null provider session id means the anchor resolved to nothing, so the
      // child would silently start a *fresh* conversation with none of the
      // review context. That is worse than failing, so refuse it.
      if (!providerResult.providerSessionId?.trim()) {
        throw new BadRequestException(
          'Could not fork the conversation at that point. Try again once the current turn finishes.',
        );
      }

      const updatedChild = await this.applyProviderResult(
        child.id,
        provider,
        providerResult,
      );
      await this.setPlanMode(registry, provider, updatedChild.id, true);

      const primary = anchors[0] ?? null;
      const rows = await this.db
        .insert(schema.reviewChats)
        .values({
          parentSessionId,
          childSessionId: updatedChild.id,
          provider,
          title,
          mode: 'readonly',
          status: 'open',
          scope: dto.scope?.trim() || primary?.scope || 'branch',
          filePath: primary?.filePath ?? null,
          anchorsJson: this.serializeAnchors(anchors),
          changeHash: primary?.changeHash ?? null,
          fingerprint: primary?.fingerprint ?? null,
          anchorMessageId: anchor.id,
          anchorMessageKind: anchor.kind,
          turnKey: dto.turnKey?.trim() || null,
        })
        .returning();

      return {
        reviewChat: {
          ...this.toDto(rows[0]),
          childSession: updatedChild,
        },
        session: updatedChild,
      };
    } catch (error) {
      if (child) {
        await this.sessionsService.delete(child.id).catch((cleanupError) => {
          this.logger.warn(
            `Failed to clean up review chat child session ${child?.id}: ${String(cleanupError)}`,
          );
        });
      }
      throw error;
    }
  }

  async submitMessage(
    parentSessionId: number,
    chatId: number,
    dto: SubmitReviewChatMessageDto,
  ) {
    const row = await this.findById(parentSessionId, chatId);
    const childSession = await this.sessionsService.findOne(row.childSessionId);
    if (childSession.status === 'archived') {
      throw new BadRequestException('Archived review chats are read-only.');
    }

    const message = dto.message?.trim();
    if (!message) {
      throw new BadRequestException('A message is required.');
    }
    if (message.length > MAX_MESSAGE_LENGTH) {
      throw new BadRequestException('Message is too long.');
    }

    const registry = this.moduleRef.get(AgentRuntimeRegistryService, {
      strict: false,
    });
    const provider = this.normalizeProvider(row.provider as AgentProviderId);
    const mode = this.parseMode(row.mode);
    await this.setPlanMode(registry, provider, row.childSessionId, mode === 'readonly');

    void registry
      .getProvider(provider)
      .submitPrompt(
        row.childSessionId,
        this.buildGuardedPrompt(message, row, mode),
        message,
      )
      .catch((error) => {
        this.logger.error(
          `Review chat message failed session=${row.childSessionId}: ${String(error)}`,
        );
      });

    return {
      reviewChat: { ...this.toDto(row), childSession },
      session: childSession,
      message,
    };
  }

  async addAnchors(
    parentSessionId: number,
    chatId: number,
    dto: { anchors?: ReviewAnchorDto[] },
  ) {
    const row = await this.findById(parentSessionId, chatId);
    const incoming = this.normalizeAnchors(dto.anchors);
    const merged = [...this.parseAnchors(row.anchorsJson), ...incoming];
    if (merged.length > MAX_ANCHORS_PER_CHAT) {
      throw new BadRequestException(
        `A discussion can reference at most ${MAX_ANCHORS_PER_CHAT} selections.`,
      );
    }

    const rows = await this.db
      .update(schema.reviewChats)
      .set({
        anchorsJson: this.serializeAnchors(merged),
        updatedAt: new Date().toISOString(),
      })
      .where(eq(schema.reviewChats.id, chatId))
      .returning();

    return this.toDto(rows[0]);
  }

  async update(
    parentSessionId: number,
    chatId: number,
    dto: UpdateReviewChatDto,
  ) {
    const row = await this.findById(parentSessionId, chatId);
    const patch: Partial<typeof schema.reviewChats.$inferInsert> = {
      updatedAt: new Date().toISOString(),
    };

    if (dto.title !== undefined) {
      const title = dto.title.trim();
      if (!title) throw new BadRequestException('A title is required.');
      patch.title = title;
    }

    if (dto.mode !== undefined) {
      const mode = this.parseMode(dto.mode);
      patch.mode = mode;
      const registry = this.moduleRef.get(AgentRuntimeRegistryService, {
        strict: false,
      });
      await this.setPlanMode(
        registry,
        this.normalizeProvider(row.provider as AgentProviderId),
        row.childSessionId,
        mode === 'readonly',
      );
    }

    if (dto.status !== undefined) {
      patch.status = this.parseStatus(dto.status);
    }

    if (dto.markRead) {
      patch.lastReadAt = new Date().toISOString();
    }

    const rows = await this.db
      .update(schema.reviewChats)
      .set(patch)
      .where(eq(schema.reviewChats.id, chatId))
      .returning();

    return this.toDto(rows[0]);
  }

  /**
   * Turn a hidden review thread into a standalone session, preserving its
   * conversation. Registers it in `session_forks` so it behaves exactly like a
   * conversation fork made from the transcript, and returns the same shape so
   * the frontend can reuse its existing "fork created" handling.
   */
  async promote(parentSessionId: number, chatId: number) {
    const row = await this.findById(parentSessionId, chatId);
    if (row.status === 'promoted') {
      throw new BadRequestException(
        'This discussion has already been opened as a session.',
      );
    }

    const registry = this.moduleRef.get(AgentRuntimeRegistryService, {
      strict: false,
    });
    const provider = this.normalizeProvider(row.provider as AgentProviderId);

    const session = await this.sessionsService.updateSurface(
      row.childSessionId,
      'session',
    );
    await this.setPlanMode(registry, provider, row.childSessionId, false);

    const forkRows = await this.db
      .insert(schema.sessionForks)
      .values({
        parentSessionId,
        childSessionId: row.childSessionId,
        provider,
        anchorMessageId: row.anchorMessageId,
        anchorMessageKind: row.anchorMessageKind,
        anchorExcerpt: this.anchorExcerpt(row),
      })
      .returning();

    await this.db
      .update(schema.reviewChats)
      .set({
        status: 'promoted',
        mode: 'write',
        promotedForkId: forkRows[0].id,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(schema.reviewChats.id, chatId));

    const childSession = await this.sessionsService.findOne(row.childSessionId);
    return {
      fork: { ...forkRows[0], childSession },
      session,
      draft: null,
    };
  }

  async delete(parentSessionId: number, chatId: number) {
    const row = await this.findById(parentSessionId, chatId);
    await this.sessionsService
      .delete(row.childSessionId)
      .catch(async (error) => {
        this.logger.warn(
          `Failed to delete review chat child session ${row.childSessionId}: ${String(error)}`,
        );
        await this.db
          .delete(schema.reviewChats)
          .where(eq(schema.reviewChats.id, row.id));
      });
    return { id: chatId, deleted: true };
  }

  private async assertUnderThreadLimit(parentSessionId: number): Promise<void> {
    const rows = await this.db
      .select()
      .from(schema.reviewChats)
      .where(eq(schema.reviewChats.parentSessionId, parentSessionId));
    const open = rows.filter((row) => row.status === 'open');
    if (open.length >= MAX_OPEN_REVIEW_CHATS) {
      throw new BadRequestException(
        `You already have ${MAX_OPEN_REVIEW_CHATS} open review discussions. Resolve or close one first.`,
      );
    }
  }

  /**
   * Pick the transcript message to fork from.
   *
   * Forking only reads the on-disk transcript up to a given message, so it is
   * safe while the parent is mid-turn *provided* the anchor is already
   * persisted. Anchoring at the live head is not, which is why a running parent
   * skips the newest item rather than refusing the request outright.
   */
  private async resolveForkAnchor(
    registry: AgentRuntimeRegistryService,
    provider: AgentProviderId,
    parentSessionId: number,
    dto: CreateReviewChatDto,
  ): Promise<{ id: string; kind: ReviewChatAnchorKind }> {
    const explicitId = dto.anchorMessageId?.trim();
    if (explicitId) {
      return { id: explicitId, kind: this.parseAnchorKind(dto.anchorMessageKind) };
    }

    const running = await this.isRuntimeRunning(
      registry,
      provider,
      parentSessionId,
    );
    const history = await registry.getProvider(provider).getHistory(parentSessionId);
    const searchFrom = running ? history.length - 2 : history.length - 1;

    for (let index = searchFrom; index >= 0; index -= 1) {
      const item = history[index];
      if (item.kind === 'user' || item.kind === 'assistant') {
        return {
          id: item.transcriptMessageId ?? item.sourceMessageId ?? item.id,
          kind: item.kind,
        };
      }
    }

    throw new BadRequestException(
      'This session has no completed turn to start a discussion from yet.',
    );
  }

  private buildGuardedPrompt(
    message: string,
    row: ReviewChatRow,
    mode: ReviewChatMode,
  ): string {
    const anchors = this.parseAnchors(row.anchorsJson);
    const anchorBlocks = anchors.map((anchor) =>
      [
        '<elevenex_review_anchor>',
        `file: ${anchor.filePath}`,
        this.formatLineRange(anchor),
        anchor.selectedText ? `\n${anchor.selectedText}` : '',
        '</elevenex_review_anchor>',
      ]
        .filter(Boolean)
        .join('\n'),
    );

    return [
      '<elevenex-review-chat>',
      'You are in a focused side discussion about specific code in this worktree.',
      'Answer the question about the anchored code below.',
      mode === 'readonly'
        ? 'Do not modify files, and do not continue the original task — this panel is read-only. If asked to implement something, say that edits must be enabled for this discussion first.'
        : 'Edits are enabled for this discussion. Stay scoped to the anchored code.',
      '',
      ...anchorBlocks,
      '',
      '<elevenex_review_question>',
      message,
      '</elevenex_review_question>',
      '</elevenex-review-chat>',
    ]
      .filter(Boolean)
      .join('\n');
  }

  private formatLineRange(anchor: ReviewAnchorDto): string {
    const start = anchor.newLineStart ?? anchor.oldLineStart;
    const end = anchor.newLineEnd ?? anchor.oldLineEnd;
    if (start === null || start === undefined) return '';
    return end && end !== start
      ? `lines: ${start}-${end}`
      : `lines: ${start}`;
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

  private async setPlanMode(
    registry: AgentRuntimeRegistryService,
    provider: AgentProviderId,
    sessionId: number,
    enabled: boolean,
  ): Promise<void> {
    await registry
      .getProviderFeature(provider, 'setPlanMode')
      .setPlanMode(sessionId, enabled);
  }

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

  private async findById(parentSessionId: number, chatId: number) {
    const rows = await this.db
      .select()
      .from(schema.reviewChats)
      .where(
        and(
          eq(schema.reviewChats.parentSessionId, parentSessionId),
          eq(schema.reviewChats.id, chatId),
        ),
      )
      .limit(1);
    if (!rows[0]) {
      throw new NotFoundException('Review discussion not found.');
    }
    return rows[0];
  }

  private normalizeAnchors(anchors: ReviewAnchorDto[] | undefined) {
    const list = Array.isArray(anchors) ? anchors : [];
    if (!list.length) {
      throw new BadRequestException('At least one code selection is required.');
    }
    if (list.length > MAX_ANCHORS_PER_CHAT) {
      throw new BadRequestException(
        `A discussion can reference at most ${MAX_ANCHORS_PER_CHAT} selections.`,
      );
    }
    for (const anchor of list) {
      if (!anchor?.filePath?.trim()) {
        throw new BadRequestException('Each selection needs a file path.');
      }
    }
    return list;
  }

  private serializeAnchors(anchors: ReviewAnchorDto[]): string {
    const json = JSON.stringify(anchors);
    if (json.length > MAX_ANCHORS_JSON_LENGTH) {
      throw new BadRequestException('The selected code is too large.');
    }
    return json;
  }

  private parseAnchors(json: string): ReviewAnchorDto[] {
    try {
      const parsed: unknown = JSON.parse(json);
      return Array.isArray(parsed) ? (parsed as ReviewAnchorDto[]) : [];
    } catch {
      return [];
    }
  }

  private anchorExcerpt(row: ReviewChatRow): string | null {
    const anchors = this.parseAnchors(row.anchorsJson);
    const primary = anchors[0];
    if (!primary) return null;
    const label = `${primary.filePath} ${this.formatLineRange(primary)}`.trim();
    return label.slice(0, 500);
  }

  private defaultTitle(anchors: ReviewAnchorDto[]): string {
    const primary = anchors[0];
    if (!primary) return 'Review discussion';
    const basename = primary.filePath.split('/').pop() ?? primary.filePath;
    const range = this.formatLineRange(primary).replace('lines: ', ':');
    return `${basename}${range}`;
  }

  private parseAnchorKind(value: string | undefined): ReviewChatAnchorKind {
    if (value === 'user' || value === 'assistant') {
      return value;
    }
    throw new BadRequestException(
      'Review chat anchor kind must be "user" or "assistant".',
    );
  }

  private parseMode(value: string): ReviewChatMode {
    if (value === 'readonly' || value === 'write') return value;
    throw new BadRequestException(
      'Review chat mode must be "readonly" or "write".',
    );
  }

  private parseStatus(value: string): ReviewChatStatus {
    if (value === 'open' || value === 'resolved' || value === 'promoted') {
      return value;
    }
    throw new BadRequestException(
      'Review chat status must be "open", "resolved", or "promoted".',
    );
  }

  private normalizeProvider(provider: AgentProviderId): AgentProviderId {
    if (provider === 'claude' || provider === 'codex') {
      return provider;
    }
    throw new BadRequestException(
      `Review discussions are not supported for agent provider "${provider}".`,
    );
  }

  private toDto(row: ReviewChatRow) {
    if (!row) {
      throw new NotFoundException('Review discussion not found.');
    }
    return {
      id: row.id,
      parentSessionId: row.parentSessionId,
      childSessionId: row.childSessionId,
      provider: row.provider,
      title: row.title,
      mode: row.mode as ReviewChatMode,
      status: row.status as ReviewChatStatus,
      scope: row.scope,
      filePath: row.filePath,
      anchors: this.parseAnchors(row.anchorsJson),
      changeHash: row.changeHash,
      fingerprint: row.fingerprint,
      anchorMessageId: row.anchorMessageId,
      anchorMessageKind: row.anchorMessageKind,
      turnKey: row.turnKey,
      promotedForkId: row.promotedForkId,
      lastReadAt: row.lastReadAt,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}
