import { EventEmitter } from 'node:events';
import { DeltaCursorStore } from '../tool-registry/delta-cursor.store.js';
import { DeepLinkBuilder } from '../deep-link/deep-link.builder.js';
import { ToolError } from '../tool-registry/tool.types.js';
import type { ToolContext } from '../tool-registry/tool.types.js';
import { promptSessionTool } from '../tools/drive/prompt-session.tool.js';
import { interruptSessionTool } from '../tools/drive/interrupt-session.tool.js';
import { forkSessionTool } from '../tools/drive/fork-session.tool.js';
import { archiveSessionTool } from '../tools/drive/archive-session.tool.js';
import { resetSessionTool } from '../tools/drive/reset-session.tool.js';
import { getPendingActionTool } from '../tools/drive/get-pending-action.tool.js';
import { resolveActionTool } from '../tools/drive/resolve-action.tool.js';
import { setProviderTool } from '../tools/drive/set-provider.tool.js';
import { setModelTool } from '../tools/drive/set-model.tool.js';
import { setPermissionModeTool } from '../tools/drive/set-permission-mode.tool.js';
import { DRIVE_TOOLS } from '../tools/drive/index.js';

function makeCtx(services: unknown): ToolContext {
  return {
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
    human: { notify: jest.fn(), show: jest.fn(), requestApproval: jest.fn() },
    signal: new AbortController().signal,
    mcpSessionId: 'test',
  } as unknown as ToolContext;
}

/**
 * A baseline runtime provider double with every method drive tools may call.
 * It's a real EventEmitter (like the production ClaudeRuntimeService) so
 * prompt_session's blocking wait can subscribe to `.on('event', ...)`.
 */
function makeRuntime(overrides: Record<string, unknown> = {}) {
  return Object.assign(new EventEmitter(), {
    submitPrompt: jest.fn().mockResolvedValue(undefined),
    interrupt: jest.fn().mockResolvedValue(undefined),
    setSelectedModel: jest.fn().mockResolvedValue({ selectedModel: null }),
    getRuntimeState: jest.fn().mockResolvedValue({
      sessionState: 'idle',
      runPhase: 'idle',
      pendingPermissionRequest: null,
      pendingUserInputRequest: null,
    }),
    approvePermission: jest.fn().mockResolvedValue(undefined),
    denyPermission: jest.fn().mockResolvedValue(undefined),
    setPermissionMode: jest.fn().mockResolvedValue({}),
    ...overrides,
  });
}

/** Build a services bag with a session and a single runtime provider. */
function makeServices(opts: {
  session?: Record<string, unknown> | null;
  runtime?: ReturnType<typeof makeRuntime>;
  sessionsOverrides?: Record<string, unknown>;
}) {
  const session =
    opts.session === undefined
      ? { id: 7, name: 'S7', status: 'created', activeAgentProvider: 'claude' }
      : opts.session;
  const runtime = opts.runtime ?? makeRuntime();
  return {
    runtime,
    services: {
      // Also a real EventEmitter, like the production SessionsService, so
      // prompt_session's `session-status-changed` listener can attach.
      sessions: Object.assign(new EventEmitter(), {
        findOne: jest
          .fn()
          .mockImplementation(async () => {
            if (session === null) throw new Error('not found');
            return session;
          }),
        start: jest.fn().mockResolvedValue({ success: true, resumed: false }),
        fork: jest
          .fn()
          .mockResolvedValue({ id: 99, name: 'S7 (fork)', status: 'created', activeAgentProvider: 'claude' }),
        archiveAndStop: jest.fn().mockResolvedValue({ id: 7, status: 'archived' }),
        reset: jest
          .fn()
          .mockResolvedValue({ id: 100, name: 'S7 (reset)', status: 'created', activeAgentProvider: 'claude' }),
        updateActiveAgentProvider: jest
          .fn()
          .mockResolvedValue({ id: 7, activeAgentProvider: 'codex' }),
        ...opts.sessionsOverrides,
      }),
      agentRuntime: {
        getProvider: jest.fn().mockReturnValue(runtime),
        getProviderFeature: jest.fn().mockReturnValue(runtime),
      },
    },
  };
}

describe('Drive tool group', () => {
  it('exports all ten tools with required flags', () => {
    const names = DRIVE_TOOLS.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        'archive_session',
        'fork_session',
        'get_pending_action',
        'interrupt_session',
        'prompt_session',
        'reset_session',
        'resolve_action',
        'set_model',
        'set_permission_mode',
        'set_provider',
      ].sort(),
    );
    const byName = Object.fromEntries(DRIVE_TOOLS.map((t) => [t.name, t]));
    expect(byName.prompt_session.costClass).toBe('heavy');
    expect(byName.prompt_session.mutates).toBe(true);
    expect(byName.reset_session.destructive).toBe(true);
    expect(byName.reset_session.mutates).toBe(true);
    expect(byName.get_pending_action.annotations?.readOnlyHint).toBe(true);
    // Every input field carries a describe.
    for (const tool of DRIVE_TOOLS) {
      for (const field of Object.values(tool.inputShape)) {
        expect((field as { description?: string }).description).toBeTruthy();
      }
    }
  });

  describe('prompt_session', () => {
    it('starts a non-running session, submits, and returns accepted without blocking', async () => {
      const { services, runtime } = makeServices({
        session: { id: 7, status: 'created', activeAgentProvider: 'claude' },
      });
      const res = await promptSessionTool.handler(
        { sessionId: 7, prompt: 'do the thing' },
        makeCtx(services),
      );
      expect(services.sessions.start).toHaveBeenCalledWith(7);
      expect(runtime.submitPrompt).toHaveBeenCalledWith(7, 'do the thing');
      expect(res.data).toMatchObject({ sessionId: 7, accepted: true, provider: 'claude' });
      expect(res.deepLink).toBe('/sessions/7');
    });

    it('does not re-start an already active session', async () => {
      const { services } = makeServices({
        session: { id: 7, status: 'active', activeAgentProvider: 'claude' },
      });
      await promptSessionTool.handler({ sessionId: 7, prompt: 'go' }, makeCtx(services));
      expect(services.sessions.start).not.toHaveBeenCalled();
    });

    it('throws a ToolError when the session is not found', async () => {
      const { services } = makeServices({ session: null });
      await expect(
        promptSessionTool.handler({ sessionId: 404, prompt: 'go' }, makeCtx(services)),
      ).rejects.toBeInstanceOf(ToolError);
    });

    it('does not report completed when the prompt was queued behind live background work', async () => {
      // submitPrompt() silently queues instead of running when the runtime is
      // still busy with a `run_in_background` task (shouldQueueBehindBackground),
      // so sessionState/runPhase are left over from the PREVIOUS finished turn:
      // idle/idle, even though nothing has actually run yet.
      const runtime = makeRuntime({
        getRuntimeState: jest.fn().mockResolvedValue({
          sessionState: 'idle',
          runPhase: 'idle',
          backgroundWork: [{ id: 'task:1', kind: 'task', label: 'run tests' }],
          pendingPrompts: [],
          pendingPermissionRequest: null,
          pendingUserInputRequest: null,
        }),
      });
      const { services } = makeServices({
        session: { id: 7, status: 'active', activeAgentProvider: 'claude' },
        runtime,
      });

      const pending = promptSessionTool.handler(
        { sessionId: 7, prompt: 'go' },
        makeCtx(services),
      );
      // Give the handler a tick to run past the pre-check and subscribe.
      await new Promise((r) => setTimeout(r, 10));
      runtime.emit('event', {
        type: 'run_state',
        payload: {
          sessionId: 7,
          sessionState: 'idle',
          runPhase: 'idle',
          backgroundWork: [{ id: 'task:1', kind: 'task', label: 'run tests' }],
          pendingPrompts: [],
        },
      });
      await new Promise((r) => setTimeout(r, 10));

      // Still waiting: the background task hasn't cleared, so this must not
      // have resolved as completed yet.
      let settledEarly = false;
      void pending.then(() => {
        settledEarly = true;
      });
      await new Promise((r) => setTimeout(r, 10));
      expect(settledEarly).toBe(false);

      // The background task finishes and drains the queued prompt, which then
      // runs and completes for real.
      runtime.getRuntimeState = jest.fn().mockResolvedValue({
        sessionState: 'idle',
        runPhase: 'idle',
        backgroundWork: [],
        pendingPrompts: [],
      });
      runtime.emit('event', { type: 'complete', payload: { sessionId: 7 } });

      const res = await pending;
      expect(res.data).toMatchObject({ sessionId: 7, accepted: true, status: 'completed' });
    });

    it('waits through a background_work clear event before reporting completed', async () => {
      const runtime = makeRuntime({
        getRuntimeState: jest.fn().mockResolvedValue({
          sessionState: 'idle',
          runPhase: 'idle',
          backgroundWork: [{ id: 'task:1', kind: 'task', label: 'run tests' }],
          pendingPrompts: [],
        }),
      });
      const { services } = makeServices({
        session: { id: 7, status: 'active', activeAgentProvider: 'claude' },
        runtime,
      });

      const pending = promptSessionTool.handler(
        { sessionId: 7, prompt: 'go' },
        makeCtx(services),
      );
      await new Promise((r) => setTimeout(r, 10));

      // Background work clears with nothing queued behind it — no further
      // `complete`/`run_state` event will ever fire, so the `background_work`
      // event itself must be enough to re-check and resolve.
      runtime.getRuntimeState = jest.fn().mockResolvedValue({
        sessionState: 'idle',
        runPhase: 'idle',
        backgroundWork: [],
        pendingPrompts: [],
      });
      runtime.emit('event', { type: 'background_work', payload: { sessionId: 7, backgroundWork: [] } });

      const res = await pending;
      expect(res.data).toMatchObject({ sessionId: 7, accepted: true, status: 'completed' });
    });
  });

  describe('interrupt_session', () => {
    it('calls provider.interrupt', async () => {
      const { services, runtime } = makeServices({});
      const res = await interruptSessionTool.handler({ sessionId: 7 }, makeCtx(services));
      expect(runtime.interrupt).toHaveBeenCalledWith(7);
      expect(res.data).toMatchObject({ sessionId: 7, interrupted: true });
    });
  });

  describe('fork_session', () => {
    it('forks and returns the new session handle + touched', async () => {
      const { services } = makeServices({});
      const res = await forkSessionTool.handler(
        { sessionId: 7, name: 'alt' },
        makeCtx(services),
      );
      expect(services.sessions.fork).toHaveBeenCalledWith(7, 'alt');
      expect(res.data).toMatchObject({ sessionId: 99, forkedFrom: 7 });
      expect(res.touched).toEqual({ sessionId: 99 });
      expect(res.deepLink).toBe('/sessions/99');
    });
  });

  describe('archive_session', () => {
    it('calls archiveAndStop', async () => {
      const { services } = makeServices({});
      const res = await archiveSessionTool.handler({ sessionId: 7 }, makeCtx(services));
      expect(services.sessions.archiveAndStop).toHaveBeenCalledWith(7);
      expect(res.data).toMatchObject({ sessionId: 7, archived: true });
    });
  });

  describe('reset_session', () => {
    it('calls reset and reports the fresh session id', async () => {
      const { services } = makeServices({});
      const res = await resetSessionTool.handler({ sessionId: 7 }, makeCtx(services));
      expect(services.sessions.reset).toHaveBeenCalledWith(7);
      expect(res.data).toMatchObject({ sessionId: 7, reset: true, newSessionId: 100 });
      expect(res.touched).toEqual({ sessionId: 100 });
    });
  });

  describe('get_pending_action', () => {
    it('compacts a pending permission request', async () => {
      const runtime = makeRuntime({
        getRuntimeState: jest.fn().mockResolvedValue({
          sessionState: 'requires_action',
          pendingPermissionRequest: {
            requestId: 'req-1',
            toolName: 'Bash',
            title: 'Run command',
            description: 'rm -rf /tmp/x',
          },
          pendingUserInputRequest: null,
        }),
      });
      const { services } = makeServices({ runtime });
      const res = await getPendingActionTool.handler({ sessionId: 7 }, makeCtx(services));
      expect(res.data).toMatchObject({
        pending: {
          kind: 'permission',
          requestId: 'req-1',
          toolName: 'Bash',
          title: 'Run command',
          description: 'rm -rf /tmp/x',
        },
        state: 'requires_action',
      });
    });

    it('returns null pending when nothing is blocking', async () => {
      const { services } = makeServices({});
      const res = await getPendingActionTool.handler({ sessionId: 7 }, makeCtx(services));
      expect(res.data).toMatchObject({ pending: null, state: 'idle' });
    });

    it('surfaces an ask_user_question prompt with its options', async () => {
      const runtime = makeRuntime({
        getRuntimeState: jest.fn().mockResolvedValue({
          sessionState: 'requires_action',
          pendingPermissionRequest: {
            requestId: 'req-2',
            toolName: 'AskUserQuestion',
            toolKind: 'ask_user_question',
            title: 'AskUserQuestion',
            input: {
              questions: [
                {
                  question: 'Which approach?',
                  options: [{ label: 'A' }, { label: 'B' }],
                },
              ],
            },
          },
          pendingUserInputRequest: null,
        }),
      });
      const { services } = makeServices({ runtime });
      const res = await getPendingActionTool.handler({ sessionId: 7 }, makeCtx(services));
      expect(res.data).toMatchObject({
        pending: {
          kind: 'ask_user_question',
          requestId: 'req-2',
          questions: [
            {
              question: 'Which approach?',
              options: [{ label: 'A' }, { label: 'B' }],
            },
          ],
        },
      });
    });

    it('surfaces a pending user-input request', async () => {
      const runtime = makeRuntime({
        getRuntimeState: jest.fn().mockResolvedValue({
          sessionState: 'requires_action',
          pendingPermissionRequest: null,
          pendingUserInputRequest: {
            requestId: 'ui-1',
            serverName: 'elicitation',
            message: 'pick one',
          },
        }),
      });
      const { services } = makeServices({ runtime });
      const res = await getPendingActionTool.handler({ sessionId: 7 }, makeCtx(services));
      expect(res.data).toMatchObject({
        pending: { kind: 'user_input', requestId: 'ui-1' },
      });
    });
  });

  describe('resolve_action', () => {
    it('routes approve to approvePermission', async () => {
      const { services, runtime } = makeServices({});
      const res = await resolveActionTool.handler(
        { sessionId: 7, requestId: 'req-1', decision: 'approve', remember: true },
        makeCtx(services),
      );
      expect(services.agentRuntime.getProviderFeature).toHaveBeenCalledWith(
        'claude',
        'approvePermission',
      );
      expect(runtime.approvePermission).toHaveBeenCalledWith(7, 'req-1', true);
      expect(runtime.denyPermission).not.toHaveBeenCalled();
      expect(res.data).toMatchObject({ resolved: true, decision: 'approve' });
    });

    it('passes answers through to approvePermission for question prompts', async () => {
      const { services, runtime } = makeServices({});
      await resolveActionTool.handler(
        {
          sessionId: 7,
          requestId: 'req-2',
          decision: 'approve',
          remember: false,
          answers: { 'Which approach?': 'A' },
        },
        makeCtx(services),
      );
      expect(runtime.approvePermission).toHaveBeenCalledWith(7, 'req-2', false, {
        answers: { 'Which approach?': 'A' },
      });
    });

    it('routes deny to denyPermission with a message', async () => {
      const { services, runtime } = makeServices({});
      await resolveActionTool.handler(
        { sessionId: 7, requestId: 'req-1', decision: 'deny', remember: false, message: 'no' },
        makeCtx(services),
      );
      expect(services.agentRuntime.getProviderFeature).toHaveBeenCalledWith(
        'claude',
        'denyPermission',
      );
      expect(runtime.denyPermission).toHaveBeenCalledWith(7, 'req-1', 'no');
      expect(runtime.approvePermission).not.toHaveBeenCalled();
    });
  });

  describe('set_provider', () => {
    it('updates the active agent provider', async () => {
      const { services } = makeServices({});
      const res = await setProviderTool.handler(
        { sessionId: 7, provider: 'codex' },
        makeCtx(services),
      );
      expect(services.sessions.updateActiveAgentProvider).toHaveBeenCalledWith(7, 'codex');
      expect(res.data).toMatchObject({ sessionId: 7, provider: 'codex' });
    });

    it('maps a domain failure onto a ToolError', async () => {
      const { services } = makeServices({
        sessionsOverrides: {
          updateActiveAgentProvider: jest.fn().mockRejectedValue(new Error('boom')),
        },
      });
      await expect(
        setProviderTool.handler({ sessionId: 7, provider: 'codex' }, makeCtx(services)),
      ).rejects.toBeInstanceOf(ToolError);
    });
  });

  describe('set_model', () => {
    it('calls setSelectedModel (null resets)', async () => {
      const { services, runtime } = makeServices({});
      const res = await setModelTool.handler(
        { sessionId: 7, model: null },
        makeCtx(services),
      );
      expect(runtime.setSelectedModel).toHaveBeenCalledWith(7, null);
      expect(res.data).toMatchObject({ sessionId: 7 });
    });
  });

  describe('set_permission_mode', () => {
    it('routes to the setPermissionMode feature', async () => {
      const { services, runtime } = makeServices({});
      const res = await setPermissionModeTool.handler(
        { sessionId: 7, mode: 'bypassPermissions' },
        makeCtx(services),
      );
      expect(services.agentRuntime.getProviderFeature).toHaveBeenCalledWith(
        'claude',
        'setPermissionMode',
      );
      expect(runtime.setPermissionMode).toHaveBeenCalledWith(7, 'bypassPermissions');
      expect(res.data).toMatchObject({ sessionId: 7, mode: 'bypassPermissions' });
    });
  });
});
