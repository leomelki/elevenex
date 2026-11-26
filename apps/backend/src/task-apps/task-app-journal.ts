import { Inject, Injectable } from '@nestjs/common';
import { and, count, desc, eq, inArray, lte } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import { lstat, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { TaskAppRun } from '@elevenex/shared';
import { DRIZZLE, type DrizzleDB } from '../database/database.provider.js';
import { taskAppJournal as journal } from '../database/schema/index.js';
import { launchFingerprint, type AppLaunch } from './app-launch.js';
import { supervisorBirth, supervisorBoot } from './supervisor-identity.js';
import { windowsAppJobDrained } from './windows-display.js';

type Row = typeof journal.$inferSelect;
type End = Exclude<
  Row['phase'],
  'pending' | 'reserved' | 'executing' | 'cleaning'
>;
const retention = 30 * 24 * 60 * 60_000;
const MAX_HISTORY_PER_TASK = 1024;
const MAX_HISTORY_TOTAL = 16384;
const RECOVERY_DETAIL =
  'The previous app supervisor may still be draining. Retry Stop app. If it persists, restart the task machine and retry.';
const hash = (text: string) => createHash('sha256').update(text).digest('hex');

export function appRunDirectory(runId: string): string {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
      runId,
    )
  )
    throw new Error('Invalid app run identity');
  return join(tmpdir(), 'elevenex-app-run-' + runId);
}

function restored(row: Row): TaskAppRun {
  const detail: Record<Row['phase'], string> = {
    pending: 'The launch request belongs to another engine.',
    reserved: 'Reclaiming the interrupted launch reservation.',
    executing: RECOVERY_DETAIL,
    cleaning: 'Reclaiming the interrupted run’s scratch directory.',
    cancelled: 'Launch request cancelled.',
    expired: 'The launch request expired without starting.',
    stopped: 'Stopped.',
    failed: 'App failed. Output was held by its original engine.',
    exited: 'App exited.',
    interrupted:
      'The original engine disconnected. The run ended with an unknown outcome.',
  };
  const phase = row.phase;
  return {
    runId: row.runId,
    taskId: row.taskId,
    name: 'App run ' + row.runId.slice(0, 8),
    mode: row.mode,
    startedAt: row.startedAt,
    status:
      phase === 'executing' || phase === 'reserved' || phase === 'cleaning'
        ? 'stopping'
        : ['pending', 'interrupted', 'failed'].includes(phase)
          ? 'failed'
          : 'exited',
    detail: detail[phase],
  };
}

/** SQLite owns request receipts. Process capabilities, arguments and output stay
 * in the live host. Indexed synchronous transactions are bounded to admission
 * and terminal state changes and never run per frame, input event or log chunk. */
@Injectable()
export class TaskAppJournal {
  private readonly recovering = new Map<
    string,
    { row: Row; nextCheck: number; probe?: Promise<boolean> }
  >();

  private boot?: Promise<string>;
  private readonly bootIdentity = () => {
    // The boot identity is immutable for this backend's lifetime. Coalesce
    // concurrent launches and avoid repeated macOS sysctl calls during drain.
    this.boot ??= supervisorBoot().catch((error) => {
      this.boot = undefined;
      throw error;
    });
    return this.boot;
  };

  private async fromPreviousBoot(birth: string | null): Promise<boolean> {
    const boot = birth?.match(/^(linux|darwin):([a-f0-9-]{36}):/);
    return !!boot && boot[1] + ':' + boot[2] !== (await this.bootIdentity());
  }

  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDB) {
    // The backend lifetime owns these private callbacks and stdin pipes. No UI
    // state can revive an old approval. A reserved run never received a GO.
    const previous = db.transaction((tx) => {
      const until = Date.now() + retention;
      tx.update(journal)
        .set({ phase: 'expired', expiresAt: until })
        .where(eq(journal.phase, 'pending'))
        .run();
      return tx
        .select()
        .from(journal)
        .where(inArray(journal.phase, ['reserved', 'executing', 'cleaning']))
        .all();
    });
    for (const row of previous)
      this.recovering.set(row.runId, { row, nextCheck: 0 });
  }

  lookup(request: AppLaunch): TaskAppRun | undefined {
    const row = this.db
      .select()
      .from(journal)
      .where(
        and(
          eq(journal.taskId, request.taskId),
          eq(journal.requestHash, hash(request.requestId)),
        ),
      )
      .get();
    if (!row) return;
    if (row.launchHash !== hash(launchFingerprint(request)))
      throw new Error('Launch request ID was reused for a different app');
    if (this.recovering.has(row.runId)) void this.probe(row.runId);
    return restored(row);
  }

  /** Insert-or-return the old receipt in the same write transaction. Refuse
   * capacity before evicting an unexpired receipt that a retry might still need. */
  reserve(request: AppLaunch, state: TaskAppRun): TaskAppRun | undefined {
    return this.db.transaction(
      (tx) => {
        const requestHash = hash(request.requestId),
          launchHash = hash(launchFingerprint(request));
        const existing = tx
          .select()
          .from(journal)
          .where(
            and(
              eq(journal.taskId, request.taskId),
              eq(journal.requestHash, requestHash),
            ),
          )
          .get();
        if (existing) {
          if (existing.launchHash !== launchHash)
            throw new Error('Launch request ID was reused for a different app');
          return restored(existing);
        }
        const taskExpired = tx
          .select({ id: journal.runId })
          .from(journal)
          .where(
            and(
              eq(journal.taskId, request.taskId),
              lte(journal.expiresAt, Date.now()),
            ),
          )
          .limit(1)
          .get();
        if (taskExpired)
          tx.delete(journal).where(eq(journal.runId, taskExpired.id)).run();
        const expired = tx
          .select({ id: journal.runId })
          .from(journal)
          .where(lte(journal.expiresAt, Date.now()))
          .limit(64)
          .all();
        if (expired.length)
          tx.delete(journal)
            .where(
              inArray(
                journal.runId,
                expired.map((row) => row.id),
              ),
            )
            .run();
        if (
          tx.select({ n: count() }).from(journal).get()!.n >=
            MAX_HISTORY_TOTAL ||
          tx
            .select({ n: count() })
            .from(journal)
            .where(eq(journal.taskId, request.taskId))
            .get()!.n >= MAX_HISTORY_PER_TASK
        )
          throw new Error(
            'App launch history is full. Unexpired request IDs are retained for 30 days.',
          );
        tx.insert(journal)
          .values({
            runId: state.runId,
            taskId: request.taskId,
            requestHash,
            launchHash,
            startedAt: state.startedAt,
            mode: state.mode,
            phase: state.status === 'requested' ? 'pending' : 'reserved',
          })
          .run();
        return undefined;
      },
      { behavior: 'immediate' },
    );
  }

  approve(runId: string): void {
    const changed = this.db
      .update(journal)
      .set({ phase: 'reserved' })
      .where(and(eq(journal.runId, runId), eq(journal.phase, 'pending')))
      .run();
    if (changed.changes !== 1) throw new Error('App launch request expired.');
  }

  async grant(runId: string, pid: number): Promise<void> {
    const birth = await supervisorBirth(pid, this.bootIdentity);
    if (!birth)
      throw new Error('The app supervisor exited before accepting the launch.');
    // The POSIX helper removes this marker immediately before it can create
    // children and restores it only after the owned tree/group is empty.
    if (process.platform !== 'win32')
      await writeFile(join(appRunDirectory(runId), '.supervisor-drained'), '', {
        flag: 'wx',
        mode: 0o600,
      });
    const changed = this.db
      .update(journal)
      .set({ phase: 'executing', supervisorPid: pid, supervisorBirth: birth })
      .where(and(eq(journal.runId, runId), eq(journal.phase, 'reserved')))
      .run();
    if (changed.changes !== 1)
      throw new Error('App reservation expired before launch.');
  }

  /** Persist proof of process cleanup before deleting its on-disk evidence. */
  async readyToClean(runId: string): Promise<void> {
    const row = this.db
      .select()
      .from(journal)
      .where(eq(journal.runId, runId))
      .get();
    if (!row || row.phase !== 'executing') return;
    if (process.platform === 'win32') {
      // A capture worker's query handle can outlive the supervisor and delay
      // kill-on-close. Confirm the named job has no active processes.
      if (!(await windowsAppJobDrained(runId)))
        throw new Error(RECOVERY_DETAIL);
    } else {
      const marker = await lstat(
        join(appRunDirectory(runId), '.supervisor-drained'),
      ).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return undefined;
        throw error;
      });
      if (
        !(
          marker?.isFile() &&
          marker.size === 0 &&
          marker.uid === process.getuid?.()
        )
      ) {
        // Reused or absent supervisor PIDs alone cannot prove that a forcibly
        // killed POSIX owner drained its descendants. A different boot can.
        if (!(await this.fromPreviousBoot(row.supervisorBirth)))
          throw new Error(RECOVERY_DETAIL);
      }
    }
    this.db
      .update(journal)
      .set({ phase: 'cleaning', supervisorPid: null, supervisorBirth: null })
      .where(and(eq(journal.runId, runId), eq(journal.phase, 'executing')))
      .run();
  }

  finish(runId: string, phase: End): void {
    this.db
      .update(journal)
      .set({
        phase,
        expiresAt: Date.now() + retention,
        supervisorPid: null,
        supervisorBirth: null,
      })
      .where(
        and(
          eq(journal.runId, runId),
          inArray(journal.phase, [
            'reserved',
            'executing',
            'pending',
            'cleaning',
          ]),
        ),
      )
      .run();
  }

  get(taskId: number, runId: string): TaskAppRun | undefined {
    const row = this.db
      .select()
      .from(journal)
      .where(and(eq(journal.runId, runId), eq(journal.taskId, taskId)))
      .get();
    if (row && this.recovering.has(row.runId)) void this.probe(row.runId);
    return row && restored(row);
  }

  list(taskId: number): TaskAppRun[] {
    this.recoveryCount(taskId);
    const recent = this.db
      .select()
      .from(journal)
      .where(eq(journal.taskId, taskId))
      .orderBy(desc(journal.startedAt))
      .limit(128)
      .all();
    const runs = new Map(recent.map((row) => [row.runId, restored(row)]));
    // Keep every prior supervisor visible even if many later runs settled.
    for (const { row } of this.recovering.values()) {
      if (row.taskId === taskId) runs.set(row.runId, restored(row));
    }
    return [...runs.values()];
  }

  /** A stale PID can only delay release. Compare its OS creation identity and
   * never signal or adopt a process using an ID recovered from storage. */
  private probe(runId: string): Promise<boolean> {
    const held = this.recovering.get(runId);
    if (!held) return Promise.resolve(true);
    if (held.probe) return held.probe;
    if (held.nextCheck > Date.now()) return Promise.resolve(false);
    held.nextCheck = Date.now() + 1000;
    held.probe = (async () => {
      const { supervisorPid, supervisorBirth: previous } = held.row;
      if (held.row.phase === 'executing') {
        if (
          !supervisorPid ||
          !previous ||
          (!(await this.fromPreviousBoot(previous)) &&
            (await supervisorBirth(supervisorPid, this.bootIdentity)) ===
              previous)
        )
          return false;
      }
      await this.readyToClean(runId);
      const directory = appRunDirectory(runId);
      const entry = await lstat(directory).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return undefined;
          throw error;
        },
      );
      // A crash can precede scratch allocation. Remove only the private
      // directory this host could have created, including in a shared /tmp.
      const uid = process.getuid?.();
      if (entry?.isDirectory() && (uid === undefined || entry.uid === uid))
        await rm(directory, { recursive: true, force: true, maxRetries: 2 });
      this.finish(
        runId,
        held.row.phase === 'reserved' ? 'cancelled' : 'interrupted',
      );
      this.recovering.delete(runId);
      return true;
    })()
      .catch(() => false)
      .finally(() => {
        held.probe = undefined;
      });
    return held.probe;
  }

  recoveringTasks(): number[] {
    return [...new Set([...this.recovering.values()].map(({ row }) => row.taskId))];
  }

  recoveryCount(taskId?: number): number {
    let active = 0;
    for (const [id, held] of this.recovering) {
      if (taskId !== undefined && held.row.taskId !== taskId) continue;
      active++;
      void this.probe(id);
    }
    return active;
  }

  async drain(taskId: number, runId?: string): Promise<void> {
    const ids = [...this.recovering.values()]
      .filter(
        ({ row }) => row.taskId === taskId && (!runId || row.runId === runId),
      )
      .map(({ row }) => row.runId);
    if (!ids.length) return;
    const deadline = Date.now() + 5000;
    do {
      if ((await Promise.all(ids.map((id) => this.probe(id)))).every(Boolean))
        return;
      await delay(300);
    } while (Date.now() < deadline);
    throw new Error(RECOVERY_DETAIL);
  }
}
