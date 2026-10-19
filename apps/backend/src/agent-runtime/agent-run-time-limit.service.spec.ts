import { EventEmitter } from 'node:events';
import { Logger } from '@nestjs/common';
import { SettingsService } from '../settings/settings.service.js';
import { AgentRunTimeLimitService } from './agent-run-time-limit.service.js';
import { AgentRuntimeRegistryService } from './agent-runtime-registry.service.js';
import type { AgentRuntimeProvider } from './agent-runtime.types.js';

const HOUR = 60 * 60 * 1_000;

function provider(id: string) {
  return Object.assign(new EventEmitter(), {
    info: { id },
    interrupt: jest.fn().mockResolvedValue(undefined),
  }) as unknown as AgentRuntimeProvider & { interrupt: jest.Mock };
}

function state(
  p: AgentRuntimeProvider,
  sessionId: number,
  runPhase = 'running',
  type = 'run_state',
) {
  p.emit('event', {
    type,
    payload: {
      sessionId,
      runPhase,
      canInterrupt: ['running', 'waiting'].includes(runPhase),
    },
  });
}

describe('AgentRunTimeLimitService', () => {
  let service: AgentRunTimeLimitService;
  let providers: ReturnType<typeof provider>[];
  let getLimit: jest.Mock;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    jest.spyOn(Logger.prototype, 'error').mockImplementation();
    providers = ['claude', 'codex', 'pi', 'opencode'].map(provider);
    getLimit = jest.fn(() => 1);
    service = new AgentRunTimeLimitService(
      new AgentRuntimeRegistryService(providers),
      { getRunTimeLimitHours: getLimit } as unknown as SettingsService,
    );
    service.onModuleInit();
  });

  afterEach(() => {
    service.onModuleDestroy();
    expect(jest.getTimerCount()).toBe(0);
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it.each([0, 1, 2, 3])(
    'interrupts provider %i once at the configured deadline',
    async (index) => {
      const p = providers[index];
      const events: unknown[] = [];
      p.on('event', (event) => events.push(event));
      state(p, 42);
      await jest.advanceTimersByTimeAsync(HOUR - 1);
      expect(p.interrupt).not.toHaveBeenCalled();
      await jest.advanceTimersByTimeAsync(1);
      expect(p.interrupt).toHaveBeenCalledWith(42);
      expect(events).toContainEqual({
        type: 'error',
        payload: {
          sessionId: 42,
          message: expect.stringContaining('1-hour runtime limit'),
        },
      });
      state(p, 42);
      await jest.advanceTimersByTimeAsync(HOUR);
      expect(p.interrupt).toHaveBeenCalledTimes(1);
    },
  );

  it('does not extend the deadline on progress, queue changes, snapshots or input waits', async () => {
    const p = providers[0];
    state(p, 1);
    await jest.advanceTimersByTimeAsync(HOUR / 2);
    state(p, 1, 'waiting');
    state(p, 1, 'waiting', 'runtime_snapshot');
    state(p, 1);
    await jest.advanceTimersByTimeAsync(HOUR / 2);
    expect(p.interrupt).toHaveBeenCalledTimes(1);
  });

  it.each(['idle', 'error'])(
    'clears the deadline on %s and gives the next response a fresh clock',
    async (phase) => {
      const p = providers[0];
      state(p, 1);
      await jest.advanceTimersByTimeAsync(HOUR / 2);
      state(p, 1, phase);
      await jest.advanceTimersByTimeAsync(HOUR);
      expect(p.interrupt).not.toHaveBeenCalled();
      state(p, 1);
      await jest.advanceTimersByTimeAsync(HOUR - 1);
      expect(p.interrupt).not.toHaveBeenCalled();
      await jest.advanceTimersByTimeAsync(1);
      expect(p.interrupt).toHaveBeenCalledTimes(1);
    },
  );

  it('keeps unlimited responses unlimited when the setting changes during the response', async () => {
    getLimit.mockReturnValue(0);
    state(providers[0], 1);
    getLimit.mockReturnValue(0.5);
    state(providers[0], 1);
    await jest.advanceTimersByTimeAsync(2 * HOUR);
    expect(providers[0].interrupt).not.toHaveBeenCalled();
    state(providers[0], 1, 'idle');
    state(providers[0], 1);
    await jest.advanceTimersByTimeAsync(HOUR / 2);
    expect(providers[0].interrupt).toHaveBeenCalledTimes(1);
  });

  it('latches the configured limit until completion', async () => {
    state(providers[0], 1);
    getLimit.mockReturnValue(0);
    state(providers[0], 1);
    await jest.advanceTimersByTimeAsync(HOUR);
    expect(providers[0].interrupt).toHaveBeenCalledTimes(1);
  });

  it('isolates deadlines by provider and session and cancels closed sessions', async () => {
    state(providers[0], 1);
    state(providers[1], 1);
    state(providers[0], 2);
    service.cancelSession(1);
    await jest.advanceTimersByTimeAsync(HOUR);
    expect(providers[0].interrupt.mock.calls).toEqual([[2]]);
    expect(providers[1].interrupt).not.toHaveBeenCalled();
  });

  it('reports interrupt failures without an unhandled rejection', async () => {
    providers[0].interrupt.mockRejectedValue(new Error('Stop not confirmed'));
    const events: unknown[] = [];
    providers[0].on('event', (event) => events.push(event));
    state(providers[0], 1);
    await jest.advanceTimersByTimeAsync(HOUR);
    expect(events).toContainEqual({
      type: 'error',
      payload: {
        sessionId: 1,
        message: expect.stringContaining('stopping failed: Stop not confirmed'),
      },
    });
  });

  it('removes listeners and deadlines on shutdown', async () => {
    state(providers[0], 1);
    service.onModuleDestroy();
    state(providers[0], 2);
    await jest.advanceTimersByTimeAsync(HOUR);
    expect(providers[0].interrupt).not.toHaveBeenCalled();
    for (const p of providers) expect(p.listenerCount('event')).toBe(0);
  });
});
