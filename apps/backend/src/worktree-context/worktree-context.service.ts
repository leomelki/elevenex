import {
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import simpleGit, { type DefaultLogFields, type ListLogLine, type SimpleGit } from 'simple-git';
import { query, type CanUseTool } from '@anthropic-ai/claude-agent-sdk';
import { buildAugmentedEnv, findBinary } from '../config/system-paths.js';
import { DRIZZLE, type DrizzleDB } from '../database/database.provider.js';
import * as schema from '../database/schema/index.js';
import { SessionsService } from '../sessions/sessions.service.js';

const CLAUDE_BIN = findBinary('claude') ?? 'claude';
const MAX_CHANGED_FILES = 40;
const MAX_COMMITS = 20;
const MAX_DIFF_CHARS = 18_000;
const EMPTY_SNAPSHOT_CACHE_TTL_MS = 60_000;
const VALID_GENERATION_STATUSES = ['idle', 'generating', 'ready', 'failed'] as const;

type GenerationStatus = (typeof VALID_GENERATION_STATUSES)[number];

export interface WorktreeContextSnapshot {
  repoId: number;
  worktreePath: string;
  contextSentence: string | null;
  rootRef: string | null;
  generationStatus: GenerationStatus;
  generatedAt: string | null;
  lastUsedAt: string | null;
  canGenerate: boolean;
  hasChanges: boolean;
  usingRepoDefaultRootRef: boolean;
  errorMessage: string | null;
  hasRecord: boolean;
}

interface BranchContextInput {
  rootRef: string | null;
  resolvedRootRef: string | null;
  usingRepoDefaultRootRef: boolean;
  hasChanges: boolean;
  commits: Array<{ hash: string; message: string }>;
  changedFiles: string[];
  diffSummary: string;
  errorMessage?: string;
}

interface CachedSnapshotEntry {
  expiresAt: number;
  fingerprint: string;
  snapshot: WorktreeContextSnapshot;
}

@Injectable()
export class WorktreeContextService {
  private readonly logger = new Logger(WorktreeContextService.name);
  private readonly snapshotLocks = new Map<string, Promise<WorktreeContextSnapshot>>();
  private readonly generationLocks = new Map<string, Promise<WorktreeContextSnapshot>>();
  private readonly emptySnapshotCache = new Map<string, CachedSnapshotEntry>();

  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly sessionsService: SessionsService,
  ) {}

  async getSnapshot(repoId: number, worktreePath: string): Promise<WorktreeContextSnapshot> {
    const key = this.cacheKey(repoId, worktreePath);
    const inFlight = this.snapshotLocks.get(key);
    if (inFlight) {
      this.logger.log(
        `[worktree-context] join in-flight snapshot for ${worktreePath} (repo=${repoId})`,
      );
      return inFlight;
    }

    const promise = this.getSnapshotInternal(repoId, worktreePath)
      .finally(() => {
        this.snapshotLocks.delete(key);
      });
    this.snapshotLocks.set(key, promise);
    return promise;
  }

  private async getSnapshotInternal(repoId: number, worktreePath: string): Promise<WorktreeContextSnapshot> {
    const repo = await this.getRepo(repoId);
    const existing = await this.findRecord(repoId, worktreePath);
    const fingerprint = this.snapshotFingerprint(existing, repo.preferredContextRootRef ?? null);

    // Fast path: a previously generated sentence is cached. Return it without
    // running any git commands. The user can click Recompute to refresh.
    if (existing?.generationStatus === 'ready' && existing.contextSentence) {
      this.clearEmptySnapshotCache(repoId, worktreePath);
      this.logger.log(
        `[worktree-context] snapshot fast-path for ${worktreePath} (cached sentence, skipping git)`,
      );
      return this.toCachedSnapshot(repoId, worktreePath, existing);
    }

    const cachedEmptySnapshot = this.getCachedEmptySnapshot(repoId, worktreePath, fingerprint);
    if (cachedEmptySnapshot) {
      this.logger.log(
        `[worktree-context] snapshot empty-cache hit for ${worktreePath} (repo=${repoId})`,
      );
      return cachedEmptySnapshot;
    }

    const branchContext = await this.collectBranchContext(
      worktreePath,
      existing?.rootRef ?? null,
      repo.preferredContextRootRef ?? null,
    );
    this.logger.log(
      `[worktree-context] snapshot for ${worktreePath} hasRecord=${!!existing} status=${existing?.generationStatus ?? 'none'} hasSentence=${!!existing?.contextSentence} hasChanges=${branchContext.hasChanges}`,
    );

    const snapshot = this.toSnapshot(repoId, worktreePath, existing, branchContext);
    this.storeEmptySnapshotCache(repoId, worktreePath, fingerprint, snapshot);
    return snapshot;
  }

  private toCachedSnapshot(
    repoId: number,
    worktreePath: string,
    record: typeof schema.worktreeContexts.$inferSelect,
  ): WorktreeContextSnapshot {
    return {
      repoId,
      worktreePath,
      contextSentence: record.contextSentence,
      rootRef: record.rootRef,
      generationStatus: this.normalizeGenerationStatus(record.generationStatus),
      generatedAt: record.generatedAt,
      lastUsedAt: record.lastUsedAt,
      canGenerate: true,
      hasChanges: true,
      usingRepoDefaultRootRef: !this.normalizeOptionalText(record.rootRef),
      errorMessage: null,
      hasRecord: true,
    };
  }

  async updateRootRef(repoId: number, worktreePath: string, rootRef: string | null): Promise<WorktreeContextSnapshot> {
    await this.getRepo(repoId);
    const existing = await this.findRecord(repoId, worktreePath);
    const now = new Date().toISOString();
    this.clearEmptySnapshotCache(repoId, worktreePath);

    await this.upsertRecord(repoId, worktreePath, {
      rootRef: this.normalizeOptionalText(rootRef),
      contextSentence: existing?.contextSentence ?? null,
      generationStatus: this.normalizeGenerationStatus(existing?.generationStatus),
      generatedAt: existing?.generatedAt ?? null,
      lastUsedAt: existing?.lastUsedAt ?? null,
      updatedAt: now,
      createdAt: existing?.createdAt ?? now,
    });

    return this.getSnapshot(repoId, worktreePath);
  }

  async generate(
    repoId: number,
    worktreePath: string,
    options: { force?: boolean; rootRef?: string | null } = {},
  ): Promise<WorktreeContextSnapshot> {
    const key = `${repoId}:${worktreePath}`;
    const inFlight = this.generationLocks.get(key);
    if (inFlight) {
      this.logger.log(
        `[worktree-context] join in-flight generation for ${worktreePath} (repo=${repoId})`,
      );
      return inFlight;
    }

    this.logger.log(
      `[worktree-context] start generation for ${worktreePath} (repo=${repoId}, force=${!!options.force}, rootRef=${options.rootRef ?? 'inherit'})`,
    );
    const startedAt = Date.now();
    const promise = this.generateInternal(repoId, worktreePath, options)
      .finally(() => {
        this.generationLocks.delete(key);
        this.logger.log(
          `[worktree-context] generation released for ${worktreePath} after ${Date.now() - startedAt}ms`,
        );
      });
    this.generationLocks.set(key, promise);
    return promise;
  }

  async consumeForSession(
    sessionId: number,
    enabled = true,
  ): Promise<{ shouldInject: boolean; contextSentence: string | null }> {
    const session = await this.sessionsService.findOne(sessionId);

    if (!enabled || session.hasInjectedWorktreeContext) {
      return { shouldInject: false, contextSentence: null };
    }

    const snapshot = await this.getSnapshot(session.repoId, session.worktreePath);
    if (snapshot.generationStatus !== 'ready' || !snapshot.contextSentence) {
      return { shouldInject: false, contextSentence: null };
    }

    await this.sessionsService.markWorktreeContextInjected(sessionId);
    await this.touchLastUsed(session.repoId, session.worktreePath);
    return { shouldInject: true, contextSentence: snapshot.contextSentence };
  }

  private async generateInternal(
    repoId: number,
    worktreePath: string,
    options: { force?: boolean; rootRef?: string | null },
  ): Promise<WorktreeContextSnapshot> {
    const repo = await this.getRepo(repoId);
    const existing = await this.findRecord(repoId, worktreePath);
    this.clearEmptySnapshotCache(repoId, worktreePath);
    const requestedRootRef = options.rootRef !== undefined
      ? this.normalizeOptionalText(options.rootRef)
      : existing?.rootRef ?? null;
    const branchContext = await this.collectBranchContext(worktreePath,requestedRootRef, repo.preferredContextRootRef ?? null);

    if (!options.force && existing?.generationStatus === 'ready' && existing.contextSentence) {
      this.logger.log(
        `[worktree-context] reuse cached sentence for ${worktreePath}: "${existing.contextSentence}"`,
      );
      return this.toSnapshot(repoId, worktreePath, existing, branchContext);
    }

    if (!branchContext.hasChanges || !branchContext.resolvedRootRef) {
      this.logger.log(
        `[worktree-context] no branch-specific changes for ${worktreePath} (root=${branchContext.resolvedRootRef ?? 'unresolved'}); skipping LLM call and not persisting`,
      );
      return this.toSnapshot(repoId, worktreePath, existing ?? null, branchContext);
    }

    const now = new Date().toISOString();
    await this.upsertRecord(repoId, worktreePath, {
      rootRef: branchContext.rootRef,
      contextSentence: existing?.contextSentence ?? null,
      generationStatus: 'generating',
      generatedAt: existing?.generatedAt ?? null,
      lastUsedAt: existing?.lastUsedAt ?? null,
      updatedAt: now,
      createdAt: existing?.createdAt ?? now,
    });

    try {
      this.logger.log(
        `[worktree-context] invoking LLM for ${worktreePath} (root=${branchContext.resolvedRootRef}, commits=${branchContext.commits.length}, files=${branchContext.changedFiles.length})`,
      );
      const sentence = await this.generateSentence(worktreePath, branchContext);
      this.logger.log(`[worktree-context] generated for ${worktreePath}: "${sentence}"`);
      const ready = await this.persistGenerationOutcome(repoId, worktreePath, {
        rootRef: branchContext.rootRef,
        contextSentence: sentence,
        generationStatus: 'ready',
        generatedAt: new Date().toISOString(),
      });
      return this.toSnapshot(repoId, worktreePath, ready, branchContext);
    } catch (error) {
      this.logger.warn(`[worktree-context] generation failed for ${worktreePath}: ${error instanceof Error ? error.message : String(error)}`);
      const failed = await this.persistGenerationOutcome(repoId, worktreePath, {
        rootRef: branchContext.rootRef,
        contextSentence: existing?.contextSentence ?? null,
        generationStatus: 'failed',
        generatedAt: existing?.generatedAt ?? null,
      });
      return this.toSnapshot(repoId, worktreePath, failed, branchContext, error instanceof Error ? error.message : 'Generation failed');
    }
  }

  private async generateSentence(repoPath: string, branchContext: BranchContextInput): Promise<string> {
    const canUseTool: CanUseTool = async () => ({
      behavior: 'deny',
      message: 'Tool use disabled for context generation',
    });

    const prompt = [
      'You write a one-line hand-off for an engineering agent picking up this branch.',
      'Your output tells the agent, in one sentence: WHAT is being built/changed and WHERE in the codebase it lives, so they know what to do and where to look.',
      '',
      'Examples of the tone and shape we want:',
      '- "We are reworking the chat component of the review page."',
      '- "We are adding retry/backoff to the Stripe webhook handler in apps/backend/src/billing."',
      '- "We are migrating the auth middleware from JWT to session cookies (apps/api/middleware/auth)."',
      '- "We are polishing the worktree-context pin above the Claude composer."',
      '- "We are investigating flaky avatar uploads in the profile settings page."',
      '',
      'Rules:',
      '- Return exactly one sentence of plain text, no quotes, no markdown, no preamble.',
      '- Start with "We are " followed by the verb that best fits the work (e.g. "We are reworking", "We are adding", "We are fixing", "We are investigating", "We are migrating"). Do NOT default to "We are working on" — pick the verb that actually describes the change.',
      '- Name the feature/area/component by its real product or module name when obvious from the diff.',
      '- Locate the work: mention the page, feature area, subsystem, or (when useful for orientation) a short path fragment or filename. Short paths are fine; full paths are overkill.',
      '- Prefer human phrasing over git/diff vocabulary. Do NOT mention commit hashes, branch names, merge bases, refs, or "added/removed N lines".',
      '- If multiple unrelated changes exist, describe the dominant one and optionally hint at the rest with "and related tweaks".',
      '- Keep it under ~22 words. Be specific, not vague — avoid "various improvements" or "miscellaneous changes".',
      '',
      'Signals from the branch follow. Use them to infer intent; do not repeat them verbatim.',
      '',
      `Comparison root: ${branchContext.resolvedRootRef}`,
      '',
      'Branch-specific commits (most recent first):',
      branchContext.commits.length
        ? branchContext.commits.map(commit => `- ${commit.hash} ${commit.message}`).join('\n')
        : '- none',
      '',
      'Changed files:',
      branchContext.changedFiles.length
        ? branchContext.changedFiles.map(file => `- ${file}`).join('\n')
        : '- none',
      '',
      'Diff summary (stat + untracked):',
      branchContext.diffSummary || '[empty]',
    ].join('\n');

    this.logger.log(
      [
        `[worktree-context] === git observations (cwd=${repoPath}) ===`,
        `  root: ${branchContext.resolvedRootRef}`,
        `  commits (${branchContext.commits.length}):`,
        ...branchContext.commits.map(c => `    - ${c.hash} ${c.message}`),
        `  changed files (${branchContext.changedFiles.length}):`,
        ...branchContext.changedFiles.map(f => `    - ${f}`),
        `  diff summary (${branchContext.diffSummary.length} chars):`,
        ...(branchContext.diffSummary ? branchContext.diffSummary.split('\n').map(l => `    ${l}`) : ['    [empty]']),
      ].join('\n'),
    );
    this.logger.log(
      [
        `[worktree-context] === prompt to LLM (${prompt.length} chars) ===`,
        ...prompt.split('\n').map(l => `  | ${l}`),
      ].join('\n'),
    );

    let assistantText = '';
    const llmStartedAt = Date.now();
    const runtimeQuery = query({
      prompt,
      options: {
        cwd: repoPath,
        model: 'haiku',
        permissionMode: 'plan',
        canUseTool,
        pathToClaudeCodeExecutable: CLAUDE_BIN,
        systemPrompt: {
          type: 'preset',
          preset: 'claude_code',
        },
        tools: {
          type: 'preset',
          preset: 'claude_code',
        },
        env: buildAugmentedEnv(),
      },
    });

    try {
      for await (const message of runtimeQuery) {
        if (message.type !== 'assistant') continue;
        // Collect text within this turn. When the model attempts a tool call
        // that gets denied, it produces a second assistant turn with the same
        // sentence. Replacing rather than appending across turns ensures we
        // always end up with the last (final) assistant response only.
        const turnText = message.message.content
          .filter(block => block.type === 'text')
          .map(block => block.text)
          .join('');
        if (turnText) {
          assistantText = turnText;
        }
      }
    } finally {
      runtimeQuery.close();
    }

    const llmDurationMs = Date.now() - llmStartedAt;
    this.logger.log(
      [
        `[worktree-context] === LLM raw response (${assistantText.length} chars, ${llmDurationMs}ms) ===`,
        ...(assistantText ? assistantText.split('\n').map(l => `  > ${l}`) : ['  > [empty]']),
      ].join('\n'),
    );

    const normalized = this.normalizeGeneratedSentence(assistantText);
    this.logger.log(
      `[worktree-context] normalized sentence: "${normalized || '[empty after normalization]'}"`,
    );
    if (!normalized) {
      throw new Error('Generator returned an empty context sentence');
    }
    return normalized;
  }

  private normalizeGeneratedSentence(input: string): string {
    let collapsed = input
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/^["']|["']$/g, '');
    if (!collapsed) {
      return '';
    }
    if (!/^we are\s/i.test(collapsed)) {
      // The model dropped the required "We are " opener. Prepend it and
      // lowercase the first verb so it reads naturally.
      collapsed = `We are ${collapsed.charAt(0).toLowerCase()}${collapsed.slice(1)}`;
    }
    return collapsed.endsWith('.') ? collapsed : `${collapsed}.`;
  }

  private async collectBranchContext(
    repoPath: string,
    worktreeRootRef: string | null,
    repoPreferredRootRef: string | null,
  ): Promise<BranchContextInput> {
    const git = simpleGit(repoPath);
    const usingRepoDefaultRootRef = !this.normalizeOptionalText(worktreeRootRef);

    let resolvedRootRef: string | null;
    let resolutionError: string | undefined;
    try {
      resolvedRootRef = await this.resolveRootRef(git, worktreeRootRef, repoPreferredRootRef);
    } catch (error) {
      resolvedRootRef = null;
      resolutionError = error instanceof Error ? error.message : String(error);
      this.logger.warn(`[worktree-context] rootRef resolution failed: ${resolutionError}`);
    }

    if (!resolvedRootRef) {
      return {
        rootRef: worktreeRootRef ?? repoPreferredRootRef ?? null,
        resolvedRootRef: null,
        usingRepoDefaultRootRef,
        hasChanges: false,
        commits: [],
        changedFiles: [],
        diffSummary: '',
        errorMessage: resolutionError,
      };
    }

    const mergeBase = (await git.raw(['merge-base', 'HEAD', resolvedRootRef])).trim();
    const commits = await git.log({
      from: mergeBase,
      to: 'HEAD',
      maxCount: MAX_COMMITS,
    });
    const workingChangedOutput = await git.raw([
      'status',
      '--porcelain=1',
      '--untracked-files=all',
      '--no-renames',
    ]);
    if (commits.all.length === 0 && !workingChangedOutput.trim()) {
      return {
        rootRef: worktreeRootRef ?? repoPreferredRootRef ?? resolvedRootRef,
        resolvedRootRef,
        usingRepoDefaultRootRef,
        hasChanges: false,
        commits: [],
        changedFiles: [],
        diffSummary: '',
      };
    }

    const committedFilesOutput = await git.raw(['diff', '--name-only', '--find-renames', `${mergeBase}...HEAD`]);
    const committedDiffSummary = await git.raw(['diff', '--stat', '--find-renames', `${mergeBase}...HEAD`]);

    // Working tree: staged + unstaged + untracked relative to HEAD.
    const workingDiffSummary = await git.raw(['diff', '--stat', '--find-renames', 'HEAD']);

    const committedFiles = committedFilesOutput
      .split('\n')
      .map(file => file.trim())
      .filter(Boolean);

    const workingFiles = workingChangedOutput
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean)
      .map(line => line.replace(/^..\s+/, '').replace(/^"(.*)"$/, '$1'));

    const changedFiles = Array.from(new Set([...committedFiles, ...workingFiles])).slice(0, MAX_CHANGED_FILES);

    const diffSummaryParts: string[] = [];
    const trimmedCommittedDiff = committedDiffSummary.trim();
    if (trimmedCommittedDiff) {
      diffSummaryParts.push(`# Committed vs ${resolvedRootRef} (merge-base: ${mergeBase.slice(0, 7)})\n${trimmedCommittedDiff}`);
    }
    const trimmedWorkingDiff = workingDiffSummary.trim();
    if (trimmedWorkingDiff) {
      diffSummaryParts.push(`# Working tree vs HEAD\n${trimmedWorkingDiff}`);
    }
    if (workingFiles.length > committedFiles.length || (workingFiles.length && !trimmedWorkingDiff)) {
      // Make sure untracked files show up in the summary even if --stat misses them.
      const untrackedOnly = workingFiles.filter(f => !committedFiles.includes(f));
      if (untrackedOnly.length) {
        diffSummaryParts.push(`# Uncommitted / untracked files:\n${untrackedOnly.map(f => `  ${f}`).join('\n')}`);
      }
    }
    const diffSummary = diffSummaryParts.join('\n\n').slice(0, MAX_DIFF_CHARS);

    const hasChanges = commits.all.length > 0 || changedFiles.length > 0;
    return {
      rootRef: worktreeRootRef ?? repoPreferredRootRef ?? resolvedRootRef,
      resolvedRootRef,
      usingRepoDefaultRootRef,
      hasChanges,
      commits: commits.all.map((commit: DefaultLogFields & ListLogLine) => ({
        hash: commit.hash.slice(0, 7),
        message: commit.message,
      })),
      changedFiles,
      diffSummary,
    };
  }

  private async resolveRootRef(
    git: SimpleGit,
    worktreeRootRef: string | null,
    repoPreferredRootRef: string | null,
  ): Promise<string | null> {
    // Explicit user choice: honor it strictly. If it doesn't exist, fail loud
    // rather than silently falling back to origin/main — the old behavior
    // caused the comparison ref to lie about what we actually compared against.
    const explicit = this.normalizeOptionalText(worktreeRootRef) ?? this.normalizeOptionalText(repoPreferredRootRef);
    if (explicit) {
      if (await this.refExists(git, explicit)) {
        return explicit;
      }
      throw new Error(`Comparison root "${explicit}" does not exist in this worktree. Fetch it first, or pick another ref.`);
    }

    // No explicit choice: auto-detect.
    const candidates = [
      await this.resolveOriginHead(git),
      'origin/main',
      'origin/master',
      'origin/trunk',
      'main',
      'master',
      'trunk',
    ].filter((value, index, list): value is string => !!value && list.indexOf(value) === index);

    for (const candidate of candidates) {
      if (await this.refExists(git, candidate)) {
        return candidate;
      }
    }

    return null;
  }

  private async resolveOriginHead(git: SimpleGit): Promise<string | null> {
    try {
      const output = (await git.raw(['symbolic-ref', 'refs/remotes/origin/HEAD'])).trim();
      return output.replace(/^refs\/remotes\//, '');
    } catch {
      return null;
    }
  }

  private async refExists(git: SimpleGit, ref: string): Promise<boolean> {
    try {
      await git.raw(['rev-parse', '--verify', ref]);
      return true;
    } catch {
      return false;
    }
  }

  private async persistGenerationOutcome(
    repoId: number,
    worktreePath: string,
    input: {
      rootRef: string | null;
      contextSentence: string | null;
      generationStatus: GenerationStatus;
      generatedAt: string | null;
    },
  ) {
    const existing = await this.findRecord(repoId, worktreePath);
    const now = new Date().toISOString();
    this.clearEmptySnapshotCache(repoId, worktreePath);
    await this.upsertRecord(repoId, worktreePath, {
      rootRef: input.rootRef,
      contextSentence: input.contextSentence,
      generationStatus: input.generationStatus,
      generatedAt: input.generatedAt,
      lastUsedAt: existing?.lastUsedAt ?? null,
      updatedAt: now,
      createdAt: existing?.createdAt ?? now,
    });
    return this.findRecord(repoId, worktreePath);
  }

  private async touchLastUsed(repoId: number, worktreePath: string): Promise<void> {
    const existing = await this.findRecord(repoId, worktreePath);
    if (!existing) return;
    this.clearEmptySnapshotCache(repoId, worktreePath);

    await this.db
      .update(schema.worktreeContexts)
      .set({
        lastUsedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
      .where(and(
        eq(schema.worktreeContexts.repoId, repoId),
        eq(schema.worktreeContexts.worktreePath, worktreePath),
      ));
  }

  private async getRepo(repoId: number) {
    const rows = await this.db
      .select()
      .from(schema.repos)
      .where(eq(schema.repos.id, repoId));
    if (!rows.length) {
      throw new NotFoundException(`Repo with id ${repoId} not found`);
    }
    return rows[0];
  }

  private async findRecord(repoId: number, worktreePath: string) {
    const rows = await this.db
      .select()
      .from(schema.worktreeContexts)
      .where(and(
        eq(schema.worktreeContexts.repoId, repoId),
        eq(schema.worktreeContexts.worktreePath, worktreePath),
      ));
    return rows[0] ?? null;
  }

  private async upsertRecord(
    repoId: number,
    worktreePath: string,
    input: {
      rootRef: string | null;
      contextSentence: string | null;
      generationStatus: GenerationStatus;
      generatedAt: string | null;
      lastUsedAt: string | null;
      updatedAt: string;
      createdAt: string;
    },
  ): Promise<void> {
    const existing = await this.findRecord(repoId, worktreePath);
    if (existing) {
      await this.db
        .update(schema.worktreeContexts)
        .set({
          rootRef: input.rootRef,
          contextSentence: input.contextSentence,
          generationStatus: input.generationStatus,
          generatedAt: input.generatedAt,
          lastUsedAt: input.lastUsedAt,
          updatedAt: input.updatedAt,
        })
        .where(eq(schema.worktreeContexts.id, existing.id));
      return;
    }

    await this.db.insert(schema.worktreeContexts).values({
      repoId,
      worktreePath,
      rootRef: input.rootRef,
      contextSentence: input.contextSentence,
      generationStatus: input.generationStatus,
      generatedAt: input.generatedAt,
      lastUsedAt: input.lastUsedAt,
      createdAt: input.createdAt,
      updatedAt: input.updatedAt,
    });
  }

  private toSnapshot(
    repoId: number,
    worktreePath: string,
    record: typeof schema.worktreeContexts.$inferSelect | null,
    branchContext: BranchContextInput,
    errorMessage: string | null = null,
  ): WorktreeContextSnapshot {
    return {
      repoId,
      worktreePath,
      contextSentence: record?.contextSentence ?? null,
      rootRef: record?.rootRef ?? branchContext.rootRef ?? branchContext.resolvedRootRef ?? null,
      generationStatus: this.normalizeGenerationStatus(record?.generationStatus),
      errorMessage: errorMessage ?? branchContext.errorMessage ?? null,
      generatedAt: record?.generatedAt ?? null,
      lastUsedAt: record?.lastUsedAt ?? null,
      canGenerate: branchContext.hasChanges,
      hasChanges: branchContext.hasChanges,
      usingRepoDefaultRootRef: branchContext.usingRepoDefaultRootRef,
      hasRecord: !!record,
    };
  }

  private normalizeGenerationStatus(value: string | null | undefined): GenerationStatus {
    return VALID_GENERATION_STATUSES.includes(value as GenerationStatus)
      ? value as GenerationStatus
      : 'idle';
  }

  private normalizeOptionalText(value: string | null | undefined): string | null {
    const trimmed = value?.trim();
    return trimmed ? trimmed : null;
  }

  private cacheKey(repoId: number, worktreePath: string): string {
    return `${repoId}:${worktreePath}`;
  }

  private snapshotFingerprint(
    record: typeof schema.worktreeContexts.$inferSelect | null,
    repoPreferredRootRef: string | null,
  ): string {
    return JSON.stringify({
      recordId: record?.id ?? null,
      recordRootRef: record?.rootRef ?? null,
      recordStatus: record?.generationStatus ?? null,
      recordContext: record?.contextSentence ?? null,
      repoPreferredRootRef,
    });
  }

  private getCachedEmptySnapshot(
    repoId: number,
    worktreePath: string,
    fingerprint: string,
  ): WorktreeContextSnapshot | null {
    const key = this.cacheKey(repoId, worktreePath);
    const cached = this.emptySnapshotCache.get(key);
    if (!cached) {
      return null;
    }
    if (cached.expiresAt <= Date.now() || cached.fingerprint !== fingerprint) {
      this.emptySnapshotCache.delete(key);
      return null;
    }
    return cached.snapshot;
  }

  private storeEmptySnapshotCache(
    repoId: number,
    worktreePath: string,
    fingerprint: string,
    snapshot: WorktreeContextSnapshot,
  ): void {
    const key = this.cacheKey(repoId, worktreePath);
    if (snapshot.contextSentence || snapshot.hasChanges) {
      this.emptySnapshotCache.delete(key);
      return;
    }
    this.emptySnapshotCache.set(key, {
      expiresAt: Date.now() + EMPTY_SNAPSHOT_CACHE_TTL_MS,
      fingerprint,
      snapshot,
    });
  }

  private clearEmptySnapshotCache(repoId: number, worktreePath: string): void {
    this.emptySnapshotCache.delete(this.cacheKey(repoId, worktreePath));
  }
}
