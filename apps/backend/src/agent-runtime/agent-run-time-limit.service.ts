import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { SettingsService } from '../settings/settings.service.js';
import { AgentRuntimeRegistryService } from './agent-runtime-registry.service.js';
import type {
  AgentRuntimeEvent,
  AgentRuntimeProvider,
} from './agent-runtime.types.js';

interface RunDeadline {
  timer: ReturnType<typeof setTimeout> | null;
}

/** One elapsed-time deadline per continuous response, independent of UI clients. */
@Injectable()
export class AgentRunTimeLimitService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AgentRunTimeLimitService.name);
  private readonly runs = new Map<string, RunDeadline>();
  private readonly listeners = new Map<
    AgentRuntimeProvider,
    (event: AgentRuntimeEvent) => void
  >();

  constructor(
    private readonly registry: AgentRuntimeRegistryService,
    private readonly settings: SettingsService,
  ) {}

  onModuleInit(): void {
    for (const info of this.registry.listProviders()) {
      const provider = this.registry.getProvider(info.id);
      const listener = (event: AgentRuntimeEvent) =>
        this.track(provider, event);
      this.listeners.set(provider, listener);
      provider.on('event', listener);
    }
  }

  private track(
    provider: AgentRuntimeProvider,
    event: AgentRuntimeEvent,
  ): void {
    if (!['run_state', 'runtime_snapshot'].includes(event.type)) return;
    const state = event.payload as {
      sessionId: number;
      runPhase?: string;
      canInterrupt?: boolean;
    };
    const key = `${provider.info.id}:${state.sessionId}`;
    if (state.runPhase === 'idle' || state.runPhase === 'error') {
      this.clear(key);
      return;
    }
    if (
      !state.canInterrupt ||
      !['running', 'waiting'].includes(state.runPhase ?? '') ||
      this.runs.has(key)
    )
      return;

    // Latch even an unlimited response: changing settings mid-response must
    // not start a fresh clock on an arbitrary progress/queue/permission event.
    const deadline: RunDeadline = { timer: null };
    this.runs.set(key, deadline);
    const hours = this.settings.getRunTimeLimitHours();
    if (hours <= 0) return;
    deadline.timer = setTimeout(
      () => {
        if (this.runs.get(key) !== deadline) return;
        deadline.timer = null;
        const message = `The ${hours}-hour runtime limit was reached. Stopping this run; send a new message to continue.`;
        this.logger.warn(
          `Runtime limit reached provider=${provider.info.id} session=${state.sessionId} hours=${hours}`,
        );
        provider.emit('event', {
          type: 'error',
          payload: { sessionId: state.sessionId, message },
        });
        // Use the same stop path as the user: providers cancel their active turn,
        // resolve pending input and pause queued prompts before awaiting teardown.
        void provider.interrupt(state.sessionId).catch((error: unknown) => {
          if (this.runs.get(key) !== deadline) return;
          const detail = error instanceof Error ? error.message : String(error);
          this.logger.error(`Failed to stop timed-out run ${key}: ${detail}`);
          provider.emit('event', {
            type: 'error',
            payload: {
              sessionId: state.sessionId,
              message: `Runtime limit reached, but stopping failed: ${detail}`,
            },
          });
        });
      },
      Math.max(1, hours * 60 * 60 * 1_000),
    );
    deadline.timer.unref();
  }

  private clear(key: string): void {
    const deadline = this.runs.get(key);
    if (deadline?.timer) clearTimeout(deadline.timer);
    this.runs.delete(key);
  }

  cancelSession(sessionId: number): void {
    for (const info of this.registry.listProviders())
      this.clear(`${info.id}:${sessionId}`);
  }

  onModuleDestroy(): void {
    for (const [provider, listener] of this.listeners)
      provider.off('event', listener);
    this.listeners.clear();
    for (const key of this.runs.keys()) this.clear(key);
  }
}
