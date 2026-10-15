import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { and, eq } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDB } from '../database/database.provider.js';
import { turnChanges } from '../database/schema/turn-changes.schema.js';
import type { ClaudeTranscriptItem } from '../claude-runtime/claude-runtime.types.js';
import type { TurnChangeDetails } from './turn-change-stats.js';
import {
  ChangeContentBudget,
  WorktreeChangeTracker,
  type WorktreeTurnCapture,
} from './worktree-change-tracker.js';

export interface TurnChangeCapture {
  id: string;
  sessionId: number;
  provider: string;
  root: string;
  trackerKey?: string;
  displayRoot?: string;
  startedAt: string;
  tracker?: WorktreeChangeTracker;
  turn?: WorktreeTurnCapture;
  error?: string;
  cancelled?: boolean;
}

@Injectable()
export class TurnChangesService implements OnModuleDestroy {
  private readonly logger = new Logger(TurnChangesService.name);
  private readonly budget = new ChangeContentBudget();
  private readonly trackers = new Map<string, Promise<WorktreeChangeTracker>>();
  private readonly roots = new Map<string, string>();
  private readonly idle = new Map<string, NodeJS.Timeout>();
  private readonly active = new Set<TurnChangeCapture>();
  private destroyed = false;

  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDB) {}

  async begin(
    sessionId: number,
    provider: string,
    cwd: string,
  ): Promise<TurnChangeCapture> {
    const capture: TurnChangeCapture = {
      id: `turn-changes:${randomUUID()}`,
      sessionId,
      provider,
      root: cwd,
      startedAt: new Date().toISOString(),
    };
    this.active.add(capture);
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
      capture.error =
        'Changes could not be fully captured. Tool-reported edits are still available.';
      this.logger.warn(
        `Could not begin turn change capture for session ${sessionId}: ${String(error)}`,
      );
    }
    return capture;
  }

  async finish(
    capture: TurnChangeCapture | undefined,
    conversationId: string | null | undefined,
  ): Promise<ClaudeTranscriptItem | undefined> {
    if (!capture) return;
    let details: TurnChangeDetails;
    try {
      if (capture.cancelled || this.destroyed) return;
      if (!capture.tracker || !capture.turn) throw new Error(capture.error);
      details = await capture.tracker.finish(capture.turn);
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
            capture.error ??
            'Some changes could not be captured. Tool-reported edits are still available.',
        },
      };
    } finally {
      this.active.delete(capture);
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

  async attachHistory(
    sessionId: number,
    provider: string,
    conversationId: string | null | undefined,
    history: ClaudeTranscriptItem[],
  ): Promise<ClaudeTranscriptItem[]> {
    if (!conversationId || !history.length) return history;
    const records = await this.db
      .select()
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
    for (const capture of this.active)
      if (capture.sessionId === sessionId) {
        capture.cancelled = true;
        if (capture.turn) capture.tracker?.cancel(capture.turn);
        this.active.delete(capture);
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
      if ([...this.active].some((capture) => capture.trackerKey === key))
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
    for (const capture of this.active) capture.cancelled = true;
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
