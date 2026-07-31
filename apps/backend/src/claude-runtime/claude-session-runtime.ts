import {
  query,
  type ModelInfo,
  type Options,
  type PermissionMode,
  type Query,
  type SDKControlGetContextUsageResponse,
  type SDKMessage,
  type SDKUserMessage,
  type Settings,
} from '@anthropic-ai/claude-agent-sdk';
import type { ClaudeRuntimeWarmState } from './claude-runtime.types.js';

interface ActiveTurn {
  resolve: () => void;
  reject: (error: unknown) => void;
  settled: boolean;
}

export interface ClaudeSessionRuntimeDeps {
  sessionId: number;
  options: Options;
  onMessage(message: SDKMessage): Promise<void> | void;
  onFatal(error: unknown): void;
  onClosed(): void;
  onWarmStateChange?(state: ClaudeRuntimeWarmState): void;
  prewarmIdleShutdownMs: number;
  postTurnIdleShutdownMs: number;
  // Consulted right before an idle timeout would close the underlying process.
  // Backgrounded work (e.g. a `run_in_background` shell, or a subagent/Task
  // still executing) keeps running inside that same process after the turn
  // that launched it has already resolved — closing on schedule would kill it
  // mid-flight with no chance to record completion, which is what produces
  // "no completion record" orphaned-task warnings on the next resume.
  isBackgroundWorkActive?(): boolean;
}

export class ClaudeSessionRuntime {
  private queryInstance: Query | null = null;
  private outputPump: Promise<void> | null = null;
  private startPromise: Promise<void> | null = null;
  private readonly inputQueue: SDKUserMessage[] = [];
  private inputWake: (() => void) | null = null;
  private turnChain: Promise<void> = Promise.resolve();
  private activeTurn: ActiveTurn | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private closedNotified = false;
  private warmStateValue: ClaudeRuntimeWarmState = 'cold';
  private startedAtMsValue: number | null = null;
  private lastUsedAtMsValue: number | null = null;
  private lastWarmedAtMsValue: number | null = null;
  private hasSubmittedTurnValue = false;

  constructor(private readonly deps: ClaudeSessionRuntimeDeps) {}

  get warmState(): ClaudeRuntimeWarmState {
    return this.warmStateValue;
  }

  get startedAtMs(): number | null {
    return this.startedAtMsValue;
  }

  get lastUsedAtMs(): number | null {
    return (
      this.lastUsedAtMsValue ??
      this.lastWarmedAtMsValue ??
      this.startedAtMsValue
    );
  }

  get lastWarmedAtMs(): number | null {
    return this.lastWarmedAtMsValue;
  }

  get hasSubmittedTurn(): boolean {
    return this.hasSubmittedTurnValue;
  }

  get isIdle(): boolean {
    return this.activeTurn === null;
  }

  async ensureStarted(reason: 'prewarm' | 'turn' = 'turn'): Promise<void> {
    if (this.closed) {
      throw new Error('Claude runtime is closed.');
    }

    this.clearIdleTimer();
    if (this.queryInstance) {
      await this.startPromise;
      return;
    }

    this.setWarmState(reason === 'prewarm' ? 'prewarming' : 'cold');
    const runtimeQuery = query({
      prompt: this.createPromptIterable(),
      options: this.deps.options,
    });
    this.queryInstance = runtimeQuery;
    this.startedAtMsValue = Date.now();
    this.lastUsedAtMsValue = this.startedAtMsValue;
    this.outputPump = this.pumpMessages(runtimeQuery);
    const initialization =
      typeof runtimeQuery.initializationResult === 'function'
        ? runtimeQuery.initializationResult()
        : Promise.resolve();
    this.startPromise = initialization
      .then(() => {
        if (this.closed || this.queryInstance !== runtimeQuery) {
          return;
        }
        this.lastWarmedAtMsValue = Date.now();
        this.lastUsedAtMsValue = this.lastWarmedAtMsValue;
        this.setWarmState('warm');
        if (!this.hasSubmittedTurnValue) {
          this.scheduleIdleShutdown();
        }
      })
      .catch((error) => {
        this.handleFatal(error, runtimeQuery);
        throw error;
      });

    await this.startPromise;
  }

  submitTurn(input: SDKUserMessage): Promise<void> {
    const turn = this.turnChain
      .catch(() => undefined)
      .then(() => this.runTurn(input));
    this.turnChain = turn.catch(() => undefined);
    return turn;
  }

  async interrupt(): Promise<void> {
    const runtimeQuery = this.queryInstance;
    try {
      await runtimeQuery?.interrupt?.();
    } finally {
      this.resolveActiveTurn();
      this.lastUsedAtMsValue = Date.now();
      if (!this.closed) {
        this.scheduleIdleShutdown();
      }
    }
  }

  async setModel(model?: string): Promise<void> {
    await this.queryInstance?.setModel?.(model);
  }

  async setPermissionMode(mode: PermissionMode): Promise<void> {
    await this.queryInstance?.setPermissionMode?.(mode);
  }

  async applyFlagSettings(settings: Settings): Promise<void> {
    await this.queryInstance?.applyFlagSettings?.(settings);
  }

  async supportedModels(): Promise<ModelInfo[]> {
    await this.ensureStarted('prewarm');
    return this.queryInstance?.supportedModels?.() ?? [];
  }

  async getContextUsage(): Promise<SDKControlGetContextUsageResponse> {
    await this.ensureStarted('prewarm');
    if (!this.queryInstance?.getContextUsage) {
      throw new Error('Claude runtime is not available.');
    }
    return this.queryInstance.getContextUsage();
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }

    this.closed = true;
    this.setWarmState('closing');
    this.clearIdleTimer();
    this.resolveActiveTurn();
    this.wakeInput();

    const runtimeQuery = this.queryInstance;
    runtimeQuery?.close();
    if (!runtimeQuery) {
      this.notifyClosed();
      return;
    }

    await this.outputPump?.catch(() => undefined);
  }

  private async runTurn(input: SDKUserMessage): Promise<void> {
    if (this.closed) {
      throw new Error('Claude runtime is closed.');
    }

    this.clearIdleTimer();
    this.hasSubmittedTurnValue = true;
    this.lastUsedAtMsValue = Date.now();

    const turnPromise = new Promise<void>((resolve, reject) => {
      this.activeTurn = { resolve, reject, settled: false };
      this.inputQueue.push(input);
      this.wakeInput();
    });

    try {
      await this.ensureStarted('turn');
      await turnPromise;
    } catch (error) {
      this.rejectActiveTurn(error);
      throw error;
    } finally {
      this.lastUsedAtMsValue = Date.now();
      if (!this.closed) {
        this.scheduleIdleShutdown();
      }
    }
  }

  private async *createPromptIterable(): AsyncIterable<SDKUserMessage> {
    while (!this.closed) {
      const next = this.inputQueue.shift();
      if (next) {
        yield next;
        continue;
      }

      await new Promise<void>((resolve) => {
        this.inputWake = resolve;
      });
    }
  }

  private async pumpMessages(runtimeQuery: Query): Promise<void> {
    try {
      for await (const message of runtimeQuery) {
        await this.deps.onMessage(message);
        if (message.type === 'result') {
          this.resolveActiveTurn();
        }
      }
    } catch (error) {
      if (!this.closed) {
        this.handleFatal(error, runtimeQuery);
      }
    } finally {
      if (this.activeTurn && !this.closed) {
        this.rejectActiveTurn(
          new Error('Claude runtime exited before completing the turn.'),
        );
      } else {
        this.resolveActiveTurn();
      }
      if (this.queryInstance === runtimeQuery) {
        this.queryInstance = null;
        this.startPromise = null;
        this.outputPump = null;
      }
      if (!this.closed) {
        this.setWarmState('cold');
      }
      this.notifyClosed();
    }
  }

  private handleFatal(error: unknown, runtimeQuery: Query): void {
    if (this.queryInstance !== runtimeQuery) {
      return;
    }

    this.queryInstance = null;
    this.startPromise = null;
    this.outputPump = null;
    this.clearIdleTimer();
    this.rejectActiveTurn(error);
    this.setWarmState('cold');
    this.deps.onFatal(error);
  }

  private resolveActiveTurn(): void {
    const turn = this.activeTurn;
    if (!turn || turn.settled) {
      return;
    }

    turn.settled = true;
    this.activeTurn = null;
    turn.resolve();
  }

  private rejectActiveTurn(error: unknown): void {
    const turn = this.activeTurn;
    if (!turn || turn.settled) {
      return;
    }

    turn.settled = true;
    this.activeTurn = null;
    turn.reject(error);
  }

  private scheduleIdleShutdown(): void {
    this.clearIdleTimer();
    const timeoutMs = this.hasSubmittedTurnValue
      ? this.deps.postTurnIdleShutdownMs
      : this.deps.prewarmIdleShutdownMs;
    this.idleTimer = setTimeout(() => {
      if (this.deps.isBackgroundWorkActive?.()) {
        this.scheduleIdleShutdown();
        return;
      }
      void this.close();
    }, timeoutMs);
    this.idleTimer.unref?.();
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  private wakeInput(): void {
    const wake = this.inputWake;
    this.inputWake = null;
    wake?.();
  }

  private setWarmState(state: ClaudeRuntimeWarmState): void {
    if (this.warmStateValue === state) {
      return;
    }
    this.warmStateValue = state;
    this.deps.onWarmStateChange?.(state);
  }

  private notifyClosed(): void {
    if (this.closedNotified) {
      return;
    }
    this.closedNotified = true;
    this.deps.onClosed();
  }
}
