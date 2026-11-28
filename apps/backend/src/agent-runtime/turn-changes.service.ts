import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { relative, resolve, isAbsolute, sep } from 'node:path';
import { and, eq, sql } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDB } from '../database/database.provider.js';
import { turnChanges } from '../database/schema/turn-changes.schema.js';
import type { ClaudeTranscriptItem } from '../claude-runtime/claude-runtime.types.js';
import {
  UNKNOWN_IGNORED_FILE_BASELINE,
  type TurnChangeDetails,
  type TurnChangedFile,
  type TurnToolEvidence,
} from './turn-change-stats.js';
import {
  claudeEdit,
  claudeShell,
  codexPatch,
  matchingPatch,
  openCodeEdits,
  reportedPatch,
  MAX_EVIDENCE_BYTES,
  object,
} from './turn-change-evidence.js';
import {
  ChangeContentBudget,
  WorktreeChangeTracker,
  type WorktreeTurnCapture,
  type WorktreeCommandCapture,
} from './worktree-change-tracker.js';
import { safeRelativePath } from './worktree-change-observer.js';

interface CommandObservation {
  window: WorktreeCommandCapture;
  toolName: string;
  native?: TurnChangedFile[];
  shared?: boolean;
  pending?: Promise<void>;
}

export interface TurnChangeCapture {
  id: string;
  sessionId: number;
  provider: string;
  root: string;
  trackerKey?: string;
  displayRoot?: string;
  cwd: string;
  startedAt: string;
  tracker?: WorktreeChangeTracker;
  turn?: WorktreeTurnCapture;
  error?: string;
  cancelled?: boolean;
  accepting: boolean;
  tools: Map<string, TurnToolEvidence>;
  commands: Map<string, CommandObservation>;
  evidenceBytes: number;
  partial?: true;
  providerSessionId?: string;
  claudeTools: Map<string, string>;
}

@Injectable()
export class TurnChangesService implements OnModuleDestroy {
  private readonly logger = new Logger(TurnChangesService.name);
  private readonly budget = new ChangeContentBudget();
  private readonly trackers = new Map<string, Promise<WorktreeChangeTracker>>();
  private readonly roots = new Map<string, string>();
  private readonly idle = new Map<string, NodeJS.Timeout>();
  private readonly active = new Map<number, TurnChangeCapture>();
  private destroyed = false;

  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDB) {}

  async begin(
    sessionId: number,
    provider: string,
    cwd: string,
    providerSessionId?: string | null,
  ): Promise<TurnChangeCapture> {
    const capture: TurnChangeCapture = {
      id: `turn-changes:${randomUUID()}`,
      sessionId,
      provider,
      root: cwd,
      cwd,
      startedAt: new Date().toISOString(),
      accepting: true,
      tools: new Map(),
      commands: new Map(),
      evidenceBytes: 0,
      claudeTools: new Map(),
      ...(providerSessionId && providerSessionId !== '-1'
        ? { providerSessionId }
        : {}),
    };
    this.cancelSession(sessionId);
    this.active.set(sessionId, capture);
    try {
      const canonical = await realpath(cwd);
      const key =
        this.roots.get(canonical) ??
        (await WorktreeChangeTracker.resolveRoot(canonical));
      if (this.roots.size >= 256) this.roots.clear();
      this.roots.set(canonical, key);
      capture.displayRoot = resolve(cwd, relative(canonical, key));
      capture.trackerKey = key;
      capture.root = key;
      this.clearIdle(key);
      let pending = this.trackers.get(key);
      if (!pending) {
        pending = WorktreeChangeTracker.create(key, this.budget);
        this.trackers.set(key, pending);
        void pending.catch(() => {
          if (this.trackers.get(key) === pending) this.trackers.delete(key);
        });
      }
      capture.tracker = await pending;
      capture.turn = await capture.tracker.begin();
      capture.root = capture.tracker.root;
      if (this.destroyed || capture.cancelled)
        capture.tracker.cancel(capture.turn);
    } catch (error) {
      capture.error = 'The starting worktree state could not be captured.';
      this.logger.warn(
        `Could not begin turn change capture for session ${sessionId}: ${String(error)}`,
      );
    }
    return capture;
  }

  recordCodexPatch(
    capture: TurnChangeCapture | undefined,
    toolId: string,
    providerTurnId: string | undefined,
    changes: unknown,
  ): void {
    if (
      !this.accepts(capture, toolId) ||
      capture.tools.has(`provider:${toolId}`)
    )
      return;
    const delta = codexPatch(changes, toolId, capture.root, capture.cwd);
    if (delta.partial) capture.partial = true;
    this.recordEdits(
      capture,
      toolId,
      'Apply patch',
      delta.files,
      providerTurnId,
    );
  }

  startCodexEdit(
    capture: TurnChangeCapture | undefined,
    toolId: string,
    changes: unknown,
  ): void {
    if (!this.accepts(capture, toolId) || !Array.isArray(changes)) return;
    const paths = new Set<string>();
    for (const value of changes.slice(0, 64)) {
      const change = object(value);
      for (const path of [change.path, object(change.kind).move_path]) {
        const local = this.workspacePath(capture, path);
        if (local) paths.add(local);
      }
    }
    if (paths.size)
      void this.startCommand(capture, toolId, 'Apply patch', [...paths]);
  }

  startCommand(
    capture: TurnChangeCapture | undefined,
    toolId: string,
    toolName: string,
    targets?: readonly string[],
    beforeExecution = false,
  ): Promise<void> | undefined {
    if (
      !this.accepts(capture, toolId) ||
      !capture.turn ||
      !capture.tracker ||
      capture.commands.has(toolId)
    )
      return;
    if (capture.commands.size >= 64) {
      capture.partial = true;
      return;
    }
    const window = capture.tracker.beginCommand(
      capture.turn,
      targets,
      beforeExecution,
    );
    if (!window) return;
    capture.commands.set(toolId, { window, toolName });
    return window.baselineReady.catch(() => {
      capture.partial = true;
    });
  }

  endCommand(
    capture: TurnChangeCapture | undefined,
    toolId: string,
    outcome: 'completed' | 'failed' | 'interrupted' = 'completed',
  ): Promise<void> | undefined {
    if (!this.accepts(capture, toolId)) return;
    const command = capture.commands.get(toolId);
    if (!command || !capture.tracker) return;
    if (!command.pending)
      command.pending = this.closeCommand(capture, toolId, command, outcome);
    return command.pending;
  }

  startEditor(
    capture: TurnChangeCapture | undefined,
    toolId: string,
    name: string,
    input: unknown,
    cwd?: string,
    beforeExecution = false,
  ): Promise<void> | undefined {
    if (!this.accepts(capture, toolId)) return;
    const args = object(input);
    const path =
      args.file_path ??
      args.filePath ??
      args.notebook_path ??
      args.notebookPath ??
      args.path;
    const local = this.workspacePath(capture, path, cwd);
    return local
      ? this.startCommand(capture, toolId, name, [local], beforeExecution)
      : undefined;
  }

  private workspacePath(
    capture: TurnChangeCapture,
    path: unknown,
    cwd = capture.cwd,
  ): string | undefined {
    if (typeof path !== 'string' || !path || path.length > 1000) return;
    const local = relative(capture.root, resolve(cwd, path))
      .split(sep)
      .join('/');
    return local.length <= 1000 && !isAbsolute(local) && safeRelativePath(local)
      ? local
      : undefined;
  }

  piToolEnd(
    capture: TurnChangeCapture | undefined,
    toolId: string,
    result: unknown,
    failed: boolean,
  ): void {
    if (!this.accepts(capture, toolId)) return;
    const command = capture.commands.get(toolId);
    const path = command?.window.targets?.values().next().value;
    if (!failed && command && path && command.toolName === 'Edit') {
      const patch = reportedPatch(
        path,
        object(object(result).details).patch,
        toolId,
        command.toolName,
        capture.root,
        capture.root,
      );
      if (patch) this.recordEdits(capture, toolId, command.toolName, [patch]);
    }
    void this.endCommand(capture, toolId, failed ? 'failed' : 'completed');
  }

  openCodeTool(
    capture: TurnChangeCapture | undefined,
    toolId: string,
    name: string,
    kind: string | undefined,
    status: 'running' | 'completed' | 'error',
    input: unknown,
    metadata: unknown,
    messageId: string,
  ): void {
    if (!this.accepts(capture, toolId)) return;
    const editor =
      kind === 'edit' ||
      kind === 'write' ||
      kind === 'file_changes' ||
      kind === 'notebook_edit';
    if (status === 'running') {
      if (kind === 'bash') void this.startCommand(capture, toolId, name);
      else if (kind === 'file_changes') {
        const patch = object(input).patchText;
        if (typeof patch === 'string' && patch.length <= 128 * 1024) {
          const paths = new Set<string>();
          for (const match of patch.matchAll(
            /^\*\*\* (?:(?:Add|Update|Delete) File|Move to): (.+)$/gm,
          )) {
            const path = this.workspacePath(capture, match[1].trimEnd());
            if (path) paths.add(path);
            if (paths.size >= 128) break;
          }
          if (paths.size)
            void this.startCommand(capture, toolId, name, [...paths]);
        }
      } else if (editor) void this.startEditor(capture, toolId, name, input);
      return;
    }
    if (
      status === 'completed' &&
      editor &&
      !capture.tools.has(`provider:${toolId}`)
    )
      this.recordEdits(
        capture,
        toolId,
        name,
        openCodeEdits(metadata, toolId, name, capture.root, capture.cwd),
        messageId,
      );
    void this.endCommand(
      capture,
      toolId,
      status === 'error' ? 'failed' : 'completed',
    );
  }

  private recordEdits(
    capture: TurnChangeCapture,
    toolId: string,
    toolName: string,
    files: TurnChangedFile[],
    providerTurnId?: string,
  ): void {
    capture.tracker?.notePaths(files.map((file) => file.path));
    this.retain(capture, {
      kind: 'provider',
      toolId,
      toolName,
      providerTurnId,
      files,
    });
  }

  /** SDK hooks are scoped to the runtime session. They run before the actual tool
   * and after its receipt, independently of when assistant text is streamed. */
  async claudeTool(
    sessionId: number,
    input: {
      hook_event_name: string;
      session_id: string;
      tool_use_id: string;
      tool_name: string;
      cwd: string;
      tool_input: unknown;
      tool_response?: unknown;
      is_interrupt?: boolean;
    },
  ): Promise<void> {
    const capture = this.forSession(sessionId, 'claude');
    const toolId = input.tool_use_id;
    if (!this.accepts(capture, toolId)) return;
    if (
      capture.providerSessionId &&
      capture.providerSessionId !== input.session_id
    )
      return;
    const shell =
      input.tool_name === 'Bash' || input.tool_name === 'PowerShell';
    if (input.hook_event_name === 'PreToolUse') {
      if (capture.claudeTools.has(toolId)) return;
      if (capture.claudeTools.size >= 128) {
        capture.partial = true;
        return;
      }
      capture.providerSessionId ??= input.session_id;
      capture.claudeTools.set(toolId, input.tool_name);
      if (shell && object(input.tool_input).run_in_background !== true)
        await this.startCommand(
          capture,
          toolId,
          input.tool_name,
          undefined,
          true,
        );
      else if (!shell)
        await this.startEditor(
          capture,
          toolId,
          input.tool_name,
          input.tool_input,
          input.cwd,
          true,
        );
      return;
    }
    if (capture.claudeTools.get(toolId) !== input.tool_name) return;
    capture.claudeTools.delete(toolId);
    if (shell) {
      const response = object(input.tool_response);
      const command = capture.commands.get(toolId);
      if (
        object(input.tool_input).run_in_background === true ||
        response.backgroundTaskId ||
        response.backgroundedByUser ||
        response.assistantAutoBackgrounded
      ) {
        if (command) capture.tracker?.discardCommand(command.window);
        return;
      }
      const { files, partial, shared } = claudeShell(
        response,
        input.tool_name,
        toolId,
        capture.root,
        input.cwd,
      );
      if (partial) capture.partial = true;
      if (command) {
        command.native = files;
        command.shared = shared;
        await this.endCommand(
          capture,
          toolId,
          input.is_interrupt
            ? 'interrupted'
            : input.hook_event_name === 'PostToolUseFailure' ||
                response.interrupted
              ? 'failed'
              : 'completed',
        );
      } else if (files.length) {
        this.retain(capture, {
          kind: 'command',
          toolId,
          toolName: input.tool_name,
          files,
        });
      }
      return;
    }
    if (input.hook_event_name === 'PostToolUse') {
      const delta = claudeEdit(
        input.tool_response,
        input.tool_name,
        toolId,
        capture.root,
        input.cwd,
      );
      if (delta.partial && !capture.commands.has(toolId))
        capture.partial = true;
      this.recordEdits(capture, toolId, input.tool_name, delta.files);
    }
    await this.endCommand(
      capture,
      toolId,
      input.is_interrupt
        ? 'interrupted'
        : input.hook_event_name === 'PostToolUseFailure'
          ? 'failed'
          : 'completed',
    );
  }

  forSession(
    sessionId: number,
    provider: string,
  ): TurnChangeCapture | undefined {
    const capture = this.active.get(sessionId);
    return capture?.provider === provider ? capture : undefined;
  }

  private accepts(
    capture: TurnChangeCapture | undefined,
    toolId: string,
  ): capture is TurnChangeCapture {
    return (
      !!capture?.accepting &&
      !capture.cancelled &&
      !this.destroyed &&
      this.active.get(capture.sessionId) === capture &&
      typeof toolId === 'string' &&
      !!toolId &&
      toolId.length <= 512
    );
  }

  private async closeCommand(
    capture: TurnChangeCapture,
    toolId: string,
    command: CommandObservation,
    outcome: string,
  ): Promise<void> {
    const window = { start: command.window.started, end: Date.now() };
    try {
      const local = await capture.tracker!.endCommand(command.window);
      if (local.partial) capture.partial = true;
      const direct = new Map(
        capture.tools
          .get(`provider:${toolId}`)
          ?.files.map((file) => [file.path, file]),
      );
      const files = new Map(
        local.files
          .filter((file) => {
            const confirmed = direct.get(file.path);
            return !confirmed || !matchingPatch(file, confirmed);
          })
          .map((file) => [file.path, file]),
      );
      for (const file of command.native ?? []) {
        // A native inline diff usually has the tighter execution window. Keep a
        // local patch when Claude supplied only path metadata, and fill gaps.
        const observed = files.get(file.path);
        if (
          observed &&
          file.hunks.length &&
          observed.hunks.some((hunk) => hunk.patch) &&
          !matchingPatch(observed, file)
        ) {
          // Both are observations. Keep the earlier native diff and the local
          // version when their changed lines disagree, with one file total.
          files.set(file.path, {
            ...file,
            attribution: 'shared',
            hunks: [
              ...file.hunks.map((hunk) => ({
                ...hunk,
                evidenceLabel: 'Provider observation',
              })),
              ...observed.hunks.map((hunk) => ({
                ...hunk,
                evidenceLabel: 'Local observation',
              })),
            ],
          });
        } else if (file.hunks.length || !observed) {
          files.set(file.path, {
            ...file,
            observationKey: observed?.observationKey,
          });
        }
      }
      const shared = command.shared || command.window.shared;
      if (shared)
        for (const file of files.values()) file.attribution = 'shared';
      this.retain(capture, {
        kind: 'command',
        toolId,
        window,
        toolName:
          outcome === 'completed'
            ? command.toolName
            : `${command.toolName} (${outcome})`,
        files: [...files.values()],
      });
    } catch {
      capture.partial = true;
      this.retain(capture, {
        kind: 'command',
        toolId,
        toolName: command.toolName,
        files: command.native ?? [],
      });
    } finally {
      command.native = undefined;
    }
  }

  private retain(capture: TurnChangeCapture, evidence: TurnToolEvidence): void {
    if (capture.cancelled || !evidence.files.length) return;
    const key = `${evidence.kind}:${evidence.toolId}`;
    if (capture.tools.has(key)) return;
    if (capture.tools.size >= 128) {
      capture.partial = true;
      return;
    }
    const files: TurnChangedFile[] = [];
    for (const file of evidence.files.slice(0, 256)) {
      const size = Buffer.byteLength(JSON.stringify(file)) + 1;
      if (capture.evidenceBytes + size > MAX_EVIDENCE_BYTES) {
        capture.partial = true;
        break;
      }
      capture.evidenceBytes += size;
      files.push(file);
    }
    if (files.length < evidence.files.length) capture.partial = true;
    if (files.length) capture.tools.set(key, { ...evidence, files });
  }

  async finish(
    capture: TurnChangeCapture | undefined,
    conversationId: string | null | undefined,
  ): Promise<ClaudeTranscriptItem | undefined> {
    if (!capture) return;
    capture.accepting = false;
    // An unfinished invocation has no trustworthy command end boundary.
    for (const command of capture.commands.values())
      if (!command.pending) {
        capture.tracker?.discardCommand(command.window);
        capture.partial = true;
      }
    let details: TurnChangeDetails;
    try {
      if (capture.cancelled || this.destroyed) return;
      if (!capture.tracker || !capture.turn) throw new Error(capture.error);
      const commandWork = Promise.all(
        [...capture.commands.values()].map((command) => command.pending),
      );
      details = await capture.tracker.finish(capture.turn, commandWork);
    } catch (error) {
      this.logger.warn(
        `Could not finish turn change capture for session ${capture.sessionId}: ${String(error)}`,
      );
      details = {
        files: 0,
        additions: 0,
        deletions: 0,
        filesChanged: [],
        capture: {
          root: capture.root,
          complete: false,
          shared: capture.turn?.shared ?? false,
          message:
            capture.error ?? 'The net worktree changes could not be captured.',
        },
      };
    } finally {
      if (this.active.get(capture.sessionId) === capture)
        this.active.delete(capture.sessionId);
      this.retireIdle();
    }
    if (
      capture.cancelled ||
      this.destroyed ||
      !conversationId ||
      conversationId === '-1'
    )
      return;
    if (
      details.capture &&
      capture.displayRoot &&
      capture.displayRoot !== details.capture.root
    )
      details.capture.aliases = [capture.displayRoot];
    details.evidence = {
      version: 1,
      tools: [...capture.tools.values()],
      ...(capture.partial ? { partial: true } : {}),
    };
    const finishedAt = new Date().toISOString();
    try {
      await this.db.insert(turnChanges).values({
        id: capture.id,
        sessionId: capture.sessionId,
        provider: capture.provider,
        conversationId,
        startedAt: capture.startedAt,
        finishedAt,
        details,
        summary: this.summarize(details),
      });
    } catch (error) {
      this.logger.warn(
        `Could not persist turn changes for session ${capture.sessionId}: ${String(error)}`,
      );
      details.capture = {
        root: capture.root,
        complete: false,
        shared: details.capture?.shared ?? false,
        message:
          'Changes are available now, but could not be saved to conversation history.',
      };
    }
    return {
      id: capture.id,
      kind: 'system',
      isSynthetic: true,
      timestamp: finishedAt,
      turnChanges: details,
    };
  }

  private summarize(details: TurnChangeDetails): TurnChangeDetails {
    const files = details.filesChanged.filter(
      (file) => file.diffUnavailable !== UNKNOWN_IGNORED_FILE_BASELINE,
    );
    return {
      summaryOnly: true,
      files: files.length,
      additions: files.reduce((count, file) => count + file.additions, 0),
      deletions: files.reduce((count, file) => count + file.deletions, 0),
      filesChanged: files.slice(0, 200).map((file) => ({ ...file, hunks: [] })),
      capture: details.capture
        ? { ...details.capture, unchangedPaths: undefined }
        : undefined,
      evidence: details.evidence
        ? {
            ...details.evidence,
            tools: [],
            sources: [
              ...new Set(details.evidence.tools.map((tool) => tool.kind)),
            ],
          }
        : undefined,
    };
  }

  async reviewDetails(
    sessionId: number,
    provider: string,
    markerId: string,
  ): Promise<TurnChangeDetails | undefined> {
    const [stored] = await this.db
      .select({ details: turnChanges.details })
      .from(turnChanges)
      .where(
        and(
          eq(turnChanges.sessionId, sessionId),
          eq(turnChanges.provider, provider),
          eq(turnChanges.id, markerId),
        ),
      )
      .limit(1);
    return stored?.details;
  }

  async attachHistory(
    sessionId: number,
    provider: string,
    conversationId: string | null | undefined,
    history: ClaudeTranscriptItem[],
    mode: 'full' | 'summary' = 'full',
  ): Promise<ClaudeTranscriptItem[]> {
    if (!conversationId || !history.length) return history;
    const records = await this.db
      .select({
        id: turnChanges.id,
        startedAt: turnChanges.startedAt,
        finishedAt: turnChanges.finishedAt,
        details:
          mode === 'summary'
            ? sql<TurnChangeDetails>`coalesce(${turnChanges.summary}, ${turnChanges.details})`.mapWith(
                turnChanges.details,
              )
            : turnChanges.details,
      })
      .from(turnChanges)
      .where(
        and(
          eq(turnChanges.sessionId, sessionId),
          eq(turnChanges.provider, provider),
          eq(turnChanges.conversationId, conversationId),
        ),
      )
      .orderBy(turnChanges.startedAt);
    if (!records.length) return history;
    // Filter markers belonging to turns removed by a rewind. Source timestamps
    // survive reloads; conversation IDs prevent captures leaking across resets.
    const timestamps = history
      .filter((item) => !item.isSynthetic)
      .map((item) => item.timestamp)
      .sort();
    const markers: ClaudeTranscriptItem[] = [];
    let cursor = 0;
    for (const record of records) {
      while (
        cursor < timestamps.length &&
        timestamps[cursor] < record.startedAt
      )
        cursor++;
      if (cursor >= timestamps.length || timestamps[cursor] > record.finishedAt)
        continue;
      markers.push({
        id: record.id,
        kind: 'system',
        isSynthetic: true,
        timestamp: record.finishedAt,
        turnChanges: record.details,
      });
    }
    const existing = new Set(history.map((item) => item.id));
    return [
      ...history,
      ...markers.filter((item) => !existing.has(item.id)),
    ].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  }

  cancelSession(sessionId: number): void {
    const capture = this.active.get(sessionId);
    if (capture) {
      capture.cancelled = true;
      if (capture.turn) capture.tracker?.cancel(capture.turn);
      this.active.delete(sessionId);
    }
    this.retireIdle();
  }

  private clearIdle(key: string): void {
    const timer = this.idle.get(key);
    if (timer) clearTimeout(timer);
    this.idle.delete(key);
  }

  private retireIdle(): void {
    for (const [key, tracker] of this.trackers) {
      if (
        [...this.active.values()].some((capture) => capture.trackerKey === key)
      )
        continue;
      if (this.idle.has(key)) continue;
      const timer = setTimeout(
        () => {
          this.idle.delete(key);
          if (this.trackers.get(key) !== tracker) return;
          this.trackers.delete(key);
          void tracker.then((value) => value.close()).catch(() => undefined);
        },
        this.idle.size >= 4 ? 0 : 60_000,
      );
      timer.unref();
      this.idle.set(key, timer);
    }
  }

  async onModuleDestroy(): Promise<void> {
    this.destroyed = true;
    for (const timer of this.idle.values()) clearTimeout(timer);
    for (const capture of this.active.values()) capture.cancelled = true;
    await Promise.allSettled(
      [...this.trackers.values()].map(async (pending) =>
        (await pending).close(),
      ),
    );
    this.trackers.clear();
    this.roots.clear();
    this.idle.clear();
    this.active.clear();
  }
}
