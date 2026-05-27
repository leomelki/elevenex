import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import chokidar, { FSWatcher } from 'chokidar';
import { open as openFile, readFile, stat } from 'fs/promises';
import type { ClaudeRuntimeService, ClaudeTranscriptRecord } from './claude-runtime.service.js';
import { ClaudeHooksService } from '../claude-hooks/claude-hooks.service.js';
import { CLAUDE_RUNTIME_SERVICE } from './claude-runtime.tokens.js';
import type {
  ClaudeRunPhase,
  ClaudeRuntimeEvent,
  ClaudeRuntimeStatePayload,
  ClaudeSessionExecutionState,
  ClaudeTranscriptItem,
} from './claude-runtime.types.js';

type MirrorSend = (event: ClaudeRuntimeEvent) => void;
type TranscriptMirrorRuntime = Pick<
  ClaudeRuntimeService,
  'resolveTranscriptFile' | 'normalizeTranscriptRecordsForSession'
>;

interface MirrorState {
  clients: Set<MirrorSend>;
  claudeSessionId: string | null;
  transcriptPath: string | null;
  history: ClaudeTranscriptItem[];
  fileOffset: number;
  partialLine: string;
  watcher: FSWatcher | null;
  readInFlight: Promise<void> | null;
  readAgain: boolean;
  debounceTimer: ReturnType<typeof setTimeout> | null;
  runPhase: ClaudeRunPhase;
  sessionState: ClaudeSessionExecutionState;
  lastError: string | null;
}

interface ClaudeHookPayload {
  hook_event_name?: string;
  session_id?: string;
  [key: string]: unknown;
}

interface StatusChangedPayload {
  sessionId: number;
  status: string;
  activityStatus?: string;
}

const READ_DEBOUNCE_MS = 80;

@Injectable()
export class ClaudeTerminalTranscriptMirrorService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(ClaudeTerminalTranscriptMirrorService.name);
  private readonly states = new Map<number, MirrorState>();

  private readonly hookEventListener = (data: {
    sessionId: number;
    payload: Record<string, unknown>;
  }) => this.handleHookEvent(data.sessionId, data.payload as ClaudeHookPayload);

  private readonly statusChangedListener = (data: StatusChangedPayload) =>
    this.handleStatusChanged(data);

  constructor(
    @Inject(CLAUDE_RUNTIME_SERVICE)
    private readonly claudeRuntime: TranscriptMirrorRuntime,
    private readonly hooksService: ClaudeHooksService,
  ) {}

  onModuleInit(): void {
    this.hooksService.on('hook-event', this.hookEventListener);
    this.hooksService.on('status-changed', this.statusChangedListener);
  }

  attachClient(sessionId: number, send: MirrorSend): () => void {
    const state = this.ensureState(sessionId);
    state.clients.add(send);

    void this.hydrate(sessionId, send);

    return () => {
      const current = this.states.get(sessionId);
      if (!current) return;
      current.clients.delete(send);
      if (current.clients.size === 0) {
        void this.disposeState(sessionId, current);
      }
    };
  }

  async hydrate(sessionId: number, target?: MirrorSend): Promise<void> {
    const state = this.ensureState(sessionId);
    try {
      await this.reloadTranscript(sessionId, state);
      this.emitSnapshot(sessionId, state, target);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      state.lastError = message;
      this.emitError(sessionId, message, target);
    }
  }

  getActiveSessionCount(): number {
    return this.states.size;
  }

  private handleHookEvent(sessionId: number, payload: ClaudeHookPayload): void {
    const state = this.states.get(sessionId);
    if (!state || state.clients.size === 0) return;

    const claudeSessionId =
      typeof payload.session_id === 'string' && payload.session_id.trim()
        ? payload.session_id.trim()
        : null;
    if (claudeSessionId && claudeSessionId !== state.claudeSessionId) {
      state.claudeSessionId = claudeSessionId;
      this.broadcast(sessionId, {
        type: 'session_created',
        payload: { sessionId, claudeSessionId },
      });
      void this.hydrate(sessionId);
      return;
    }

    this.scheduleRead(sessionId, state);
  }

  private handleStatusChanged(data: StatusChangedPayload): void {
    const state = this.states.get(data.sessionId);
    if (!state || state.clients.size === 0) return;

    const phase = this.activityStatusToRunPhase(
      data.activityStatus ?? data.status,
    );
    state.runPhase = phase;
    state.sessionState = this.runPhaseToSessionState(phase);
    state.lastError = null;

    this.emitRunState(data.sessionId, state);
    this.scheduleRead(data.sessionId, state);
  }

  private scheduleRead(
    sessionId: number,
    state: MirrorState,
    delayMs = READ_DEBOUNCE_MS,
  ): void {
    if (!state.transcriptPath) {
      if (state.claudeSessionId) {
        void this.hydrate(sessionId);
      }
      return;
    }

    if (state.debounceTimer) {
      clearTimeout(state.debounceTimer);
    }
    state.debounceTimer = setTimeout(() => {
      state.debounceTimer = null;
      void this.readLatest(sessionId, state);
    }, delayMs);
    state.debounceTimer.unref?.();
  }

  private async readLatest(sessionId: number, state: MirrorState): Promise<void> {
    if (state.readInFlight) {
      state.readAgain = true;
      return state.readInFlight;
    }

    state.readInFlight = this.readLatestInternal(sessionId, state)
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.warn(
          `Failed to mirror Claude transcript session=${sessionId}: ${message}`,
        );
        state.lastError = message;
        this.emitError(sessionId, message);
      })
      .finally(() => {
        state.readInFlight = null;
        if (state.readAgain) {
          state.readAgain = false;
          this.scheduleRead(sessionId, state, 0);
        }
      });
    return state.readInFlight;
  }

  private async readLatestInternal(
    sessionId: number,
    state: MirrorState,
  ): Promise<void> {
    const transcriptPath = state.transcriptPath;
    if (!transcriptPath) return;

    const stats = await stat(transcriptPath);
    if (stats.size < state.fileOffset) {
      await this.reloadTranscript(sessionId, state);
      this.emitSnapshot(sessionId, state);
      return;
    }

    if (stats.size === state.fileOffset) {
      return;
    }

    const buffer = Buffer.alloc(stats.size - state.fileOffset);
    const handle = await openFile(transcriptPath, 'r');
    try {
      const { bytesRead } = await handle.read(
        buffer,
        0,
        buffer.length,
        state.fileOffset,
      );
      state.fileOffset += bytesRead;
      const records = this.parseJsonlText(
        buffer.subarray(0, bytesRead).toString('utf8'),
        state,
      );
      if (records.length === 0) return;

      const nextItems =
        await this.claudeRuntime.normalizeTranscriptRecordsForSession(
          sessionId,
          records,
        );
      if (nextItems.length === 0) return;

      state.history = this.mergeTranscriptItems(state.history, nextItems);
      state.lastError = null;
      this.emitHistory(sessionId, state.history);
    } finally {
      await handle.close();
    }
  }

  private async reloadTranscript(
    sessionId: number,
    state: MirrorState,
  ): Promise<void> {
    const ref = await this.claudeRuntime.resolveTranscriptFile(
      sessionId,
      state.claudeSessionId,
    );
    state.claudeSessionId = ref.claudeSessionId;

    if (ref.transcriptPath !== state.transcriptPath) {
      await this.closeWatcher(state);
      state.transcriptPath = ref.transcriptPath;
      state.fileOffset = 0;
      state.partialLine = '';
    }

    if (!state.transcriptPath) {
      state.history = [];
      state.fileOffset = 0;
      state.partialLine = '';
      return;
    }

    const raw = await readFile(state.transcriptPath, 'utf8');
    state.fileOffset = Buffer.byteLength(raw, 'utf8');
    state.partialLine = '';
    const records = this.parseJsonlText(raw, state);
    state.history = await this.claudeRuntime.normalizeTranscriptRecordsForSession(
      sessionId,
      records,
    );
    state.lastError = null;
    this.ensureWatcher(sessionId, state);
  }

  private ensureWatcher(sessionId: number, state: MirrorState): void {
    if (state.watcher || !state.transcriptPath) return;

    const watcher = chokidar.watch(state.transcriptPath, {
      awaitWriteFinish: {
        stabilityThreshold: READ_DEBOUNCE_MS,
        pollInterval: 20,
      },
      atomic: true,
      ignoreInitial: true,
      persistent: true,
    });
    watcher.on('change', () => this.scheduleRead(sessionId, state));
    watcher.on('add', () => {
      void this.reloadTranscript(sessionId, state).then(() =>
        this.emitSnapshot(sessionId, state),
      );
    });
    watcher.on('unlink', () => {
      state.history = [];
      state.fileOffset = 0;
      state.partialLine = '';
      this.emitHistory(sessionId, state.history);
    });
    watcher.on('error', (error) => {
      const message = error instanceof Error ? error.message : String(error);
      state.lastError = message;
      this.emitError(sessionId, message);
    });
    state.watcher = watcher;
  }

  private parseJsonlText(
    text: string,
    state: Pick<MirrorState, 'partialLine'>,
  ): ClaudeTranscriptRecord[] {
    if (!text && !state.partialLine) return [];

    const combined = `${state.partialLine}${text}`;
    const hasFinalLineBreak = /\r?\n$/.test(combined);
    const lines = combined.split(/\r?\n/);
    const completeLines = hasFinalLineBreak ? lines : lines.slice(0, -1);
    const records: ClaudeTranscriptRecord[] = [];

    for (const line of completeLines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      records.push(JSON.parse(trimmed) as ClaudeTranscriptRecord);
    }

    const tail = hasFinalLineBreak ? '' : (lines[lines.length - 1] ?? '');
    const trimmedTail = tail.trim();
    if (!trimmedTail) {
      state.partialLine = '';
      return records;
    }

    try {
      records.push(JSON.parse(trimmedTail) as ClaudeTranscriptRecord);
      state.partialLine = '';
    } catch {
      state.partialLine = tail;
    }
    return records;
  }

  private mergeTranscriptItems(
    current: ClaudeTranscriptItem[],
    next: ClaudeTranscriptItem[],
  ): ClaudeTranscriptItem[] {
    const byId = new Map(current.map((item) => [item.id, item]));
    for (const item of next) {
      byId.set(item.id, item);
    }
    return [...byId.values()].sort((left, right) =>
      left.timestamp.localeCompare(right.timestamp),
    );
  }

  private emitSnapshot(
    sessionId: number,
    state: MirrorState,
    target?: MirrorSend,
  ): void {
    this.emitRuntimeSnapshot(sessionId, state, target);
    this.emitHistory(sessionId, state.history, target);
  }

  private emitRuntimeSnapshot(
    sessionId: number,
    state: MirrorState,
    target?: MirrorSend,
  ): void {
    const event: ClaudeRuntimeEvent = {
      type: 'runtime_snapshot',
      payload: this.toRuntimeStatePayload(sessionId, state),
    };
    if (target) {
      this.safeSend(target, event);
      return;
    }
    this.broadcast(sessionId, event);
  }

  private emitRunState(sessionId: number, state: MirrorState): void {
    this.broadcast(sessionId, {
      type: 'run_state',
      payload: {
        sessionId,
        runPhase: state.runPhase,
        sessionState: state.sessionState,
        canInterrupt: false,
        lastError: state.lastError,
        selectedModel: null,
        reasoningEffort: null,
        fastMode: false,
        permissionMode: null,
        availableModels: [],
        contextUsage: null,
        pendingPermissionRequest: null,
        pendingUserInputRequest: null,
        pendingPrompts: [],
      },
    });
  }

  private emitHistory(
    sessionId: number,
    history: ClaudeTranscriptItem[],
    target?: MirrorSend,
  ): void {
    const event: ClaudeRuntimeEvent = {
      type: 'history_snapshot',
      payload: { sessionId, history },
    };
    if (target) {
      this.safeSend(target, event);
      return;
    }
    this.broadcast(sessionId, event);
  }

  private emitError(sessionId: number, message: string, target?: MirrorSend): void {
    const event: ClaudeRuntimeEvent = {
      type: 'error',
      payload: { sessionId, message },
    };
    if (target) {
      this.safeSend(target, event);
      return;
    }
    this.broadcast(sessionId, event);
  }

  private toRuntimeStatePayload(
    sessionId: number,
    state: MirrorState,
  ): ClaudeRuntimeStatePayload {
    return {
      sessionId,
      claudeSessionId: state.claudeSessionId,
      runPhase: state.runPhase,
      sessionState: state.sessionState,
      canInterrupt: false,
      pendingPermissionRequest: null,
      pendingUserInputRequest: null,
      pendingPrompts: [],
      liveItems: [],
      lastError: state.lastError,
      selectedModel: null,
      reasoningEffort: null,
      fastMode: false,
      permissionMode: null,
      availableModels: [],
      contextUsage: null,
      sessionMetadata: null,
      runtimeStatus: null,
      authStatus: null,
      rateLimit: null,
      notifications: [],
      hooks: [],
      recentHookEvents: [],
      tasks: [],
      taskLifecycle: [],
      subagents: [],
      latestToolProgress: null,
      latestToolSummary: null,
      latestApiRetry: null,
      latestPluginInstall: null,
      latestMemoryRecall: null,
      latestFilesPersisted: null,
      latestElicitationCompletion: null,
      latestPromptSuggestion: null,
      latestCompactBoundary: null,
      latestMirrorError: null,
      warmState: 'cold',
      lastWarmedAt: null,
      lastPromptTiming: null,
    };
  }

  private activityStatusToRunPhase(status: string): ClaudeRunPhase {
    if (status === 'waiting') return 'waiting';
    if (status === 'running') return 'running';
    return 'idle';
  }

  private runPhaseToSessionState(
    phase: ClaudeRunPhase,
  ): ClaudeSessionExecutionState {
    if (phase === 'waiting') return 'requires_action';
    if (phase === 'running') return 'running';
    return 'idle';
  }

  private ensureState(sessionId: number): MirrorState {
    let state = this.states.get(sessionId);
    if (state) return state;

    const activity = this.hooksService.getActivity(sessionId);
    const runPhase = this.activityStatusToRunPhase(activity.activityStatus);
    state = {
      clients: new Set(),
      claudeSessionId: null,
      transcriptPath: null,
      history: [],
      fileOffset: 0,
      partialLine: '',
      watcher: null,
      readInFlight: null,
      readAgain: false,
      debounceTimer: null,
      runPhase,
      sessionState: this.runPhaseToSessionState(runPhase),
      lastError: null,
    };
    this.states.set(sessionId, state);
    return state;
  }

  private broadcast(sessionId: number, event: ClaudeRuntimeEvent): void {
    const state = this.states.get(sessionId);
    if (!state) return;
    for (const client of state.clients) {
      this.safeSend(client, event);
    }
  }

  private safeSend(send: MirrorSend, event: ClaudeRuntimeEvent): void {
    try {
      send(event);
    } catch (error) {
      this.logger.debug(`Failed to send transcript mirror event: ${String(error)}`);
    }
  }

  private async disposeState(
    sessionId: number,
    state: MirrorState,
  ): Promise<void> {
    if (state.debounceTimer) {
      clearTimeout(state.debounceTimer);
      state.debounceTimer = null;
    }
    await this.closeWatcher(state);
    if (this.states.get(sessionId) === state && state.clients.size === 0) {
      this.states.delete(sessionId);
    }
  }

  private async closeWatcher(state: MirrorState): Promise<void> {
    const watcher = state.watcher;
    state.watcher = null;
    if (watcher) {
      await watcher.close().catch(() => undefined);
    }
  }

  async onModuleDestroy(): Promise<void> {
    this.hooksService.off('hook-event', this.hookEventListener);
    this.hooksService.off('status-changed', this.statusChangedListener);
    await Promise.all(
      [...this.states.entries()].map(([sessionId, state]) =>
        this.disposeState(sessionId, state),
      ),
    );
  }
}
