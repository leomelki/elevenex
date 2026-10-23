import { EventEmitter } from 'node:events';
import { z } from 'zod';
import { DeltaCursorStore } from '../tool-registry/delta-cursor.store.js';
import { DeepLinkBuilder } from '../deep-link/deep-link.builder.js';
import { ToolError, type ToolContext } from '../tool-registry/tool.types.js';
import { resumePendingPromptsTool } from '../tools/drive/resume-pending-prompts.tool.js';
import { promptSessionTool } from '../tools/drive/prompt-session.tool.js';
import { DRIVE_TOOLS } from '../tools/drive/index.js';
import { sessionStatusTool } from '../tools/observe/session-status.tool.js';
import { pollSessionStatusTool } from '../tools/observe/poll-session-status.tool.js';
import { awaitSessionEventTool } from '../tools/observe/await-session-event.tool.js';
import {
  hasPausedQueue,
  hasQueuedWork,
  isSessionSettled,
  type SessionRuntimeSnapshot,
} from '../tools/session-runtime-state.util.js';

const paused: SessionRuntimeSnapshot = {
  sessionState: 'idle',
  runPhase: 'idle',
  queuePaused: true,
  pendingPrompts: [{ id: 'old', prompt: 'Existing work' }],
};
const running = {
  sessionState: 'running',
  runPhase: 'running',
  queuePaused: false,
  pendingPrompts: [],
};

function fixture(state: SessionRuntimeSnapshot = paused, provider = 'claude') {
  const runtime = Object.assign(new EventEmitter(), {
    getRuntimeState: jest.fn().mockResolvedValue(state),
    resumePendingPrompts: jest.fn().mockResolvedValue(undefined),
    submitPrompt: jest.fn().mockResolvedValue(undefined),
  });
  const sessions = Object.assign(new EventEmitter(), {
    findOne: jest.fn(async (id: number) => ({
      id,
      status: 'active',
      surface: 'session',
      activeAgentProvider: provider,
    })),
    assertSessionWorkspaceLinked: jest.fn().mockResolvedValue(undefined),
  });
  const services = {
    sessions,
    agentRuntime: { getProvider: jest.fn(() => runtime) },
    conversationExport: {
      buildModel: jest.fn().mockRejectedValue(new Error('not needed')),
    },
  };
  const ctx = {
    services,
    agentSessionId: 42,
    caps: {
      isAgent: true,
      canMutate: true,
      canDestroy: true,
      canUseHumanChannel: true,
    },
    cursors: new DeltaCursorStore(),
    deepLink: new DeepLinkBuilder(),
    human: {},
    signal: new AbortController().signal,
    mcpSessionId: 'paused-queue',
  } as unknown as ToolContext;
  return { runtime, sessions, services, ctx };
}

describe('explicit paused queue recovery', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('registers an explicit mutating, self-protected session-only resume tool', () => {
    expect(DRIVE_TOOLS).toContain(resumePendingPromptsTool);
    expect(resumePendingPromptsTool.mutates).toBe(true);
    expect(resumePendingPromptsTool.disallowSelfTarget).toBe('session');
    expect(Object.keys(resumePendingPromptsTool.inputShape)).toEqual([
      'sessionId',
    ]);
    const input = z.object(resumePendingPromptsTool.inputShape);
    expect(input.safeParse({}).success).toBe(false);
    expect(input.safeParse({ sessionId: 0 }).success).toBe(false);
  });

  it.each(['claude', 'codex', 'opencode'])(
    'resumes the existing queue through the resolved %s provider',
    async (provider) => {
      const { runtime, sessions, services, ctx } = fixture(paused, provider);
      const res = await resumePendingPromptsTool.handler({ sessionId: 7 }, ctx);
      expect(sessions.assertSessionWorkspaceLinked).toHaveBeenCalledWith(7);
      expect(services.agentRuntime.getProvider).toHaveBeenCalledWith(provider);
      expect(runtime.resumePendingPrompts).toHaveBeenCalledWith(7);
      expect(runtime.submitPrompt).not.toHaveBeenCalled();
      expect(res.data).toEqual({ sessionId: 7, resumed: true, provider });
      expect(res.deepLink).toBe('/sessions/7');
    },
  );

  it('does not resume when the workspace is unavailable', async () => {
    const { runtime, sessions, ctx } = fixture();
    sessions.assertSessionWorkspaceLinked.mockRejectedValue(
      new Error('workspace unavailable'),
    );
    await expect(
      resumePendingPromptsTool.handler({ sessionId: 7 }, ctx),
    ).rejects.toThrow('workspace unavailable');
    expect(runtime.resumePendingPrompts).not.toHaveBeenCalled();
  });

  it('maps a missing session before provider dispatch', async () => {
    const { runtime, sessions, ctx } = fixture();
    sessions.findOne.mockRejectedValue(new Error('not found'));
    await expect(
      resumePendingPromptsTool.handler({ sessionId: 7 }, ctx),
    ).rejects.toBeInstanceOf(ToolError);
    expect(runtime.resumePendingPrompts).not.toHaveBeenCalled();
  });

  it('does not start queued work in an archived session', async () => {
    const { runtime, sessions, ctx } = fixture();
    sessions.findOne.mockResolvedValue({
      id: 7,
      status: 'archived',
      surface: 'session',
      activeAgentProvider: 'claude',
    });
    await expect(
      resumePendingPromptsTool.handler({ sessionId: 7 }, ctx),
    ).rejects.toMatchObject({ code: 'session_archived' });
    expect(runtime.resumePendingPrompts).not.toHaveBeenCalled();
  });

  it('propagates a failed resume rather than claiming success', async () => {
    const { runtime, ctx } = fixture();
    runtime.resumePendingPrompts.mockRejectedValue(
      new Error('provider failed'),
    );
    await expect(
      resumePendingPromptsTool.handler({ sessionId: 7 }, ctx),
    ).rejects.toThrow('provider failed');
  });

  it('keeps paused work unfinished, while an empty paused queue is settled', () => {
    expect(hasPausedQueue(paused)).toBe(true);
    expect(hasQueuedWork(paused)).toBe(true);
    expect(isSessionSettled(paused)).toBe(false);
    expect(hasPausedQueue({ ...paused, pendingPrompts: [] })).toBe(false);
    expect(isSessionSettled({ ...paused, pendingPrompts: [] })).toBe(true);
  });

  it.each(['idle pair', 'phase only'])(
    'reports paused %s state and an explicit action instead of automatic progress',
    async (snapshot) => {
      const { ctx } = fixture(
        snapshot === 'idle pair'
          ? paused
          : { ...paused, sessionState: undefined },
      );
      const res = await sessionStatusTool.handler({ sessionId: 7 }, ctx);
      expect(res.data).toMatchObject({
        runtimeState: 'paused',
        hasQueuedWork: true,
        queuePaused: true,
        pendingPromptCount: 1,
      });
      expect(res.nextStep).toContain('resume_pending_prompts');
      expect(res.nextStep).toContain('will not resume automatically');
      expect(res.nextStep).not.toContain('Not actually idle');
    },
  );

  it('does not hide an active turn while its future prompt queue is paused', async () => {
    const { ctx } = fixture({
      ...paused,
      sessionState: 'running',
      runPhase: 'running',
    });
    const res = await sessionStatusTool.handler({ sessionId: 7 }, ctx);
    expect(res.data).toMatchObject({
      runtimeState: 'running',
      queuePaused: true,
    });
    expect(res.nextStep).toContain('resume_pending_prompts');
  });

  it('keeps permission guidance together with explicit queue-resume guidance', async () => {
    const { ctx } = fixture({
      ...paused,
      sessionState: 'requires_action',
      pendingPermissionRequest: {},
    } as SessionRuntimeSnapshot);
    const res = await sessionStatusTool.handler({ sessionId: 7 }, ctx);
    expect(res.nextStep).toContain('get_pending_action');
    expect(res.nextStep).toContain('resume_pending_prompts');
  });

  it('does not resume old work when prompt_session enqueues a new prompt', async () => {
    const { ctx, runtime } = fixture();
    runtime.getRuntimeState.mockResolvedValueOnce(paused).mockResolvedValue({
      ...paused,
      pendingPrompts: [
        ...paused.pendingPrompts!,
        { id: 'new', prompt: 'New work' },
      ],
    });
    const res = await promptSessionTool.handler(
      { sessionId: 7, prompt: 'New work' },
      ctx,
    );
    expect(runtime.submitPrompt).toHaveBeenCalledWith(7, 'New work');
    expect(runtime.resumePendingPrompts).not.toHaveBeenCalled();
    expect(res.data).toMatchObject({
      accepted: true,
      queued: true,
      status: 'paused',
      queuePaused: true,
      pendingPromptCount: 2,
    });
    expect(res.nextStep).toContain('resume_pending_prompts');
    expect(jest.getTimerCount()).toBe(0);
  });

  for (const name of ['poll', 'await'] as const) {
    const wait = (ctx: ToolContext) =>
      name === 'poll'
        ? pollSessionStatusTool.handler({ sessionId: 7 }, ctx)
        : awaitSessionEventTool.handler(
            { sessionId: 7, events: ['completed'], timeoutMs: 5_000 },
            ctx,
          );

    it(`${name} returns an actionable paused result immediately, even when waiting only for completion`, async () => {
      const { ctx, runtime, sessions, services } = fixture();
      const res = await wait(ctx);
      expect(res.data).toMatchObject({
        status: 'paused',
        queuePaused: true,
        pendingPromptCount: 1,
      });
      if (name === 'await') expect(res.data).toMatchObject({ event: 'paused' });
      expect(res.nextStep).toContain('resume_pending_prompts');
      expect(services.conversationExport.buildModel).not.toHaveBeenCalled();
      expect(runtime.listenerCount('event')).toBe(0);
      expect(sessions.listenerCount('session-status-changed')).toBe(0);
      expect(jest.getTimerCount()).toBe(0);
    });

    it.each(['run_state', 'complete', 'background_work'])(
      `${name} stops waiting when %s reveals a paused queue`,
      async (type) => {
        const { ctx, runtime, sessions } = fixture(running);
        const pending = wait(ctx);
        await jest.advanceTimersByTimeAsync(0);
        runtime.getRuntimeState.mockResolvedValue(paused);
        runtime.emit('event', { type, payload: { sessionId: 7, ...paused } });
        const res = await pending;
        expect(res.data).toMatchObject({
          status: 'paused',
          queuePaused: true,
          pendingPromptCount: 1,
        });
        expect(res.nextStep).toContain('resume_pending_prompts');
        expect(runtime.listenerCount('event')).toBe(0);
        expect(sessions.listenerCount('session-status-changed')).toBe(0);
        expect(jest.getTimerCount()).toBe(0);
      },
    );

    it(`${name} reports a pause discovered on its final timeout read`, async () => {
      const { ctx, runtime } = fixture(running);
      const pending = wait(ctx);
      await jest.advanceTimersByTimeAsync(0);
      runtime.getRuntimeState.mockResolvedValue(paused);
      await jest.advanceTimersByTimeAsync(name === 'poll' ? 170_000 : 5_000);
      const res = await pending;
      expect(res.data).toMatchObject({
        status: 'paused',
        queuePaused: true,
        pendingPromptCount: 1,
      });
      expect(res.nextStep).toContain('resume_pending_prompts');
      expect(res.nextStep).not.toContain('re-call');
      expect(jest.getTimerCount()).toBe(0);
    });

    it(`${name} catches a pause between its initial read and listener registration`, async () => {
      const { ctx, runtime } = fixture();
      runtime.getRuntimeState
        .mockResolvedValueOnce(running)
        .mockResolvedValue(paused);
      const res = await wait(ctx);
      expect(res.data).toMatchObject({
        status: 'paused',
        pendingPromptCount: 1,
      });
      expect(jest.getTimerCount()).toBe(0);
    });
  }
});
