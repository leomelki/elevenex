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
    planMode: false as boolean | null,
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
      updatePlanMode: jest.fn<() => Promise<unknown>>().mockResolvedValue({}),
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
      rewindHistory: jest
        .fn<() => Promise<{ threadId: string; beforeTurnId: string }>>()
        .mockResolvedValue({
          threadId: 'source-thread',
          beforeTurnId: 'turn-2',
        }),
      forkHistory: jest.fn<() => Promise<unknown>>().mockResolvedValue({
        threadId: 'source-thread',
        lastTurnId: 'turn-1',
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
    const mcpAgentTokens = {
      ensureToken: jest
        .fn<(sessionId: number) => Promise<string>>()
        .mockResolvedValue('evx_codex_test'),
    };

    return {
      service: new CodexRuntimeService(
        sessionsService as never,
        authService as never,
        historyService as never,
        appServer as never,
        hooksService as never,
        titleService as never,
        {
          getAgentProviderDefaults: () => ({
            model: null,
            reasoningEffort: null,
          }),
        } as never,
        mcpAgentTokens as never,
      ),
      sessionsService,
      authService,
      appServer,
      hooksService,
      historyService,
      mcpAgentTokens,
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

  it('keeps live run items when history is read during hydration', async () => {
    const { service, sessionsService, historyService } = createService();
    sessionsService.findOne.mockResolvedValue({
      ...session,
      codexSessionId: 'thread-1',
    });
    historyService.getHistory.mockResolvedValue([
      { id: 'history-1', kind: 'user', content: 'prompt' },
    ]);
    const liveItems = [
      { id: 'live-1', kind: 'assistant', content: 'Working on it' },
    ];
    const runtimeState = (
      service as unknown as {
        ensureRuntimeState: (
          sessionId: number,
          codexSessionId: string,
        ) => { liveItems: unknown[] };
      }
    ).ensureRuntimeState(7, 'thread-1');
    runtimeState.liveItems = liveItems;

    await expect(service.getHistory(7)).resolves.toEqual([
      { id: 'history-1', kind: 'user', content: 'prompt' },
    ]);
    expect(runtimeState.liveItems).toBe(liveItems);
  });

  it('steers a queued prompt into the active Codex turn', async () => {
    const { service, appServer } = createService();
    const state = (service as any).ensureRuntimeState(7);
    state.pendingPrompts = [
      {
        id: 'queued-1',
        prompt: 'Keep this queued',
        queuedAt: new Date().toISOString(),
      },
      {
        id: 'queued-2',
        prompt: 'Use this guidance now',
        queuedAt: new Date().toISOString(),
      },
    ];
    (service as any).activeRuns.set(7, {
      threadId: 'thread-1',
      turnId: 'turn-1',
      turnReadyPromise: Promise.resolve(),
      resolveTurnReady: jest.fn(),
      abortController: new AbortController(),
      interruptRequested: false,
      completionPromise: new Promise<void>(() => undefined),
      resolveCompletion: jest.fn(),
      startedAtMs: Date.now(),
      permissionRequests: new Map(),
      userInputRequests: new Map(),
    });
    const interrupt = jest.spyOn(service, 'interrupt');

    await service.steerPendingPrompt(7, 'queued-2');

    expect(appServer.request).toHaveBeenCalledWith('turn/steer', {
      threadId: 'thread-1',
      expectedTurnId: 'turn-1',
      input: [{ type: 'text', text: 'Use this guidance now' }],
    });
    expect(interrupt).not.toHaveBeenCalled();
    expect(state.pendingPrompts).toEqual([
      expect.objectContaining({ id: 'queued-1' }),
    ]);
  });

  it('adds a live question receipt when Codex user input is answered', async () => {
    const { service } = createService();
    const state = (service as any).ensureRuntimeState(7);
    (service as any).activeRuns.set(7, {
      threadId: 'thread-1',
      turnId: 'turn-1',
      turnReadyPromise: Promise.resolve(),
      resolveTurnReady: jest.fn(),
      abortController: new AbortController(),
      interruptRequested: false,
      completionPromise: new Promise<void>(() => undefined),
      resolveCompletion: jest.fn(),
      startedAtMs: Date.now(),
      permissionRequests: new Map(),
      userInputRequests: new Map(),
    });

    const response = (service as any).requestCodexToolUserInput(
      7,
      'request-1',
      {
        itemId: 'question-tool-1',
        questions: [
          {
            id: 'approach',
            header: 'Approach',
            question: 'Which approach should we use?',
            options: [{ label: 'Option A', description: 'Use A.' }],
          },
        ],
      },
    );

    expect(state.liveItems).toEqual([
      expect.objectContaining({
        kind: 'tool_use',
        toolUseId: 'question-tool-1',
        toolKind: 'ask_user_question',
      }),
    ]);

    await service.answerUserInput(7, 'request-1', 'accept', {
      approach: 'Option A',
    });

    await expect(response).resolves.toEqual({
      answers: { approach: { answers: ['Option A'] } },
    });
    expect(state.liveItems).toEqual([
      expect.objectContaining({ kind: 'tool_use' }),
      expect.objectContaining({
        kind: 'tool_result',
        toolUseId: 'question-tool-1',
        content: JSON.stringify({
          answers: { approach: { answers: ['Option A'] } },
        }),
      }),
    ]);
  });

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

  it('restores persisted plan mode after prewarm created runtime state', async () => {
    const { service, sessionsService } = createService();
    (service as any).ensureRuntimeState(7);
    sessionsService.findOne.mockResolvedValueOnce({
      ...session,
      planMode: true,
    });

    const state = await service.getRuntimeState(7);

    expect(state.planMode).toBe(true);
  });

  it('recovers legacy plan mode from the latest Codex transcript item', async () => {
    const { service, sessionsService, historyService } = createService();
    sessionsService.findOne.mockResolvedValueOnce({
      ...session,
      codexSessionId: 'thread-1',
      planMode: null,
    });
    historyService.getHistory.mockResolvedValueOnce([
      {
        id: 'plan-1',
        kind: 'assistant',
        contentType: 'plan',
        content: '# Proposed plan',
      },
    ]);

    const state = await service.getRuntimeState(7);

    expect(state.planMode).toBe(true);
    expect(sessionsService.updatePlanMode).toHaveBeenCalledWith(7, true);
  });

  it('does not recover a legacy plan after the conversation continued', async () => {
    const { service, sessionsService, historyService } = createService();
    sessionsService.findOne.mockResolvedValueOnce({
      ...session,
      codexSessionId: 'thread-1',
      planMode: null,
    });
    historyService.getHistory.mockResolvedValueOnce([
      {
        id: 'plan-1',
        kind: 'assistant',
        contentType: 'plan',
        content: '# Old plan',
      },
      { id: 'user-2', kind: 'user', content: 'Do something else' },
    ]);

    const state = await service.getRuntimeState(7);

    expect(state.planMode).toBe(false);
    expect(sessionsService.updatePlanMode).toHaveBeenCalledWith(7, false);
  });

  it('maps Codex subscription windows to remaining plan allowance', () => {
    const { service } = createService();

    const usage = (service as any).toCodexPlanUsage({
      ordinaryUsageAllowed: true,
      rateLimits: {
        planType: 'plus',
        primary: {
          usedPercent: 73,
          windowDurationMins: 300,
          resetsAt: 1_800_000_000,
        },
        secondary: {
          usedPercent: 12,
          windowDurationMins: 10_080,
          resetsAt: 1_800_500_000,
        },
        credits: { hasCredits: true, unlimited: false, balance: '125' },
      },
    });

    expect(usage).toEqual(
      expect.objectContaining({
        provider: 'codex',
        planName: 'Plus',
        status: 'available',
        credits: { balance: '125', unlimited: false },
        windows: [
          expect.objectContaining({
            label: '5-hour limit',
            remainingPercentage: 27,
          }),
          expect.objectContaining({
            label: 'Weekly limit',
            remainingPercentage: 88,
          }),
        ],
      }),
    );
  });

  it('does not create plan usage without quota windows', () => {
    const { service } = createService();

    expect(
      (service as any).toCodexPlanUsage({ rateLimits: { planType: 'plus' } }),
    ).toBeNull();
  });

  it('does not request subscription usage for API-key authentication', async () => {
    const { service, authService, appServer } = createService();
    authService.getFastStatus.mockResolvedValue({
      installed: true,
      authenticated: true,
      authMethod: 'api_key',
      version: null,
    });

    await service.getRuntimeState(7);
    await Promise.resolve();

    expect(appServer.request).not.toHaveBeenCalledWith(
      'account/rateLimits/read',
      expect.anything(),
      expect.anything(),
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
    const { service, historyService, appServer } = createService();
    (service as any).activeRuns.set(7, {});
    appServer.request.mockResolvedValueOnce({
      thread: { id: 'forked-thread' },
    });

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
    expect(appServer.request).toHaveBeenCalledWith('thread/fork', {
      threadId: 'source-thread',
      lastTurnId: 'turn-1',
      excludeTurns: true,
    });
    expect(result).toEqual({
      providerSessionId: 'forked-thread',
      draft: null,
      anchorExcerpt: 'answer',
    });
  });

  it('forks before a selected Codex user turn and returns it as a draft', async () => {
    const { service, historyService, appServer } = createService();
    historyService.forkHistory.mockResolvedValueOnce({
      threadId: 'source-thread',
      beforeTurnId: 'turn-2',
      draft: 'try this instead',
      anchorExcerpt: 'try this instead',
    });
    appServer.request.mockResolvedValueOnce({
      thread: { id: 'forked-thread' },
    });

    const result = await service.forkConversation({
      parentSessionId: 7,
      childSessionId: 8,
      anchorMessageId: 'user-2',
      anchorMessageKind: 'user',
      childSessionName: 'Fork',
    });

    expect(appServer.request).toHaveBeenCalledWith('thread/fork', {
      threadId: 'source-thread',
      beforeTurnId: 'turn-2',
      excludeTurns: true,
    });
    expect(result).toEqual({
      providerSessionId: 'forked-thread',
      draft: 'try this instead',
      anchorExcerpt: 'try this instead',
    });
  });

  it('rewinds a Codex user message into a new persisted thread', async () => {
    const { service, sessionsService, historyService, appServer } =
      createService();
    sessionsService.findOne.mockResolvedValue({
      ...session,
      codexSessionId: 'source-thread',
    });
    historyService.getHistory.mockResolvedValue([
      { id: 'user-1', kind: 'user', content: 'first' },
    ]);
    appServer.request.mockResolvedValue({
      thread: { id: 'rewound-thread' },
    });

    const result = await service.rewindConversation(7, 'codex-record:3');

    expect(historyService.rewindHistory).toHaveBeenCalledWith(
      'source-thread',
      'codex-record:3',
    );
    expect(appServer.request).toHaveBeenCalledWith('thread/fork', {
      threadId: 'source-thread',
      beforeTurnId: 'turn-2',
      excludeTurns: true,
    });
    expect(sessionsService.updateCodexSessionId).toHaveBeenCalledWith(
      7,
      'rewound-thread',
    );
    expect(historyService.getHistory).toHaveBeenCalledWith('rewound-thread');
    expect(result).toEqual([{ id: 'user-1', kind: 'user', content: 'first' }]);
  });

  it('rejects Codex rewinds while a run is active', async () => {
    const { service, historyService } = createService();
    (service as any).activeRuns.set(7, {});

    await expect(
      service.rewindConversation(7, 'codex-record:3'),
    ).rejects.toThrow('Cannot edit a message while Codex is actively running.');
    expect(historyService.rewindHistory).not.toHaveBeenCalled();
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

  it('waits for Codex to report the current account model catalog', async () => {
    const { service, appServer } = createService();
    appServer.request.mockResolvedValueOnce({
      data: [
        {
          id: 'gpt-current',
          displayName: 'GPT Current',
          isDefault: true,
          supportedReasoningEfforts: [
            { reasoningEffort: 'low', description: 'Quick' },
            { reasoningEffort: 'ultra', description: 'Deep' },
          ],
        },
      ],
    });

    const catalog = await service.getModelCatalog();

    expect(appServer.request).toHaveBeenCalledWith(
      'model/list',
      { limit: 100, includeHidden: false },
      8000,
    );
    expect(catalog.models).toEqual([
      expect.objectContaining({
        id: 'gpt-current',
        displayName: 'GPT Current',
        reasoningEfforts: ['low', 'ultra'],
        supportsEffort: true,
        isProviderDefault: true,
      }),
    ]);
    expect(catalog.providerDefaultModelId).toBe('gpt-current');
    expect(catalog.reasoningEfforts).toEqual(['low', 'ultra']);
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
    const { service, appServer, mcpAgentTokens } = createService();
    const wire = wireAppServerTurn(appServer);

    const iterator = await startAppServerTurn(service, 'default');

    expect(appServer.request).toHaveBeenCalledWith(
      'thread/start',
      expect.objectContaining({
        sandbox: 'workspace-write',
        approvalPolicy: 'on-request',
        config: {
          mcp_servers: {
            elevenex_local_computer: expect.objectContaining({
              http_headers: {
                Authorization: 'Bearer evx_codex_test',
              },
              enabled_tools: ['run_local_bash'],
              tool_timeout_sec: 125,
            }),
          },
        },
      }),
    );
    expect(mcpAgentTokens.ensureToken).toHaveBeenCalledWith(7);
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
    const { service, sessionsService } = createService();

    const state = await service.setPermissionMode(7, 'plan');

    expect(state.permissionMode).toBe('auto');
    expect(state.planMode).toBe(true);
    expect(sessionsService.updatePlanMode).toHaveBeenCalledWith(7, true);
  });

  it('persists explicit Codex plan mode changes', async () => {
    const { service, sessionsService } = createService();

    const state = await service.setPlanMode(7, true);

    expect(state.planMode).toBe(true);
    expect(sessionsService.updatePlanMode).toHaveBeenCalledWith(7, true);
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
