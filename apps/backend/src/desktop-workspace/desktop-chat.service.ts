import { readChatAgent } from './desktop-chat-agents.js';
import { chatMedia, readChatMedia } from './desktop-chat-media.js';
import { chatCatalog } from './desktop-chat-catalog.js';
import { SettingsService } from '../settings/settings.service.js';
import { chatPresets, executePresetAction } from './desktop-chat-presets.js';
import { prepareTurnChanges, preparedChangesPage, type PreparedTurnChanges } from './desktop-chat-changes.js';
import { executeChatAction } from './desktop-chat-actions.js';
import { assertChatEditIdle, chatEditProvider, savedChatPrompt, validateChatEditId } from './desktop-chat-edit.js';
import { chatPromptImages } from './desktop-chat-input.js';
import { TurnChangesService } from '../agent-runtime/turn-changes.service.js';
import { ConversationExportService } from '../agent-runtime/conversation-export.service.js';
import {
  BadRequestException,
  ConflictException,
  GoneException,
  HttpException,
  Injectable,
  Logger,
  OnModuleDestroy,
  Optional,
  PayloadTooLargeException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type {
  AgentRuntimeEvent,
  AgentRuntimeProvider,
  AgentTranscriptItem,
} from '../agent-runtime/agent-runtime.types.js';
import { AgentRuntimeRegistryService } from '../agent-runtime/agent-runtime-registry.service.js';
import { SessionsService } from '../sessions/sessions.service.js';
import { chatModelQuota, chatPlanUsage } from './desktop-chat-usage.js';
import { chatWork, legacyActivity } from './desktop-chat-work.js';
import {
  type ChatChangesCache,
  type ChatMediaCache,
  chatState,
  display,
  record,
} from './desktop-chat-projection.js';
import { ChatHistoryIndex, chatWindow } from './desktop-chat-window.js';
import { ChatHistoryHandoff } from './desktop-chat-source.js';
import { mergeTranscriptRows } from '../agent-runtime/transcript-order.js';
import { DesktopChatReplay } from './desktop-chat-replay.js';
import { waitForChatStreamWork } from './desktop-chat-stream.js';
import { ChatCompletedTurns, endOfChatTurn } from './desktop-chat-turns.js';
import { ChatToolDetails } from './desktop-chat-tool-details.js';
import { toolKey } from './desktop-chat-tool-links.js';
import { SESSION_CHAT_PROMPT_LIMIT, SESSION_CHAT_TURN_WORK_LIMIT, SESSION_CHAT_TURN_WORK_MAX_LIMIT } from '@elevenex/shared';
import type {
  SessionChatItem, SessionChatState, SessionChatStreamPage, SessionChatWatch,
  SessionChatToolDetailsReply, SessionChatToolReference, SessionChatToolSource,
  SessionChatTurnWorkPage, SessionChatTurnWorkReply,
  SessionChatPromptEdit,
} from '@elevenex/shared';

type ChatReadView = `${'window' | 'progressive' | 'summary' | 'recent-summary'}:${'inline' | 'deferred'}`;
interface ChatFeed {
  readonly id: string;
  readonly provider: AgentRuntimeProvider;
  readonly stop: () => void;
  readonly waiters: Set<() => void>;
  readonly replays: Map<SessionChatWatch['loadingMode'], DesktopChatReplay>;
  readonly readReplays: Map<ChatReadView, DesktopChatReplay>;
  readonly changesCache: ChatChangesCache;
  readonly mediaCache: ChatMediaCache;
  readonly handoff: ChatHistoryHandoff;
  readonly latestBounds: Map<ChatReadView, { readonly revision: string; readonly before: string | null }>;
  historyIndex?: { readonly revision: number; readonly index: ChatHistoryIndex };
  completedTurns?: { readonly revision: number; readonly projector: ChatCompletedTurns };
  toolDetails?: { readonly revision: number; readonly projector: ChatToolDetails };
  livePrompt?: string;
  review?: { readonly turnId: string; readonly revision: number; readonly historyRevision: number; readonly expires: number; readonly pending: Promise<PreparedTurnChanges> };
  revision: number;
  historyRevision: number;
  historyRewrite?: string;
  touched: number;
  attached: boolean;
  observers: number;
  runtime?: Promise<Record<string, unknown>>;
  history?: { readonly revision: number; readonly pending: Promise<AgentTranscriptItem[]> };
}

function toolDetailsRequested(value: unknown): boolean {
  if (value !== undefined && value !== '1') throw new BadRequestException('Invalid tool detail view.');
  return value === '1';
}

function validToolReference(reference: SessionChatToolReference): boolean {
  return typeof reference.id === 'string' && !!reference.id && reference.id.length <= 1000 &&
    typeof reference.revision === 'string' && /^[a-f0-9]{64}$/.test(reference.revision);
}

function runtimeChatItems(raw: Record<string, unknown>): readonly AgentTranscriptItem[] {
  return Array.isArray(raw.liveItems) ? raw.liveItems as AgentTranscriptItem[] : [];
}

function liveSource(items: readonly AgentTranscriptItem[]) {
  return { length: items.length, first: items[0]?.id };
}

function chatRunning(state: SessionChatState): boolean {
  return state.phase === 'running' || state.phase === 'waiting';
}

function chatReadCursor(feed: ChatFeed): string {
  return `${feed.id}:${feed.revision}:${feed.historyRevision}`;
}

/** Only selected conversations are observed. Idle feeds expire and never hydrate sidebar sessions. */
@Injectable()
export class DesktopChatService implements OnModuleDestroy {
  private readonly logger = new Logger(DesktopChatService.name);
  private readonly configuring = new Set<number>();
  private readonly writing = new Map<number, { count: number; editing: boolean }>();
  private readonly feeds = new Map<number, ChatFeed>();
  private readonly providerObservers = new Map<AgentRuntimeProvider, { count: number; changed: (event: AgentRuntimeEvent) => void }>();
  private readonly lifetime = new AbortController();
  private readonly completionChanged = (event: { sessionId: number; hasUnreviewedCompletion: boolean }) => {
    // New completions may persist final output after the runtime's last event.
    // Viewing it only changes the marker, so it must not reload history.
    this.invalidate(event.sessionId, event.hasUnreviewedCompletion);
  };
  private readonly sessionChanged = (event: { sessionId: number }) => this.invalidate(event.sessionId);
  private readonly expiry = setInterval(() => {
    for (const [id, feed] of this.feeds) {
      if (feed.review && feed.review.expires < Date.now())
        feed.review = undefined;
      if (Date.now() - feed.touched > 30000 && !feed.waiters.size && !feed.observers)
        this.release(id);
    }
  }, 10000).unref();
  constructor(
    private readonly sessions: SessionsService,
    private readonly registry: AgentRuntimeRegistryService,
    private readonly settings: SettingsService,
    private readonly conversationExports: ConversationExportService,
    @Optional() private readonly turnCaptures?: TurnChangesService,
  ) {
    this.sessions.on('session-completion-changed', this.completionChanged);
    this.sessions.on('session-status-changed', this.sessionChanged);
    this.sessions.on('session-provider-changed', this.sessionChanged);
  }

  onModuleDestroy(): void {
    this.sessions.off('session-completion-changed', this.completionChanged);
    this.sessions.off('session-status-changed', this.sessionChanged);
    this.sessions.off('session-provider-changed', this.sessionChanged);
    this.lifetime.abort();
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

  private invalidate(sessionId: number, history = false): void {
    const feed = this.feeds.get(sessionId);
    if (!feed) return;
    feed.revision++;
    if (history) feed.historyRevision++;
    for (const wake of feed.waiters) wake();
  }

  private retainProvider(provider: AgentRuntimeProvider): () => void {
    let observer = this.providerObservers.get(provider);
    if (!observer) {
      observer = { count: 0, changed: event => {
        const { sessionId } = event.payload;
        const feed = this.feeds.get(sessionId);
        if (feed?.provider !== provider) return;
        if (event.type === 'conversation_rewound') {
          feed.historyRewrite = randomUUID();
          feed.livePrompt = undefined;
          feed.handoff.clear();
        }
        // Persisted history is read only when its identity/content can change.
        this.invalidate(sessionId, event.type === 'conversation_rewound' || event.type === 'history_snapshot' ||
          event.type === 'session_snapshot' ||
          (event.type === 'run_state' && record(event.payload).runPhase !== 'running'));
      } };
      this.providerObservers.set(provider, observer);
      provider.on('event', observer.changed);
    }
    const retained = observer;
    retained.count++;
    return () => {
      if (--retained.count) return;
      provider.off('event', retained.changed);
      this.providerObservers.delete(provider);
    };
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
    historyRewrite?: string,
  ): SessionChatState {
    const provider = this.registry.getProvider(session.activeAgentProvider);
    const work = chatWork(raw, {
      stopTask: typeof provider.stopBackgroundTask === 'function',
      stopAgent: typeof provider.stopSubagent === 'function',
      inspectAgent: typeof provider.getSubagentHistory === 'function',
      backgroundAgent: typeof provider.backgroundSubagent === 'function',
    });
    return {
      ...(historyRewrite ? { historyRewrite } : {}),
      unseenCompletionAt: session.hasUnreviewedCompletion ? session.lastCompletionAt : null,
      attachments: true,
      browserElements: provider.info.capabilities.multimodalPrompts === true,
      sessionMentions: true,
      presetCatalogs: true,
      presetEditing: true,
      presets: chatPresets(this.settings, this.registry),
      presetDefault: this.settings.getAgentPresetDefault(),
      controls: {
        plan: typeof provider.setPlanMode === 'function' && raw.planAvailable !== false,
        reasoning: typeof provider.setReasoningEffort === 'function',
        fast: typeof provider.setFastMode === 'function',
      },
      ...chatState(
        raw,
        session.activeAgentProvider,
        provider.info.permissionModes,
      ),
      work,
      activity: legacyActivity(work),
      planUsage: chatPlanUsage(raw, session.activeAgentProvider),
      modelQuota: chatModelQuota(raw, session.activeAgentProvider),
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
        .filter(([, feed]) => !feed.waiters.size && !feed.observers)
        .sort((a, b) => a[1].touched - b[1].touched)[0];
      if (idle) this.release(idle[0]);
      else throw new BadRequestException('Too many open conversations.');
    }
    const provider = this.registry.getProvider(providerId);
    const releaseProvider = this.retainProvider(provider);
    const feed: ChatFeed = {
      id: randomUUID(),
      provider,
      revision: 0,
      historyRevision: 0,
      touched: Date.now(),
      attached: false,
      observers: 0,
      waiters: new Set(),
      replays: new Map(),
      readReplays: new Map(),
      changesCache: new WeakMap(),
      mediaCache: new WeakMap(),
      handoff: new ChatHistoryHandoff(),
      latestBounds: new Map(),
      stop: () => {
        releaseProvider();
        if (feed.attached) provider.onClientDetached?.(sessionId);
      },
    };
    // Subscribe before any asynchronous snapshot read. The pre-read cursor makes
    // events arriving during hydration trigger another idempotent reconciliation.
    this.feeds.set(sessionId, feed);
    try {
      if (attach) {
        provider.onClientAttached?.(sessionId);
        feed.attached = true;
      }
    } catch (error) {
      this.release(sessionId);
      throw error;
    }
    return feed;
  }

  async agent(taskId: number, sessionId: number, agentId: string, before?: string) {
    const session = await this.target(taskId, sessionId);
    if (session.status === 'archived' || session.workspaceArchivedAt) throw new BadRequestException('Agent history requires an active session.');
    const provider = this.registry.getProvider(session.activeAgentProvider);
    const raw = record(await provider.getRuntimeState(sessionId, { initialize: false }));
    if (!Array.isArray(raw.subagents) || !raw.subagents.some(item => record(item).agentId === agentId))
      throw new BadRequestException('Agent is unavailable in this session.');
    return readChatAgent(provider, sessionId, agentId, before);
  }

  private history(feed: ChatFeed, sessionId: number): Promise<AgentTranscriptItem[]> {
    if (feed.history?.revision === feed.historyRevision) return feed.history.pending;
    const revision = feed.historyRevision;
    const pending = feed.provider.getHistory(sessionId, { changeDetails: 'summary' }).finally(() => {
      if (feed.history?.pending === pending) feed.history = undefined;
    });
    feed.history = { revision, pending };
    return pending;
  }

  private runtime(feed: ChatFeed, sessionId: number, started: boolean) {
    return feed.runtime ??= feed.provider.getRuntimeState(sessionId, started ? undefined : { initialize: false })
      .then(record).finally(() => { feed.runtime = undefined; });
  }

  private toolDetails(feed: ChatFeed): ChatToolDetails {
    if (feed.toolDetails?.revision !== feed.historyRevision)
      feed.toolDetails = { revision: feed.historyRevision, projector: new ChatToolDetails(feed.changesCache, feed.mediaCache) };
    return feed.toolDetails.projector;
  }

  private historyWindowIndex(feed: ChatFeed): ChatHistoryIndex {
    if (feed.historyIndex?.revision !== feed.historyRevision)
      feed.historyIndex = { revision: feed.historyRevision, index: new ChatHistoryIndex() };
    return feed.historyIndex.index;
  }

  private completedTurns(feed: ChatFeed): ChatCompletedTurns {
    if (feed.completedTurns?.revision !== feed.historyRevision)
      feed.completedTurns = { revision: feed.historyRevision, projector: new ChatCompletedTurns(feed.changesCache, feed.mediaCache) };
    return feed.completedTurns.projector;
  }

  private waitForChange(sessionId: number, feed: ChatFeed, revision: number, signal: AbortSignal, timeout?: number): Promise<void> {
    if (signal.aborted || this.feeds.get(sessionId) !== feed || feed.revision !== revision)
      return Promise.resolve();
    return new Promise(resolve => {
      const done = () => {
        clearTimeout(timer);
        feed.waiters.delete(done);
        signal.removeEventListener('abort', done);
        resolve();
      };
      const timer = timeout === undefined ? undefined : setTimeout(done, timeout);
      feed.waiters.add(done);
      signal.addEventListener('abort', done, { once: true });
    });
  }

  async openStream(taskId: number, sessionId: number, loadingMode: unknown, after: unknown, signal: AbortSignal) {
    if (loadingMode !== 'window' && loadingMode !== 'progressive')
      throw new BadRequestException('Invalid conversation loading mode.');
    if (after !== undefined && (typeof after !== 'string' || !/^[a-f0-9-]{36}:\d{1,12}:\d{1,12}$/.test(after)))
      throw new BadRequestException('Invalid conversation event ID.');
    const lifetime = AbortSignal.any([signal, this.lifetime.signal]);
    const session = await waitForChatStreamWork(this.target(taskId, sessionId), lifetime);
    if (session.status === 'archived' || session.workspaceArchivedAt)
      throw new GoneException('This conversation was archived.');
    if ((this.feeds.get(sessionId)?.observers ?? 0) >= 8)
      throw new HttpException('Too many conversation observers.', 429);
    return this.streamPages(taskId, sessionId, loadingMode, after, lifetime);
  }

  private async *streamPages(
    taskId: number, sessionId: number, loadingMode: SessionChatWatch['loadingMode'],
    after: string | undefined, signal: AbortSignal,
  ): AsyncGenerator<SessionChatStreamPage> {
    let observed: ChatFeed | undefined;
    let previousState: string | undefined;
    const releaseObserver = () => {
      if (!observed) return;
      observed.observers--;
      observed.touched = Date.now();
    };
    try {
      while (!signal.aborted) {
        const beforeRead = this.feeds.get(sessionId);
        const observedRevision = beforeRead?.revision;
        const session = await waitForChatStreamWork(this.target(taskId, sessionId), signal);
        if (signal.aborted || session.status === 'archived' || session.workspaceArchivedAt) return;
        const started = this.sessions.hasStartedAgentRuntime(session);
        const feed = this.feed(sessionId, session.activeAgentProvider, started);
        if (feed !== observed) {
          releaseObserver();
          observed = undefined;
          if (feed.observers >= 8) throw new HttpException('Too many conversation observers.', 429);
          feed.observers++;
          observed = feed;
        }
        let replay = feed.replays.get(loadingMode);
        if (!replay) {
          replay = new DesktopChatReplay();
          feed.replays.set(loadingMode, replay);
        }
        const revision = beforeRead === feed ? observedRevision! : feed.revision;
        const historyRevision = feed.historyRevision;
        const current = () => !signal.aborted && this.feeds.get(sessionId) === feed && feed.historyRevision === historyRevision;
        const prior = replay.checkpoint(after, historyRevision);
        // Read the runtime after history. Sampling live first can put a saved
        // message ahead of an earlier notification and replay it as a new row.
        let saved = prior ? undefined : await waitForChatStreamWork(this.history(feed, sessionId), signal);
        let raw = await waitForChatStreamWork(this.runtime(feed, sessionId, started), signal);
        if (current()) {
          let live = runtimeChatItems(raw);
          const toolDetails = this.toolDetails(feed);
          const projectedLive: SessionChatItem[] = [];
          const options = {
            loadingMode, changesCache: feed.changesCache, mediaCache: feed.mediaCache,
            toolDetails, projectedLive,
            promptEditing: feed.provider.info.capabilities.rewindConversation && !!feed.provider.rewindConversation,
          };
          const liveWindow = prior && chatWindow([], live, { ...options, includeLeadingPrompt: false });
          const checkpoint = replay.describe(historyRevision, liveSource(live), projectedLive, prior);
          const events = prior && liveWindow && replay.updates(prior, checkpoint, projectedLive, liveWindow.before !== null);
          if (!events && !saved) {
            saved = await waitForChatStreamWork(this.history(feed, sessionId), signal);
            raw = await waitForChatStreamWork(this.runtime(feed, sessionId, started), signal);
            live = runtimeChatItems(raw);
            if (!current()) {
              await delay(32, undefined, { signal });
              continue;
            }
          }
          const state = this.state(session, raw, feed.historyRewrite);
          const stateJson = JSON.stringify(state);
          if (state.activePromptId) feed.livePrompt = state.activePromptId;
          feed.handoff.observe(live);
          if (events) {
            if (events.length || previousState !== stateJson) {
              const cursor = replay.remember(checkpoint);
              yield { after: after ?? null, page: {
                taskId, sessionId, cursor, reset: false, items: [], events,
                before: liveWindow.before, next: null,
                ...(previousState !== stateJson ? { state } : {}),
              } };
              after = cursor;
            }
          } else {
            projectedLive.length = 0;
            const window = chatWindow(saved ?? [], live, {
              ...options, historyIndex: this.historyWindowIndex(feed),
              completedTurns: loadingMode === 'progressive' ? this.completedTurns(feed) : undefined,
              summarizeRecent: true, liveTurn: chatRunning(state),
              settling: feed.handoff.carry(saved ?? []),
              keepTurnId: state.activePromptId ?? (after ? feed.livePrompt : undefined),
            })!;
            const cursor = replay.remember(replay.describe(historyRevision, liveSource(live), projectedLive, prior, window.items));
            yield { after: after ?? null, page: {
              taskId, sessionId, cursor, reset: true, ...window, events: [], state,
            } };
            after = cursor;
          }
          previousState = stateJson;
          await this.waitForChange(sessionId, feed, revision, signal);
        }
        // Provider bursts need at most one projection per render interval.
        // A changed revision is checked again after hydration and backpressure.
        await delay(32, undefined, { signal });
      }
    } catch (error) {
      if (!signal.aborted) throw error;
    } finally {
      releaseObserver();
    }
  }

  async read(
    taskId: number,
    sessionId: number,
    after: string | undefined,
    before: string | undefined,
    signal: AbortSignal,
    following?: string,
    loadingMode?: string,
    summarizeCompleted?: string,
    deferToolDetails?: string,
    summarizeRecent?: string,
  ) {
    let session = await this.target(taskId, sessionId);
    if (loadingMode !== undefined && loadingMode !== 'window' && loadingMode !== 'progressive')
      throw new BadRequestException('Invalid conversation loading mode.');
    if (summarizeCompleted !== undefined && (summarizeCompleted !== '1' || loadingMode !== 'progressive'))
      throw new BadRequestException('Invalid completed turn view.');
    if (summarizeRecent !== undefined && (summarizeRecent !== '1' || !summarizeCompleted))
      throw new BadRequestException('Invalid recent turn view.');
    if (
      (after && !/^[a-f0-9-]{36}:\d{1,12}:\d{1,12}$/.test(after)) ||
      (before !== undefined && (typeof before !== 'string' || before.length > 1000 || !before)) ||
      (following !== undefined && (typeof following !== 'string' || following.length > 1000 || !following)) ||
      (following !== undefined && (after !== undefined || before !== undefined))
    )
      throw new BadRequestException('Invalid conversation cursor.');
    const paging = !!(before || following);
    const archived = () => session.status === 'archived' || !!session.workspaceArchivedAt;
    const mode: SessionChatWatch['loadingMode'] = loadingMode ?? 'progressive';
    const deferDetails = toolDetailsRequested(deferToolDetails);
    const evidence = deferDetails ? 'deferred' : 'inline';
    const view: ChatReadView = `${summarizeRecent ? 'recent-summary' : summarizeCompleted ? 'summary' : mode}:${evidence}`;
    const readArchived = async () => {
      if (this.feeds.get(sessionId)?.attached) this.release(sessionId);
      const archivedFeed = this.feed(sessionId, session.activeAgentProvider, false);
      const historyIndex = this.historyWindowIndex(archivedFeed);
      const toolDetails = deferDetails ? this.toolDetails(archivedFeed) : undefined;
      const history = await this.history(archivedFeed, sessionId);
      if (signal.aborted) return;
      const window = chatWindow(history, [], {
        before, following, loadingMode: mode, historyIndex,
        changesCache: archivedFeed.changesCache, mediaCache: archivedFeed.mediaCache,
        completedTurns: summarizeCompleted ? this.completedTurns(archivedFeed) : undefined,
        summarizeRecent: summarizeRecent === '1',
        toolDetails,
      });
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
    };
    if (signal.aborted) return;
    if (archived()) return readArchived();
    const waitingFeed = this.feed(
      sessionId, session.activeAgentProvider, this.sessions.hasStartedAgentRuntime(session),
    );
    if (waitingFeed.waiters.size >= 32)
      throw new BadRequestException('Too many conversation observers.');
    if (!paging && after === chatReadCursor(waitingFeed))
      await this.waitForChange(sessionId, waitingFeed, waitingFeed.revision, signal, 8000);
    if (signal.aborted) return;
    // Long polls can outlive completion or another window viewing the reply.
    // Read the marker before hydrating content so its version cannot get ahead
    // of the transcript delivered with it.
    session = await this.target(taskId, sessionId);
    if (signal.aborted) return;
    if (archived()) return readArchived();
    const started = this.sessions.hasStartedAgentRuntime(session);
    const feed = this.feed(sessionId, session.activeAgentProvider, started);
    let replay = feed.readReplays.get(view);
    if (!replay) {
      replay = new DesktopChatReplay();
      feed.readReplays.set(view, replay);
    }
    while (!signal.aborted) {
      // Keep a pre-read cursor so a newer event can wake the next poll even
      // if it arrives during these asynchronous reads.
      const revision = chatReadCursor(feed), historyRevision = feed.historyRevision;
      const current = () => !signal.aborted && feed.historyRevision === historyRevision && this.feeds.get(sessionId) === feed;
      const prior = paging ? undefined : replay.checkpoint(after, historyRevision);
      let history = prior ? undefined : await this.history(feed, sessionId);
      if (!current()) {
        if (this.feeds.get(sessionId) !== feed) return;
        continue;
      }
      let raw = await this.runtime(feed, sessionId, started);
      if (!current()) {
        if (this.feeds.get(sessionId) !== feed) return;
        continue;
      }
      const bounds = feed.latestBounds.get(view);
      if (prior && after === revision && bounds?.revision === revision) {
        return { taskId, sessionId, cursor: revision, reset: false, items: [], events: [],
          before: bounds.before, next: null, state: this.state(session, raw, feed.historyRewrite) };
      }
      let live = runtimeChatItems(raw);
      const projectedLive: SessionChatItem[] = [];
      const options = {
        loadingMode: mode, projectedLive, changesCache: feed.changesCache, mediaCache: feed.mediaCache,
        toolDetails: deferDetails ? this.toolDetails(feed) : undefined,
        promptEditing: feed.provider.info.capabilities.rewindConversation && !!feed.provider.rewindConversation,
      };
      if (prior) {
        const liveWindow = chatWindow([], live, { ...options, includeLeadingPrompt: false })!;
        const checkpoint = replay.describe(historyRevision, liveSource(live), projectedLive, prior);
        const events = replay.updates(prior, checkpoint, projectedLive, liveWindow.before !== null, false);
        if (events) {
          const state = this.state(session, raw, feed.historyRewrite);
          if (state.activePromptId) feed.livePrompt = state.activePromptId;
          feed.handoff.observe(live);
          replay.remember(checkpoint, revision);
          if (revision === chatReadCursor(feed)) feed.latestBounds.set(view, { revision, before: liveWindow.before });
          return { taskId, sessionId, cursor: revision, reset: false, items: [], events, before: liveWindow.before, next: null, state };
        }
        history = await this.history(feed, sessionId);
        raw = await this.runtime(feed, sessionId, started);
        if (!current()) {
          if (this.feeds.get(sessionId) !== feed) return;
          continue;
        }
        live = runtimeChatItems(raw);
        projectedLive.length = 0;
      }
      const state = this.state(session, raw, feed.historyRewrite);
      if (state.activePromptId) feed.livePrompt = state.activePromptId;
      feed.handoff.observe(live);
      const window = chatWindow(history ?? [], live, {
        ...options, before, following, historyIndex: this.historyWindowIndex(feed),
        completedTurns: summarizeCompleted ? this.completedTurns(feed) : undefined,
        summarizeRecent: summarizeRecent === '1', liveTurn: chatRunning(state),
        settling: feed.handoff.carry(history ?? []),
        keepTurnId: state.activePromptId ?? (paging || after?.startsWith(feed.id + ':') ? feed.livePrompt : undefined),
      });
      if (!window) throw new BadRequestException('History cursor expired. Return to latest messages.');
      if (!paging) {
        replay.remember(replay.describe(historyRevision, liveSource(live), projectedLive, prior, window.items), revision);
        if (revision === chatReadCursor(feed)) feed.latestBounds.set(view, { revision, before: window.before });
      }
      return { taskId, sessionId, cursor: revision, reset: !paging, ...window, events: [], state };
    }
  }

  private async savedTurn(feed: ChatFeed, sessionId: number, turnId: string, signal: AbortSignal) {
    const history = await this.history(feed, sessionId);
    if (signal.aborted) return;
    const index = this.historyWindowIndex(feed);
    index.align(history);
    const start = index.position(history, turnId);
    if (start >= 0 && history[start].kind === 'user') return history.slice(start, endOfChatTurn(history, start));
  }

  async turnWork(taskId: number, sessionId: number, turnId: string, revision: string, offset: number,
    signal: AbortSignal, deferToolDetails?: string, limit?: number): Promise<SessionChatTurnWorkPage | undefined>;
  async turnWork(taskId: number, sessionId: number, turnId: string, revision: string, offset: number,
    signal: AbortSignal, deferToolDetails?: string, limit?: number, timeline?: string, complete?: string): Promise<SessionChatTurnWorkReply | undefined>;
  async turnWork(taskId: number, sessionId: number, turnId: string, revision: string, offset: number,
    signal: AbortSignal, deferToolDetails?: string, limit: number = SESSION_CHAT_TURN_WORK_LIMIT, timeline?: string, complete?: string): Promise<SessionChatTurnWorkReply | undefined> {
    if (typeof turnId !== 'string' || !turnId || turnId.length > 1000 ||
        typeof revision !== 'string' || !/^[a-f0-9]{64}$/.test(revision) ||
        !Number.isSafeInteger(offset) || offset < 0)
      throw new BadRequestException('Invalid turn activity window.');
    const deferDetails = toolDetailsRequested(deferToolDetails);
    if (timeline !== undefined && (timeline !== '1' || !deferDetails))
      throw new BadRequestException('Invalid turn timeline format.');
    if (complete !== undefined && (complete !== '1' || timeline !== '1' || offset !== 0))
      throw new BadRequestException('A complete turn timeline must start at offset zero.');
    if (!Number.isSafeInteger(limit) || limit < 1 ||
        limit > (deferDetails ? SESSION_CHAT_TURN_WORK_MAX_LIMIT : SESSION_CHAT_TURN_WORK_LIMIT))
      throw new BadRequestException('Invalid turn activity limit.');
    const session = await this.target(taskId, sessionId);
    if (signal.aborted) return;
    const feed = this.feed(sessionId, session.activeAgentProvider, false);
    const turn = await this.savedTurn(feed, sessionId, turnId, signal);
    if (signal.aborted) return;
    const projector = this.completedTurns(feed);
    const page = turn && (timeline
      ? projector.timeline(turn, revision, offset, complete === '1')
      : projector.page(turn, revision, offset, deferDetails ? this.toolDetails(feed) : undefined, limit));
    if (!page) throw new ConflictException('This activity has changed. Refresh the conversation to see it.');
    if (complete && page.nextOffset !== null)
      throw new PayloadTooLargeException('This activity is too large to open as one timeline.');
    return { taskId, sessionId, turnId, revision, offset, ...page };
  }

  async readToolDetails(taskId: number, sessionId: number, source: SessionChatToolSource, signal: AbortSignal): Promise<SessionChatToolDetailsReply | undefined> {
    if (!validToolReference(source.item) ||
        (source.result && (!validToolReference(source.result) || source.result.id === source.item.id)) ||
        (source.turnId !== undefined && (typeof source.turnId !== 'string' || !source.turnId || source.turnId.length > 1000 ||
          source.turnId === source.item.id || source.turnId === source.result?.id ||
          (source.result && source.result.revision !== source.item.revision))))
      throw new BadRequestException('Invalid tool details reference.');
    const changed = () => new ConflictException('This tool call has changed. Refresh the conversation to see the latest details.');
    const session = await this.target(taskId, sessionId);
    if (signal.aborted) return;
    const feed = this.feed(sessionId, session.activeAgentProvider, false);
    if (source.turnId) {
      const { id, revision } = source.item;
      const turn = await this.savedTurn(feed, sessionId, source.turnId, signal);
      if (signal.aborted) return;
      const tool = turn && this.completedTurns(feed).timelineTool(turn, revision, id);
      if (!tool || tool.result?.id !== source.result?.id) throw changed();
      const projector = this.toolDetails(feed);
      const item = projector.turnEvidence(revision, tool.item);
      const result = tool.result && projector.turnEvidence(revision, tool.result, tool.item);
      if (!item || (source.result && !result)) throw changed();
      return { taskId, sessionId, turnId: source.turnId, item, ...(result ? { result } : {}) };
    }
    const projector = this.toolDetails(feed);
    let item = projector.recentEvidence(source.item);
    let result = source.result && projector.recentEvidence(source.result, source.item.id);
    if (!item || (source.result && !result)) {
      const archived = session.status === 'archived' || !!session.workspaceArchivedAt;
      const [history, runtime] = await Promise.all([
        this.history(feed, sessionId),
        archived ? Promise.resolve(undefined) : this.runtime(feed, sessionId, false),
      ]);
      if (signal.aborted) return;
      const live = runtimeChatItems(runtime ?? {});
      // History and activity keep the latest payload at a repeated row ID.
      // Resolve the same payload after its recent evidence has left the cache.
      const find = (id: string) =>
        live.findLast(value => value.id === id) ?? history.findLast(value => value.id === id) ??
        (!archived ? feed.handoff.item(id) : undefined);
      const raw = find(source.item.id);
      const receipt = source.result ? find(source.result.id) : undefined;
      if (source.result && (raw?.kind !== 'tool_use' || receipt?.kind !== 'tool_result' || receipt.toolUseId !== toolKey(raw)))
        throw changed();
      // Reconcile both addresses from the same source snapshot on a cache miss.
      item = projector.resolve(source.item, raw);
      result = source.result && projector.resolve(source.result, receipt, raw);
    }
    if (!item || (source.result && (!result ||
        item.record.kind !== 'tool_use' || result.record.kind !== 'tool_result' ||
        result.record.toolId !== (item.record.toolId ?? item.id))))
      throw changed();
    return { taskId, sessionId, item, ...(result ? { result } : {}) };
  }

  async catalog(taskId: number, sessionId: number, providerId: string, refresh = false) {
    await this.target(taskId, sessionId);
    const catalog = await chatCatalog(this.registry, this.settings, providerId, refresh);
    // Antigravity discovers mode choices along with models on the same ACP probe.
    if (providerId === 'antigravity' && this.feeds.get(sessionId)?.provider.info.id === providerId)
      this.invalidate(sessionId);
    return catalog;
  }

  private async rememberConfiguration(sessionId: number): Promise<void> {
    try {
      const current = await this.sessions.findOne(sessionId);
      const provider = this.registry.getProvider(current.activeAgentProvider);
      const raw = record(
        await provider.getRuntimeState(sessionId, { initialize: false }),
      );
      await this.settings.rememberAgentConfig({
        provider: current.activeAgentProvider,
        model: raw.selectedModel ?? null,
        reasoningEffort: raw.reasoningEffort ?? null,
        fastMode: raw.fastMode === true,
      });
    } catch {
      // The command already succeeded, especially a prompt: never invite replay
      // because saving its optional startup fallback failed.
      this.logger.warn('Could not remember the last used agent configuration.');
    }
  }

  private async editableSession(sessionId: number, session: Awaited<ReturnType<SessionsService['findOne']>>) {
    if (session.status === 'archived' || session.workspaceArchivedAt)
      throw new BadRequestException('Archived sessions are read-only.');
    await this.sessions.assertSessionWorkspaceLinked(sessionId);
    const provider = this.registry.getProvider(session.activeAgentProvider);
    const rewind = chatEditProvider(provider);
    return { provider, rewind };
  }

  private async promptSnapshot(
    taskId: number, sessionId: number, session: Awaited<ReturnType<SessionsService['findOne']>>,
    provider: AgentRuntimeProvider, itemId: string,
  ) {
    const history = await provider.getHistory(sessionId);
    return savedChatPrompt(history, itemId, [
      taskId, sessionId, provider.info.id, session.claudeSessionId, session.codexSessionId, session.piSessionPath, session.opencodeSessionId,
      ...(provider.info.id === 'antigravity' ? [session.antigravitySessionId] : []),
    ]);
  }

  async promptEdit(taskId: number, sessionId: number, id: unknown, signal: AbortSignal): Promise<SessionChatPromptEdit | undefined> {
    const itemId = validateChatEditId(id);
    const session = await this.target(taskId, sessionId);
    if (this.writing.get(sessionId)?.editing)
      throw new ConflictException('Another message is being edited. Please wait.');
    const { provider } = await this.editableSession(sessionId, session);
    if (signal.aborted) return;
    assertChatEditIdle(record(await provider.getRuntimeState(sessionId, { initialize: false })));
    if (signal.aborted) return;
    const { text, revision, laterPrompts, context, images } = await this.promptSnapshot(taskId, sessionId, session, provider, itemId);
    if (signal.aborted) return;
    return { taskId, sessionId, itemId, revision, text, laterPrompts, keepsContext: !!(context.length || images.length) };
  }

  private async editPrompt(
    taskId: number, sessionId: number, session: Awaited<ReturnType<SessionsService['findOne']>>,
    action: Record<string, unknown>,
  ) {
    const itemId = validateChatEditId(action.itemId);
    if (typeof action.revision !== 'string' || !/^[a-f0-9]{64}$/.test(action.revision) ||
        typeof action.text !== 'string' || !action.text.trim() || action.text.length > SESSION_CHAT_PROMPT_LIMIT)
      throw new BadRequestException('Invalid message edit.');
    const { provider, rewind } = await this.editableSession(sessionId, session);
    const saved = await this.promptSnapshot(taskId, sessionId, session, provider, itemId);
    if (saved.revision !== action.revision)
      throw new ConflictException('The conversation changed. Refresh the edit details before resending.');
    const text = action.text.trim();
    if (saved.text === text) throw new BadRequestException('Change the message before sending it again.');
    const prompt = [text, ...saved.context].join('\n\n');
    if (prompt.length > 128000)
      throw new BadRequestException('Message and saved context exceed the input limit.');
    const images = await chatPromptImages(prompt, sessionId, session.worktreePath, provider, saved.images);
    assertChatEditIdle(record(await provider.getRuntimeState(sessionId, { initialize: false })));
    if (session.status === 'stopped') await this.sessions.reactivateRuntime(sessionId);
    const previousRewrite = this.feeds.get(sessionId)?.historyRewrite;
    const interactive = provider.info.id === 'antigravity' ? 'desktop-chat' : undefined;
    if (interactive) await rewind(sessionId, saved.sourceId, interactive);
    else await rewind(sessionId, saved.sourceId);
    const feed = this.feeds.get(sessionId);
    if (feed && previousRewrite === feed.historyRewrite) {
      feed.historyRewrite = randomUUID();
      feed.livePrompt = undefined;
      feed.handoff.clear();
      this.invalidate(sessionId, true);
    }
    try {
      await provider.submitPrompt(sessionId, prompt, text, images, { human: true, queue: false, waitForCompletion: false, ...(interactive ? { origin: interactive } : {}) });
    } catch {
      // History has already changed. The caller must read before sending again.
      throw new ServiceUnavailableException('Could not confirm the edited message after updating the conversation.');
    }
    return { accepted: true as const };
  }

  async command(taskId: number, sessionId: number, value: unknown) {
    const session = await this.target(taskId, sessionId);
    const action = record(value);
    if (action.type === 'mark-seen') {
      const at = action.completionAt;
      if (typeof at !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(at) || !Number.isFinite(Date.parse(at)))
        throw new BadRequestException('Invalid completion version.');
      await this.sessions.markCompletionReviewed(sessionId, at);
      return { accepted: true as const };
    }
    if (this.configuring.has(sessionId))
      throw new ConflictException(
        'An agent configuration is being applied. Please wait.',
      );
    const active = this.writing.get(sessionId);
    const editing = action.type === 'edit-prompt';
    if (active?.editing || (editing && active))
      throw new ConflictException('Another conversation action is in progress. Please wait.');
    const writing = active ?? { count: 0, editing };
    writing.count++;
    this.writing.set(sessionId, writing);
    const catalogEdit = ['preset-update', 'preset-reorder', 'preset-delete', 'preset-restore'].includes(String(action.type));
    const preset = catalogEdit || ['preset', 'save-preset', 'preset-default', 'preset-default-restore'].includes(String(action.type));
    if (preset) this.configuring.add(sessionId);
    try {
      if (editing) return await this.editPrompt(taskId, sessionId, session, action);
      const result = preset
        ? await executePresetAction(
            this.sessions,
            this.registry,
            this.settings,
            sessionId,
            session,
            action,
          )
        : await executeChatAction(
            this.sessions,
            this.registry,
            sessionId,
            session,
            action,
            this.conversationExports,
          );
      if ([
        'provider', 'model', 'reasoning', 'fast', 'preset', 'save-preset',
        'preset-default', 'send',
      ].includes(String(action.type)))
        await this.rememberConfiguration(sessionId);
      if (catalogEdit || action.type === 'save-preset' || action.type === 'preset-default' || action.type === 'preset-default-restore') {
        for (const id of this.feeds.keys()) if (id !== sessionId) this.invalidate(id);
      }
      if (!preset && action.type !== 'provider') this.invalidate(sessionId);
      return result;
    } finally {
      if (--writing.count === 0) this.writing.delete(sessionId);
      if (preset) this.configuring.delete(sessionId);
      if (preset || action.type === 'provider') this.release(sessionId);
    }
  }

  async changes(
    taskId: number,
    sessionId: number,
    turnId: string,
    offset: number,
    path?: string,
    lineOffset = 0,
    revision?: string,
    source: unknown = 'net',
  ) {
    if (
      (source !== 'net' && source !== 'provider' && source !== 'command') ||
      !turnId ||
      turnId.length > 1000 ||
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      !Number.isSafeInteger(lineOffset) ||
      lineOffset < 0 ||
      (path !== undefined && (!path || path.length > 1000)) ||
      (revision !== undefined && !/^[a-f0-9]{64}$/.test(revision))
    )
      throw new BadRequestException('Invalid changes window.');
    const session = await this.target(taskId, sessionId);
    const feed = this.feed(sessionId, session.activeAgentProvider, false);
    if (
      !feed.review ||
      feed.review.turnId !== turnId ||
      feed.review.revision !== feed.revision ||
      feed.review.historyRevision !== feed.historyRevision ||
      feed.review.expires < Date.now()
    ) {
      const pending = (async () => {
        const [history, raw] = await Promise.all([
          this.history(feed, sessionId),
          session.status === 'archived' || session.workspaceArchivedAt
            ? Promise.resolve({})
            : feed.provider
                .getRuntimeState(sessionId, { initialize: false })
                .then(record),
        ]);
        const live = runtimeChatItems(raw);
        const settling = session.status !== 'archived' && !session.workspaceArchivedAt ? feed.handoff.carry(history) : [];
        const { rows } = mergeTranscriptRows(history, settling.length ? [...settling, ...live] : live);
        const prepared = prepareTurnChanges(rows, turnId);
        if (!prepared.markerId || !prepared.details?.summaryOnly) return prepared;
        const details = await this.turnCaptures?.reviewDetails(sessionId, session.activeAgentProvider, prepared.markerId);
        if (!details) throw new GoneException('These changes are no longer available. Reopen the session.');
        return prepareTurnChanges(rows, turnId, details);
      })();
      feed.review = {
        turnId,
        revision: feed.revision,
        historyRevision: feed.historyRevision,
        expires: Date.now() + 10000,
        pending,
      };
      void pending.catch(() => {
        if (feed.review?.pending === pending) feed.review = undefined;
      });
    }
    return preparedChangesPage(
      await feed.review.pending,
      offset,
      path,
      lineOffset,
      revision,
      source,
    );
  }

  private async transcriptItem(taskId: number, sessionId: number, itemId: string) {
    const session = await this.target(taskId, sessionId),
      provider = this.registry.getProvider(session.activeAgentProvider);
    const [history, runtime] = await Promise.all([
      provider.getHistory(sessionId),
      session.status === 'archived' || session.workspaceArchivedAt
        ? Promise.resolve({})
        : provider.getRuntimeState(sessionId).then(record),
    ]);
    const live = runtimeChatItems(runtime);
    const feed = this.feeds.get(sessionId);
    const item =
      live.findLast((item) => item.id === itemId) ??
      history.findLast((item) => item.id === itemId) ??
      (feed?.provider === provider && session.status !== 'archived' && !session.workspaceArchivedAt
        ? feed.handoff.item(itemId) : undefined);
    if (!item)
      throw new BadRequestException(
        'This transcript item is no longer available.',
      );
    return { item, session };
  }

  async media(taskId: number, sessionId: number, itemId: string, mediaId: string) {
    if (!itemId || itemId.length > 1000 || !/^\d{1,2}$/.test(mediaId))
      throw new BadRequestException('Invalid image reference.');
    const { item, session } = await this.transcriptItem(taskId, sessionId, itemId);
    const media = chatMedia(item).media.find(value => value.id === mediaId);
    if (!media) throw new BadRequestException('This image is no longer available.');
    return { itemId, mediaId, source: await readChatMedia(media.source, session.worktreePath, session.activeAgentProvider, sessionId) };
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
    const { item } = await this.transcriptItem(taskId, sessionId, itemId);
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
