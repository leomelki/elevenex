import { EventEmitter } from 'node:events';
import { readFile, unlink } from 'node:fs/promises';
import { z } from 'zod';
import { ConversationExportService } from '../../agent-runtime/conversation-export.service.js';
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
 * It's a real EventEmitter (like the production ClaudeRuntimeService) so tools
 * that subscribe to `.on('event', ...)` (e.g. poll_session_status) can be
 * exercised elsewhere; drive tools here mostly just call it directly.
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
      // Also a real EventEmitter, like the production SessionsService, for
      // parity with the runtime double above.
      sessions: Object.assign(new EventEmitter(), {
        assertSessionWorkspaceLinked: jest.fn().mockResolvedValue(undefined),
        findOne: jest.fn().mockImplementation(async () => {
          if (session === null) throw new Error('not found');
          return session;
        }),
        start: jest.fn().mockResolvedValue({ success: true, resumed: false }),
        fork: jest.fn().mockResolvedValue({
          id: 99,
          name: 'S7 (fork)',
          status: 'created',
          activeAgentProvider: 'claude',
        }),
        archiveAndStop: jest
          .fn()
          .mockResolvedValue({ id: 7, status: 'archived' }),
        reset: jest.fn().mockResolvedValue({
          id: 100,
          name: 'S7 (reset)',
          status: 'created',
          activeAgentProvider: 'claude',
        }),
        updateActiveAgentProvider: jest
          .fn()
          .mockResolvedValue({ id: 7, activeAgentProvider: 'codex' }),
        ...opts.sessionsOverrides,
      }),
      sessionForks: {
        create: jest.fn().mockResolvedValue({
          session: {
            id: 99,
            name: 'S7 (fork)',
            status: 'created',
            activeAgentProvider: 'claude',
          },
          draft: null,
        }),
      },
      agentRuntime: {
        getProvider: jest.fn().mockReturnValue(runtime),
        getProviderFeature: jest.fn().mockReturnValue(runtime),
      },
    },
  };
}

describe('Drive tool group', () => {
  it('exports all session control/label tools with required flags', () => {
    const names = DRIVE_TOOLS.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        'archive_session',
        'rename_session',
        'unarchive_session',
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
      expect(res.data).toMatchObject({
        sessionId: 7,
        accepted: true,
        provider: 'claude',
      });
      expect(res.deepLink).toBe('/sessions/7');
    });

    it('does not re-start an already active session', async () => {
      const { services } = makeServices({
        session: { id: 7, status: 'active', activeAgentProvider: 'claude' },
      });
      await promptSessionTool.handler(
        { sessionId: 7, prompt: 'go' },
        makeCtx(services),
      );
      expect(services.sessions.start).not.toHaveBeenCalled();
    });

    it.each(['claude', 'codex', 'opencode', 'pi'])(
      'hands off multiple chat mentions to %s without copying intermediate or nested context',
      async (provider) => {
        const { services, runtime } = makeServices({
          session: { id: 7, status: 'created', activeAgentProvider: provider },
        });
        services.sessions.findOne.mockImplementation(async (id: number) => ({
          id,
          name: `Session ${id}`,
          branchName: 'feature',
          surface: 'session',
          status: id === 7 ? 'created' : id === 42 ? 'active' : 'archived',
          workspaceId: id === 8 ? 2 : 1,
          activeAgentProvider: id === 7 ? provider : 'codex',
          codexSessionId: `thread-${id}`,
        }));
        const sourceRuntime = {
          getHistory: jest.fn().mockResolvedValue([
            {
              id: 'u1',
              kind: 'user',
              isError: false,
              content:
                'Implement auth\n<elevenex_session_mention>\nSession: Older work\nSession ID: 1\nTranscript export: /tmp/older.md\nnested-context-noise\n</elevenex_session_mention>',
            },
            {
              id: 't1',
              kind: 'thinking',
              content: 'intermediate-noise',
              isError: false,
            },
            {
              id: 'a1',
              kind: 'assistant',
              content: 'Auth implemented; tests pass.',
              isError: false,
            },
          ]),
          getRuntimeState: jest
            .fn()
            .mockResolvedValue({ sessionState: 'idle' }),
        };
        const exportService = new ConversationExportService(
          { getProvider: () => sourceRuntime } as never,
          services.sessions as never,
        );
        const buildMention = jest.fn(
          exportService.buildMention.bind(exportService),
        );
        const ctx = makeCtx({
          ...services,
          conversationExport: { buildMention },
        });
        try {
          const result = await promptSessionTool.handler(
            {
              sessionId: 7,
              prompt: 'Review the auth outcomes',
              mentionSessionIds: [42, 8, 42],
            },
            ctx,
          );
          expect(buildMention.mock.calls).toEqual([[42], [8]]);
          const sent = runtime.submitPrompt.mock.calls[0][1] as string;
          expect(sent).toMatch(
            /^Review the auth outcomes\n\n<elevenex_session_mention>/,
          );
          expect(sent.match(/<elevenex_session_mention>/g)).toHaveLength(2);
          expect(sent).toContain('Session ID: 42'); // The caller may be mentioned.
          expect(sent).toContain('Session ID: 8');
          expect(sent).toContain('Provider session ID: thread-42');
          expect(sent).toContain('Auth implemented; tests pass.');
          expect(sent).not.toContain('intermediate-noise');
          expect(sent).not.toContain('nested-context-noise');
          expect(sent).toContain(
            '[Previously mentioned session; nested snapshot omitted.]',
          );
          for (const snapshot of buildMention.mock.results) {
            const mention = await snapshot.value;
            const artifact = await readFile(
              mention.transcriptExportPath,
              'utf8',
            );
            expect(sent).toContain(
              `Transcript export: ${mention.transcriptExportPath}`,
            );
            expect(artifact).toContain('Auth implemented; tests pass.');
          }
          expect(JSON.stringify(result)).not.toContain('Auth implemented');
          expect(services.agentRuntime.getProvider).toHaveBeenCalledWith(
            provider,
          );
        } finally {
          for (const snapshot of buildMention.mock.results) {
            await unlink((await snapshot.value).transcriptExportPath);
          }
        }
      },
    );

    it.each([
      { ids: [8, 404], source: null, code: 'session_not_found' },
      {
        ids: [8, 9],
        source: { surface: 'agent' },
        code: 'agent_session_inaccessible',
      },
      { ids: [8, 7], source: {}, code: 'invalid_session_mention' },
    ])(
      'rejects invalid mention references before starting the target: $code',
      async ({ ids, source, code }) => {
        const { services, runtime } = makeServices({});
        services.sessions.findOne.mockImplementation(async (id: number) => {
          if (id === 7 || id === 8)
            return { id, activeAgentProvider: 'claude' };
          if (source === null) throw new Error('not found');
          return { id, activeAgentProvider: 'claude', ...source };
        });
        const buildMention = jest.fn();
        await expect(
          promptSessionTool.handler(
            { sessionId: 7, prompt: 'go', mentionSessionIds: ids },
            makeCtx({ ...services, conversationExport: { buildMention } }),
          ),
        ).rejects.toMatchObject({ code });
        expect(buildMention).not.toHaveBeenCalled();
        expect(services.sessions.start).not.toHaveBeenCalled();
        expect(runtime.submitPrompt).not.toHaveBeenCalled();
      },
    );

    it('reports mention export failures without starting or submitting a partial prompt', async () => {
      const { services, runtime } = makeServices({});
      await expect(
        promptSessionTool.handler(
          { sessionId: 7, prompt: 'go', mentionSessionIds: [8] },
          makeCtx({
            ...services,
            conversationExport: {
              buildMention: jest
                .fn()
                .mockRejectedValue(new Error('history unavailable')),
            },
          }),
        ),
      ).rejects.toMatchObject({
        code: 'session_mention_failed',
        retryable: true,
      });
      expect(services.sessions.start).not.toHaveBeenCalled();
      expect(runtime.submitPrompt).not.toHaveBeenCalled();
    });

    it('validates mention IDs and caps exports per prompt', () => {
      const schema = z.object(promptSessionTool.inputShape);
      for (const ids of [
        [0],
        [-1],
        [1.5],
        ['8'],
        Array.from({ length: 11 }, (_, i) => i + 1),
      ]) {
        expect(
          schema.safeParse({
            sessionId: 7,
            prompt: 'go',
            mentionSessionIds: ids,
          }).success,
        ).toBe(false);
      }
      expect(
        schema.safeParse({ sessionId: 7, prompt: 'go', mentionSessionIds: [] })
          .success,
      ).toBe(true);
    });

    it('throws a ToolError when the session is not found', async () => {
      const { services } = makeServices({ session: null });
      await expect(
        promptSessionTool.handler(
          { sessionId: 404, prompt: 'go' },
          makeCtx(services),
        ),
      ).rejects.toBeInstanceOf(ToolError);
    });

    it('returns immediately with status running when queued behind live background work', async () => {
      // submitPrompt() silently queues instead of running when the runtime is
      // still busy with a `run_in_background` task (shouldQueueBehindBackground),
      // so sessionState/runPhase are left over from the PREVIOUS finished turn:
      // idle/idle, even though nothing has actually run yet. prompt_session must
      // not wait for that background work to clear — it reports the queued
      // state and returns, leaving the caller free to prompt other sessions.
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

      const res = await promptSessionTool.handler(
        { sessionId: 7, prompt: 'go' },
        makeCtx(services),
      );

      expect(res.data).toMatchObject({
        sessionId: 7,
        accepted: true,
        status: 'running',
      });
      // No event was ever emitted on the runtime — resolving without one proves
      // the handler didn't subscribe and wait.
    });

    it('does not block on a still-running turn', async () => {
      const runtime = makeRuntime({
        getRuntimeState: jest.fn().mockResolvedValue({
          sessionState: 'running',
          runPhase: 'running',
          backgroundWork: [],
          pendingPrompts: [],
        }),
      });
      const { services } = makeServices({
        session: { id: 7, status: 'active', activeAgentProvider: 'claude' },
        runtime,
      });

      const res = await promptSessionTool.handler(
        { sessionId: 7, prompt: 'go' },
        makeCtx(services),
      );

      expect(res.data).toMatchObject({
        sessionId: 7,
        accepted: true,
        status: 'running',
      });
    });
  });

  describe('interrupt_session', () => {
    it('calls provider.interrupt', async () => {
      const { services, runtime } = makeServices({});
      const res = await interruptSessionTool.handler(
        { sessionId: 7 },
        makeCtx(services),
      );
      expect(runtime.interrupt).toHaveBeenCalledWith(7);
      expect(res.data).toMatchObject({ sessionId: 7, interrupted: true });
    });
  });

  describe('fork_session', () => {
    it('forks and returns the new session handle + touched', async () => {
      const { services } = makeServices({});
      const res = await forkSessionTool.handler(
        {
          sessionId: 7,
          name: 'alt',
          anchorMessageId: 'a-1',
          anchorMessageKind: 'assistant',
        },
        makeCtx(services),
      );
      expect(services.sessionForks.create).toHaveBeenCalledWith(7, {
        name: 'alt',
        anchorMessageId: 'a-1',
        anchorMessageKind: 'assistant',
      });
      expect(services.sessions.fork).not.toHaveBeenCalled();
      expect(res.data).toMatchObject({ sessionId: 99, forkedFrom: 7 });
      expect(res.touched).toEqual({ sessionId: 99 });
      expect(res.deepLink).toBe('/sessions/99');
    });
  });

  describe('archive_session', () => {
    it('calls archiveAndStop', async () => {
      const { services } = makeServices({});
      const res = await archiveSessionTool.handler(
        { sessionId: 7 },
        makeCtx(services),
      );
      expect(services.sessions.archiveAndStop).toHaveBeenCalledWith(7);
      expect(res.data).toMatchObject({ sessionId: 7, archived: true });
    });
  });

  describe('reset_session', () => {
    it('calls reset and reports the fresh session id', async () => {
      const { services } = makeServices({});
      const res = await resetSessionTool.handler(
        { sessionId: 7 },
        makeCtx(services),
      );
      expect(services.sessions.reset).toHaveBeenCalledWith(7);
      expect(res.data).toMatchObject({
        sessionId: 7,
        reset: true,
        newSessionId: 100,
      });
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
      const res = await getPendingActionTool.handler(
        { sessionId: 7 },
        makeCtx(services),
      );
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
      const res = await getPendingActionTool.handler(
        { sessionId: 7 },
        makeCtx(services),
      );
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
      const res = await getPendingActionTool.handler(
        { sessionId: 7 },
        makeCtx(services),
      );
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
      const res = await getPendingActionTool.handler(
        { sessionId: 7 },
        makeCtx(services),
      );
      expect(res.data).toMatchObject({
        pending: { kind: 'user_input', requestId: 'ui-1' },
      });
    });
  });

  describe('resolve_action', () => {
    it('routes approve to approvePermission', async () => {
      const { services, runtime } = makeServices({});
      const res = await resolveActionTool.handler(
        {
          sessionId: 7,
          requestId: 'req-1',
          decision: 'approve',
          remember: true,
        },
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
      expect(runtime.approvePermission).toHaveBeenCalledWith(
        7,
        'req-2',
        false,
        {
          answers: { 'Which approach?': 'A' },
        },
      );
    });

    it('routes deny to denyPermission with a message', async () => {
      const { services, runtime } = makeServices({});
      await resolveActionTool.handler(
        {
          sessionId: 7,
          requestId: 'req-1',
          decision: 'deny',
          remember: false,
          message: 'no',
        },
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
      expect(services.sessions.updateActiveAgentProvider).toHaveBeenCalledWith(
        7,
        'codex',
      );
      expect(res.data).toMatchObject({ sessionId: 7, provider: 'codex' });
    });

    it('maps a domain failure onto a ToolError', async () => {
      const { services } = makeServices({
        sessionsOverrides: {
          updateActiveAgentProvider: jest
            .fn()
            .mockRejectedValue(new Error('boom')),
        },
      });
      await expect(
        setProviderTool.handler(
          { sessionId: 7, provider: 'codex' },
          makeCtx(services),
        ),
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
      expect(runtime.setPermissionMode).toHaveBeenCalledWith(
        7,
        'bypassPermissions',
      );
      expect(res.data).toMatchObject({
        sessionId: 7,
        mode: 'bypassPermissions',
      });
    });
  });
});
