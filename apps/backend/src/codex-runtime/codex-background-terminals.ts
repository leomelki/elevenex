import { ConflictException } from '@nestjs/common';
import { setTimeout as delay } from 'node:timers/promises';
import type { ClaudeBackgroundWorkItem } from '../claude-runtime/claude-runtime.types.js';
import type { CodexAppServerClient } from './codex-app-server.js';
import { record, textValue } from './codex-subagents.js';

const LIST_METHOD = 'thread/backgroundTerminals/list';
const REQUEST_TIMEOUT_MS = 3_000;
const POLL_INTERVAL_MS = 5_000;
const PAGE_SIZE = 64;
const MAX_PAGES = 4;

interface WatchedThread {
  sessionId: number;
  threadId: string;
  awaitingTurnEnd: boolean;
  items: Map<string, ClaudeBackgroundWorkItem>;
  timer?: NodeJS.Timeout;
  reading?: Promise<void>;
  refreshRequested: boolean;
  stopping?: Promise<void>;
}

/** Owns live provider terminals and the app-server references that keep them alive. */
export class CodexBackgroundTerminals {
  private readonly threads = new Map<string, WatchedThread>();

  constructor(
    private readonly server: CodexAppServerClient,
    private readonly onChange: (sessionId: number) => void,
  ) {}

  observe(
    sessionId: number,
    threadId: string,
    method: 'item/started' | 'item/completed',
    item: Record<string, unknown>,
  ): void {
    const watch = this.threads.get(threadId);
    if (watch && (watch.sessionId !== sessionId || watch.stopping)) return;

    // The start event only tells us which thread to inspect. A live list after
    // the turn tells us whether the command actually outlived it.
    const startup =
      item.type === 'commandExecution' &&
      item.source === 'unifiedExecStartup' &&
      textValue(item.processId);
    if (method === 'item/started' && startup) {
      if (watch) watch.awaitingTurnEnd = true;
      else {
        this.server.addRef();
        this.threads.set(threadId, {
          sessionId,
          threadId,
          awaitingTurnEnd: true,
          items: new Map(),
          refreshRequested: false,
        });
      }
    } else if (
      watch &&
      method === 'item/completed' &&
      startup &&
      (watch.reading || watch.items.size)
    ) {
      this.refresh(watch);
    }
  }

  turnFinished(threadId: string): void {
    const watch = this.threads.get(threadId);
    if (!watch?.awaitingTurnEnd || watch.stopping) return;
    watch.awaitingTurnEnd = false;
    this.refresh(watch);
  }

  work(sessionId: number): ClaudeBackgroundWorkItem[] {
    return [...this.threads.values()]
      .filter((watch) => watch.sessionId === sessionId)
      .flatMap((watch) => [...watch.items.values()]);
  }

  threadClosed(threadId: string): void {
    const watch = this.threads.get(threadId);
    if (watch) this.remove(watch);
  }

  clear(publish: boolean): void {
    const changed = new Set<number>();
    for (const watch of this.threads.values()) {
      if (publish && watch.items.size) changed.add(watch.sessionId);
      this.remove(watch, false);
    }
    for (const sessionId of changed) this.onChange(sessionId);
  }

  async stopSession(sessionId: number): Promise<void> {
    const watches = [...this.threads.values()].filter(
      (watch) => watch.sessionId === sessionId,
    );
    const results = await Promise.allSettled(
      watches.map((watch) => {
        watch.stopping ??= this.stop(watch).finally(() => {
          watch.stopping = undefined;
          if (this.isCurrent(watch)) this.schedule(watch);
        });
        return watch.stopping;
      }),
    );
    for (const result of results)
      if (result.status === 'rejected') throw result.reason;
  }

  private async stop(watch: WatchedThread): Promise<void> {
    clearTimeout(watch.timer);
    await watch.reading;
    if (!this.isCurrent(watch)) return;
    let listSupported = false;
    try {
      const { data } = await this.readPage(watch.threadId, 1);
      if (!this.isCurrent(watch)) return;
      listSupported = true;
      if (data.length) {
        await this.server.request(
          'thread/backgroundTerminals/clean',
          { threadId: watch.threadId },
          REQUEST_TIMEOUT_MS,
        );
        // Clean acknowledges a queued operation. Confirm the live list is
        // empty before allowing archive or worktree release.
        const deadline = Date.now() + REQUEST_TIMEOUT_MS;
        do {
          if (!this.isCurrent(watch)) return;
          const { data: remaining } = await this.readPage(watch.threadId, 1);
          if (!this.isCurrent(watch)) return;
          if (!remaining.length) {
            this.remove(watch);
            return;
          }
          await delay(100);
        } while (Date.now() < deadline);
        throw new Error('Background terminals are still running');
      }
    } catch (error) {
      if (!this.isCurrent(watch)) return;
      if (
        !threadUnavailable(error) &&
        (listSupported || watch.items.size || !methodUnavailable(error))
      )
        throw new ConflictException(
          'Codex has not confirmed that its background commands stopped. Retry stopping this session.',
          { cause: error },
        );
    }
    this.remove(watch);
  }

  private refresh(watch: WatchedThread): void {
    if (!this.isCurrent(watch) || watch.stopping) return;
    if (watch.reading) {
      watch.refreshRequested = true;
      return;
    }
    clearTimeout(watch.timer);
    watch.refreshRequested = false;
    watch.reading = this.reconcile(watch).finally(() => {
      watch.reading = undefined;
      if (this.isCurrent(watch) && !watch.stopping) {
        if (watch.refreshRequested) this.refresh(watch);
        else if (watch.items.size || !watch.awaitingTurnEnd)
          this.schedule(watch);
      }
    });
  }

  private async reconcile(watch: WatchedThread): Promise<void> {
    const items = new Map<string, ClaudeBackgroundWorkItem>();
    const observedAt = new Date().toISOString();
    try {
      let cursor: string | undefined;
      for (let page = 0; page < MAX_PAGES; page++) {
        const { data, nextCursor } = await this.readPage(
          watch.threadId,
          PAGE_SIZE,
          cursor,
        );
        if (!this.isCurrent(watch) || watch.stopping) return;
        for (const terminal of data) {
          const id = `task:${watch.threadId}:${terminal.processId}`;
          const label =
            terminal.command.trim().slice(0, 200) || 'Background command';
          const previous = watch.items.get(id);
          items.set(
            id,
            previous?.label === label
              ? previous
              : {
                  id,
                  kind: 'task',
                  label,
                  startedAt: previous?.startedAt ?? observedAt,
                  updatedAt: observedAt,
                },
          );
        }
        if (!nextCursor || nextCursor === cursor) break;
        cursor = nextCursor;
      }
    } catch (error) {
      if (
        this.isCurrent(watch) &&
        !watch.stopping &&
        (threadUnavailable(error) ||
          (!watch.items.size && methodUnavailable(error)))
      )
        this.remove(watch);
      return;
    }
    const changed =
      items.size !== watch.items.size ||
      [...items].some(([id, item]) => watch.items.get(id) !== item);
    watch.items = items;
    if (changed) this.onChange(watch.sessionId);
    if (!items.size && !watch.awaitingTurnEnd && !watch.refreshRequested)
      this.remove(watch);
  }

  private schedule(watch: WatchedThread): void {
    watch.timer = setTimeout(() => this.refresh(watch), POLL_INTERVAL_MS);
    watch.timer.unref();
  }

  private async readPage(threadId: string, limit: number, cursor?: string) {
    const response = record(
      await this.server.request(
        LIST_METHOD,
        { threadId, limit, ...(cursor ? { cursor } : {}) },
        REQUEST_TIMEOUT_MS,
      ),
    );
    if (!Array.isArray(response.data) || response.data.length > limit)
      throw new Error('Invalid Codex background terminal list');
    const data = response.data.map((value: unknown) => {
      const item = record(value);
      const processId = textValue(item.processId);
      if (
        !processId ||
        processId.length > 100 ||
        typeof item.command !== 'string'
      )
        throw new Error('Invalid Codex background terminal');
      return { processId, command: item.command };
    });
    return { data, nextCursor: textValue(response.nextCursor) };
  }

  private isCurrent(watch: WatchedThread): boolean {
    return this.threads.get(watch.threadId) === watch;
  }

  private remove(watch: WatchedThread, publish = true): void {
    this.threads.delete(watch.threadId);
    clearTimeout(watch.timer);
    this.server.release();
    if (publish && watch.items.size) this.onChange(watch.sessionId);
  }
}

function threadUnavailable(error: unknown): boolean {
  return (
    error instanceof Error &&
    /^(?:thread not found(?:: .+)?|thread .+ (?:is )?not loaded)$/i.test(
      error.message,
    )
  );
}

function methodUnavailable(error: unknown): boolean {
  return (
    error instanceof Error &&
    /^(?:invalid request: )?(?:method not found|unknown method|unknown variant)/i.test(
      error.message,
    )
  );
}
