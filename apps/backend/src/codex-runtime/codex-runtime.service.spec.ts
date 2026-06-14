import { jest } from '@jest/globals';

jest.mock('../session-title/session-title.service.js', () => ({
  SessionTitleService: class SessionTitleService {},
}));

import { CodexRuntimeService } from './codex-runtime.service.js';

describe('CodexRuntimeService', () => {
  const session = {
    id: 7,
    repoId: 1,
    worktreePath: '/tmp/project',
    codexSessionId: '-1',
  };

  function createService() {
    const sessionsService = {
      findOne: jest
        .fn<() => Promise<typeof session>>()
        .mockResolvedValue(session),
      updateStatus: jest.fn<() => Promise<unknown>>().mockResolvedValue({}),
      updateCodexSessionId: jest
        .fn<() => Promise<unknown>>()
        .mockResolvedValue({}),
    };
    const authService = {
      getFastStatus: jest.fn<() => Promise<unknown>>().mockResolvedValue({
        installed: true,
        authenticated: true,
        authMethod: 'oauth',
        version: null,
      }),
      getStatus: jest.fn<() => Promise<unknown>>().mockResolvedValue({
        installed: true,
        authenticated: true,
        authMethod: 'oauth',
        version: 'codex 1.0.0',
      }),
    };
    const historyService = {
      getHistory: jest.fn<() => Promise<unknown[]>>().mockResolvedValue([]),
      forkHistory: jest.fn<() => Promise<unknown>>().mockResolvedValue({
        providerSessionId: 'forked-thread',
        draft: null,
        anchorExcerpt: 'answer',
      }),
    };
    const hooksService = {
      updateRuntimeActivity: jest.fn(),
    };
    const titleService = {
      generate: jest.fn<() => Promise<string | null>>().mockResolvedValue(null),
    };
    const appServer = {
      prewarm: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
      request: jest
        .fn<() => Promise<unknown>>()
        .mockResolvedValue({ data: [] }),
      addRef: jest.fn(),
      release: jest.fn(),
      ensureReady: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
      onNotification: jest.fn(() => () => undefined),
      onRequest: jest.fn(() => () => undefined),
      respondToRequest: jest.fn(),
      rejectRequest: jest.fn(),
    };

    return {
      service: new CodexRuntimeService(
        sessionsService as never,
        authService as never,
        historyService as never,
        appServer as never,
        hooksService as never,
        titleService as never,
      ),
      sessionsService,
      authService,
      appServer,
      hooksService,
      historyService,
    };
  }

  function wireAppServerTurn(
    appServer: ReturnType<typeof createService>['appServer'],
  ) {
    let notificationHandler:
      | ((notification: { method: string; params: unknown }) => void)
      | null = null;
    let requestHandler: unknown = null;
    let turnStartParams: unknown = null;

    appServer.onNotification.mockImplementation((handler) => {
      notificationHandler = handler;
      return () => undefined;
    });
    appServer.onRequest.mockImplementation((handler) => {
      requestHandler = handler;
      return () => undefined;
    });
    appServer.request.mockImplementation(
      async (method: string, params: unknown) => {
        if (method === 'thread/start') {
          return { thread: { id: 'thread-1' } };
        }
        if (method === 'turn/start') {
          turnStartParams = params;
          return { turn: { id: 'turn-1' } };
        }
        return {};
      },
    );

    return {
      get notificationHandler() {
        if (!notificationHandler) {
          throw new Error('notification handler was not registered');
        }
        return notificationHandler;
      },
      get requestHandler() {
        return requestHandler;
      },
      get turnStartParams() {
        return turnStartParams;
      },
    };
  }

  async function startAppServerTurn(
    service: CodexRuntimeService,
    selectedPermissionMode: string,
    planMode = false,
  ) {
    const state = (service as any).ensureRuntimeState(7);
    state.selectedPermissionMode = selectedPermissionMode;
    state.planMode = planMode;
    state.selectedModel = 'gpt-test';
    const iterator = (service as any).runTurnOnAppServer(
      7,
      state,
      '/tmp/project',
      [{ type: 'text', text: 'Plan this change' }],
      new AbortController().signal,
    ) as AsyncGenerator<unknown>;

    const first = await iterator.next();
    expect(first.value).toEqual({
      type: 'thread.started',
      thread_id: 'thread-1',
    });
    return iterator;
  }

  it('prewarms the shared app-server and caches session metadata', async () => {
    const { service, sessionsService, authService, appServer } =
      createService();

    await service.prewarmSession(7);

    expect(sessionsService.findOne).toHaveBeenCalledTimes(1);
    expect(authService.getFastStatus).toHaveBeenCalledTimes(1);
    expect(appServer.prewarm).toHaveBeenCalledTimes(1);
    expect((service as any).runtimeStates.get(7).cachedWorktreePath).toBe(
      '/tmp/project',
    );
  });

  it('coalesces concurrent prewarm calls for one session', async () => {
    const { service, sessionsService, appServer } = createService();
    let resolvePrewarm!: () => void;
    appServer.prewarm.mockReturnValue(
      new Promise<void>((resolve) => {
        resolvePrewarm = resolve;
      }),
    );

    const first = service.prewarmSession(7);
    const second = service.prewarmSession(7);
    await new Promise((resolve) => setImmediate(resolve));
    resolvePrewarm();
    await Promise.all([first, second]);

    expect(sessionsService.findOne).toHaveBeenCalledTimes(1);
    expect(appServer.prewarm).toHaveBeenCalledTimes(1);
  });

  it('uses fast auth status for the initial runtime state', async () => {
    const { service, authService } = createService();

    await service.getRuntimeState(7);

    expect(authService.getFastStatus).toHaveBeenCalledTimes(1);
    expect(authService.getStatus).not.toHaveBeenCalled();
  });

  it('forks history while a Codex run is active', async () => {
    const { service, historyService } = createService();
    (service as any).activeRuns.set(7, {});

    const result = await service.forkConversation({
      parentSessionId: 7,
      childSessionId: 8,
      anchorMessageId: 'assistant-1',
      anchorMessageKind: 'assistant',
      childSessionName: 'Fork',
    });

    expect(historyService.forkHistory).toHaveBeenCalledWith(
      '-1',
      expect.objectContaining({
        parentSessionId: 7,
        anchorMessageId: 'assistant-1',
      }),
    );
    expect(result).toEqual({
      providerSessionId: 'forked-thread',
      draft: null,
      anchorExcerpt: 'answer',
    });
  });

  it('lists models through the shared app-server client', async () => {
    const { service, appServer } = createService();
    appServer.request.mockResolvedValueOnce({
      data: [{ id: 'gpt-test', displayName: 'GPT Test' }],
    });

    const models = await (service as any).fetchCodexAppServerModels();

    expect(appServer.request).toHaveBeenCalledWith(
      'model/list',
      { limit: 100, includeHidden: false },
      8000,
    );
    expect(models).toEqual([{ id: 'gpt-test', displayName: 'GPT Test' }]);
  });

  it('does not treat remote Codex model list order as the default', async () => {
    const { service, appServer } = createService();
    appServer.request.mockResolvedValueOnce({
      data: [
        { id: 'gpt-5.3-codex', displayName: 'GPT-5.3 Codex' },
        { id: 'gpt-5.5', displayName: 'GPT-5.5' },
      ],
    });

    await (service as any).refreshModelCatalog();

    const state = await service.getRuntimeState(7);
    expect(state.selectedModel).toBe('gpt-5.5');
  });

  it('honors an explicit remote Codex default model flag', async () => {
    const { service, appServer } = createService();
    appServer.request.mockResolvedValueOnce({
      data: [
        { id: 'gpt-5.5', displayName: 'GPT-5.5' },
        { id: 'gpt-test', displayName: 'GPT Test', isDefault: true },
      ],
    });

    await (service as any).refreshModelCatalog();

    const state = await service.getRuntimeState(7);
    expect(state.selectedModel).toBe('gpt-test');
  });

  it('preserves Codex parsed command actions on command execution tool calls', () => {
    const { service } = createService();
    const commandActions = [
      {
        type: 'read',
        command: "sed -n '12,20p' Cargo.toml",
        name: 'Cargo.toml',
        path: '/tmp/project/Cargo.toml',
      },
    ];

    const item = (service as any).toToolUseItem(
      {
        id: 'cmd-1',
        type: 'command_execution',
        command: "sed -n '12,20p' Cargo.toml",
        command_actions: commandActions,
        status: 'in_progress',
      },
      '2026-05-15T12:00:00.000Z',
    );

    expect(item).toMatchObject({
      toolKind: 'read',
      toolDisplayName: 'Read',
    });
    expect(item.toolInput).toMatchObject({
      command: "sed -n '12,20p' Cargo.toml",
      file_path: '/tmp/project/Cargo.toml',
      commandActions,
    });
    expect(item.providerToolInput).toEqual({
      command: "sed -n '12,20p' Cargo.toml",
      commandActions,
    });
  });

  it('uses native Codex collaboration mode for plan turns without injecting a prompt', async () => {
    const { service, appServer } = createService();
    const wire = wireAppServerTurn(appServer);

    const iterator = await startAppServerTurn(service, 'default', true);

    expect(appServer.request).toHaveBeenCalledWith(
      'thread/start',
      expect.objectContaining({
        sandbox: 'read-only',
        approvalPolicy: 'never',
      }),
    );

    expect(wire.turnStartParams).toEqual({
      threadId: 'thread-1',
      input: [{ type: 'text', text: 'Plan this change' }],
      collaborationMode: {
        mode: 'plan',
        settings: {
          model: 'gpt-test',
          reasoning_effort: null,
          developer_instructions: null,
        },
      },
    });
    expect(JSON.stringify(wire.turnStartParams)).not.toContain(
      'You are in plan mode',
    );

    wire.notificationHandler({
      method: 'turn/completed',
      params: { threadId: 'thread-1', turn: { status: 'completed' } },
    });
    await iterator.next();
    await iterator.next();
  });

  it('omits Codex collaboration mode for non-plan turns', async () => {
    const { service, appServer } = createService();
    const wire = wireAppServerTurn(appServer);

    const iterator = await startAppServerTurn(service, 'default');

    expect(appServer.request).toHaveBeenCalledWith(
      'thread/start',
      expect.objectContaining({
        sandbox: 'workspace-write',
        approvalPolicy: 'on-request',
      }),
    );
    expect(wire.turnStartParams).toEqual({
      threadId: 'thread-1',
      input: [{ type: 'text', text: 'Plan this change' }],
    });

    wire.notificationHandler({
      method: 'turn/completed',
      params: { threadId: 'thread-1', turn: { status: 'completed' } },
    });
    await iterator.next();
    await iterator.next();
  });

  it('maps Codex auto mode to workspace-write with automatic approval review', async () => {
    const { service, appServer } = createService();
    const wire = wireAppServerTurn(appServer);

    const iterator = await startAppServerTurn(service, 'auto');

    expect(appServer.request).toHaveBeenCalledWith(
      'thread/start',
      expect.objectContaining({
        sandbox: 'workspace-write',
        approvalPolicy: 'on-request',
        approvalsReviewer: 'auto_review',
      }),
    );
    expect(wire.turnStartParams).toEqual({
      threadId: 'thread-1',
      input: [{ type: 'text', text: 'Plan this change' }],
    });

    wire.notificationHandler({
      method: 'turn/completed',
      params: { threadId: 'thread-1', turn: { status: 'completed' } },
    });
    await iterator.next();
    await iterator.next();
  });

  it('normalizes legacy Codex plan permission mode into separate plan mode', async () => {
    const { service } = createService();

    const state = await service.setPermissionMode(7, 'plan');

    expect(state.permissionMode).toBe('auto');
    expect(state.planMode).toBe(true);
  });

  it('normalizes streamed Codex plan deltas and completed plan items', async () => {
    const { service, appServer } = createService();
    const wire = wireAppServerTurn(appServer);
    const iterator = await startAppServerTurn(service, 'default', true);

    wire.notificationHandler({
      method: 'item/plan/delta',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'turn-1-plan',
        delta: '# Draft plan\n',
      },
    });
    await expect(iterator.next()).resolves.toMatchObject({
      value: {
        type: 'item.updated',
        item: {
          id: 'turn-1-plan',
          type: 'plan',
          text: '# Draft plan\n',
        },
      },
    });

    wire.notificationHandler({
      method: 'item/completed',
      params: {
        threadId: 'thread-1',
        item: {
          id: 'turn-1-plan',
          type: 'plan',
          text: '# Final plan\n',
        },
      },
    });
    await expect(iterator.next()).resolves.toMatchObject({
      value: {
        type: 'item.completed',
        item: {
          id: 'turn-1-plan',
          type: 'plan',
          text: '# Final plan\n',
        },
      },
    });

    wire.notificationHandler({
      method: 'turn/completed',
      params: { threadId: 'thread-1', turn: { status: 'completed' } },
    });
    await iterator.next();
    await iterator.next();
  });
});
