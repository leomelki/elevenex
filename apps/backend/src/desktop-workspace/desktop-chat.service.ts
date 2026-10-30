import { executeChatAction } from './desktop-chat-actions.js';
import {
  BadRequestException,
  Injectable,
  OnModuleDestroy,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type {
  AgentRuntimeEvent,
  AgentRuntimeProvider,
  AgentTranscriptItem,
} from '../agent-runtime/agent-runtime.types.js';
import { AgentRuntimeRegistryService } from '../agent-runtime/agent-runtime-registry.service.js';
import { SessionsService } from '../sessions/sessions.service.js';
import { chatPlanUsage } from './desktop-chat-usage.js';
import {
  chatState,
  chatWindow,
  display,
  record,
} from './desktop-chat-projection.js';

interface ChatFeed {
  readonly id: string;
  readonly provider: AgentRuntimeProvider;
  readonly stop: () => void;
  readonly waiters: Set<() => void>;
  readonly projections: Map<
    string,
    { readonly json: string; readonly revision: number }
  >;
  revision: number;
  historyRevision: number;
  touched: number;
  attached: boolean;
  runtime?: Promise<Record<string, unknown>>;
  history?: Promise<AgentTranscriptItem[]>;
}

/** Only selected conversations are observed. Idle feeds expire and never hydrate sidebar sessions. */
@Injectable()
export class DesktopChatService implements OnModuleDestroy {
  private readonly feeds = new Map<number, ChatFeed>();
  private readonly expiry = setInterval(() => {
    for (const [id, feed] of this.feeds)
      if (Date.now() - feed.touched > 30000 && !feed.waiters.size)
        this.release(id);
  }, 10000).unref();
  constructor(
    private readonly sessions: SessionsService,
    private readonly registry: AgentRuntimeRegistryService,
  ) {}

  onModuleDestroy(): void {
    clearInterval(this.expiry);
    for (const id of this.feeds.keys()) this.release(id);
  }

  private release(id: number): void {
    const feed = this.feeds.get(id);
    if (!feed) return;
    this.feeds.delete(id);
    feed.stop();
    for (const wake of feed.waiters) wake();
  }

  private async target(taskId: number, sessionId: number) {
    const session = await this.sessions.findOne(sessionId);
    if (session.workspaceId !== taskId || session.surface !== 'session')
      throw new BadRequestException('Session does not belong to this task.');
    return session;
  }

  private state(
    session: Awaited<ReturnType<SessionsService['findOne']>>,
    raw: Record<string, unknown>,
  ) {
    const provider = this.registry.getProvider(session.activeAgentProvider);
    return {
      controls: {
        plan: typeof provider.setPlanMode === 'function',
        reasoning: typeof provider.setReasoningEffort === 'function',
        fast: typeof provider.setFastMode === 'function',
      },
      ...chatState(
        raw,
        session.activeAgentProvider,
        provider.info.permissionModes ?? [],
      ),
      planUsage: chatPlanUsage(raw, session.activeAgentProvider),
      providers: this.registry
        .listProviders()
        .slice(0, 32)
        .map((provider) => ({ id: provider.id, label: provider.displayName })),
      providerLocked:
        this.sessions.hasStartedAgentRuntime(session) ||
        session.status === 'archived' ||
        !!session.workspaceArchivedAt ||
        raw.canInterrupt === true ||
        raw.runPhase === 'running' ||
        raw.runPhase === 'waiting' ||
        (Array.isArray(raw.pendingPrompts) && raw.pendingPrompts.length > 0),
    };
  }

  private feed(
    sessionId: number,
    providerId: string,
    attach: boolean,
  ): ChatFeed {
    const existing = this.feeds.get(sessionId);
    if (existing?.provider.info.id === providerId) {
      if (attach && !existing.attached) {
        existing.provider.onClientAttached?.(sessionId);
        existing.attached = true;
      }
      existing.touched = Date.now();
      return existing;
    }
    if (existing) this.release(sessionId);
    if (this.feeds.size >= 32) {
      const idle = [...this.feeds]
        .filter(([, feed]) => !feed.waiters.size)
        .sort((a, b) => a[1].touched - b[1].touched)[0];
      if (idle) this.release(idle[0]);
      else throw new BadRequestException('Too many open conversations.');
    }
    const provider = this.registry.getProvider(providerId);
    const changed = (event: AgentRuntimeEvent) => {
      if (event.payload.sessionId !== sessionId) return;
      feed.revision++;
      // Persisted history is read only when its identity/content can change, never per token.
      if (
        event.type === 'history_snapshot' ||
        event.type === 'session_snapshot' ||
        (event.type === 'run_state' &&
          record(event.payload).runPhase !== 'running')
      )
        feed.historyRevision++;
      for (const wake of feed.waiters) wake();
    };
    const feed: ChatFeed = {
      id: randomUUID(),
      provider,
      revision: 0,
      historyRevision: 0,
      touched: Date.now(),
      attached: false,
      waiters: new Set(),
      projections: new Map(),
      stop: () => {
        provider.off('event', changed);
        if (feed.attached) provider.onClientDetached?.(sessionId);
      },
    };
    // Subscribe before any asynchronous snapshot read. The pre-read cursor makes
    // events arriving during hydration trigger another idempotent reconciliation.
    provider.on('event', changed);
    try {
      if (attach) {
        provider.onClientAttached?.(sessionId);
        feed.attached = true;
      }
    } catch (error) {
      provider.off('event', changed);
      throw error;
    }
    this.feeds.set(sessionId, feed);
    return feed;
  }

  async read(
    taskId: number,
    sessionId: number,
    after: string | undefined,
    before: string | undefined,
    signal: AbortSignal,
  ) {
    const session = await this.target(taskId, sessionId);
    if (
      (after && !/^[a-f0-9-]{36}:\d{1,12}:\d{1,12}$/.test(after)) ||
      (before !== undefined && (before.length > 1000 || !before))
    )
      throw new BadRequestException('Invalid conversation cursor.');
    if (session.status === 'archived' || session.workspaceArchivedAt) {
      const provider = this.registry.getProvider(session.activeAgentProvider);
      const window = chatWindow(
        await provider.getHistory(sessionId),
        [],
        before,
      );
      if (!window)
        throw new BadRequestException(
          'History cursor expired. Return to latest messages.',
        );
      return {
        taskId,
        sessionId,
        cursor: randomUUID() + ':0:0',
        reset: true,
        ...window,
        events: [],
        state: this.state(session, {}),
      };
    }
    const feed = this.feed(
      sessionId,
      session.activeAgentProvider,
      this.sessions.hasStartedAgentRuntime(session),
    );
    const cursor = () => `${feed.id}:${feed.revision}:${feed.historyRevision}`;
    if (feed.waiters.size >= 32)
      throw new BadRequestException('Too many conversation observers.');
    if (after === cursor() && !before && !signal.aborted)
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          feed.waiters.delete(done);
          signal.removeEventListener('abort', done);
          resolve();
        };
        const timer = setTimeout(done, 8000);
        feed.waiters.add(done);
        signal.addEventListener('abort', done, { once: true });
        if (signal.aborted) done();
      });
    if (signal.aborted) return;
    // Coalesce bursts without holding input or waiting for a full turn.
    const revision = cursor();
    const prior = after?.split(':');
    const reset =
      !before &&
      (!prior ||
        prior[0] !== feed.id ||
        Number(prior[1]) > feed.revision ||
        Number(prior[2]) !== feed.historyRevision);
    const historyPromise =
      reset || before
        ? (feed.history ??= feed.provider.getHistory(sessionId).finally(() => {
            feed.history = undefined;
          }))
        : Promise.resolve([]);
    const runtime = (feed.runtime ??= feed.provider
      .getRuntimeState(
        sessionId,
        this.sessions.hasStartedAgentRuntime(session)
          ? undefined
          : { initialize: false },
      )
      .then(record)
      .finally(() => {
        feed.runtime = undefined;
      }));
    const [raw, history] = await Promise.all([runtime, historyPromise]);
    const live = Array.isArray(raw.liveItems)
      ? (raw.liveItems as AgentTranscriptItem[])
      : [];
    const window = chatWindow(history, live, before);
    if (!window)
      throw new BadRequestException(
        'History cursor expired. Return to latest messages.',
      );
    const { items } = window;
    feed.touched = Date.now();
    const events = items.flatMap((item) => {
      const json = JSON.stringify(item),
        old = feed.projections.get(item.id);
      const version =
        old?.json === json ? old.revision : Number(revision.split(':')[1]);
      if (!before) feed.projections.set(item.id, { json, revision: version });
      return !prior || version > Number(prior[1])
        ? [{ type: 'item' as const, item }]
        : [];
    });
    for (const key of feed.projections.keys()) {
      if (feed.projections.size <= 80) break;
      feed.projections.delete(key);
    }
    return {
      taskId,
      sessionId,
      cursor: revision,
      reset,
      items: reset || before ? items : [],
      events: reset || before ? [] : events,
      before: window.before,
      state: this.state(session, raw),
    };
  }

  async command(taskId: number, sessionId: number, value: unknown) {
    const session = await this.target(taskId, sessionId);
    const action = record(value);
    const result = await executeChatAction(
      this.sessions,
      this.registry,
      sessionId,
      session,
      action,
    );
    if (action.type === 'provider') this.release(sessionId);
    return result;
  }

  async content(
    taskId: number,
    sessionId: number,
    itemId: string,
    part: string,
    offset: number,
  ) {
    if (
      !itemId ||
      itemId.length > 1000 ||
      (part !== 'text' && part !== 'input') ||
      !Number.isSafeInteger(offset) ||
      offset < 0
    )
      throw new BadRequestException('Invalid content window.');
    const session = await this.target(taskId, sessionId),
      provider = this.registry.getProvider(session.activeAgentProvider);
    const [history, runtime] = await Promise.all([
      provider.getHistory(sessionId),
      session.status === 'archived' || session.workspaceArchivedAt
        ? Promise.resolve({})
        : provider.getRuntimeState(sessionId).then(record),
    ]);
    const live = Array.isArray(record(runtime).liveItems)
      ? (record(runtime).liveItems as AgentTranscriptItem[])
      : [];
    const item =
      live.find((item) => item.id === itemId) ??
      history.find((item) => item.id === itemId);
    if (!item)
      throw new BadRequestException(
        'This transcript item is no longer available.',
      );
    const full = display(
      part === 'input'
        ? item.toolInput
        : (item.content ?? item.providerToolResult ?? item.agentMessage?.body),
      Number.MAX_SAFE_INTEGER,
    );
    if (offset > full.length)
      throw new BadRequestException(
        'This content window has changed. Reopen it.',
      );
    let end = Math.min(full.length, offset + 16000);
    if (end < full.length && /[\uD800-\uDBFF]/.test(full[end - 1])) end--;
    return {
      itemId,
      part,
      offset,
      text: full.slice(offset, end),
      nextOffset: end < full.length ? end : null,
      total: full.length,
    };
  }
}
