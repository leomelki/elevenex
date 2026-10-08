import { jest } from '@jest/globals';

jest.mock('../session-title/session-title.service.js', () => ({
  SessionTitleService: class SessionTitleService {},
}));

import { CodexRuntimeService } from './codex-runtime.service.js';

describe('CodexRuntimeService', () => {
  it.each([
    { query: 'legacy query' },
    { query: '', action: { type: 'search', query: 'structured query' } },
    {
      query: 'first',
      action: { type: 'search', queries: ['first', 'second'] },
    },
  ])(
    'publishes web search input and completion while the turn is still running: %j',
    (raw) => {
      const { service } = createService();
      const runtime = service as any;
      const state = runtime.ensureRuntimeState(7);
      state.runPhase = 'running';
      const emit = jest.spyOn(runtime, 'emitEvent');
      const translate = (input: unknown) =>
        runtime.translateAppServerItem(input, new Map(), new Map(), new Map());
      runtime.handleCodexEvent(
        7,
        state,
        {
          type: 'item.started',
          item: translate({ id: 'search-1', type: 'webSearch', query: '' }),
        },
        '/tmp/project',
      );
      expect(state.liveItems).toHaveLength(1);
      runtime.handleCodexEvent(
        7,
        state,
        {
          type: 'item.completed',
          item: translate({ id: 'search-1', type: 'webSearch', ...raw }),
        },
        '/tmp/project',
      );
      expect(state.runPhase).toBe('running');
      expect(state.liveItems).toHaveLength(2);
      expect(state.liveItems[0].toolInput.query).toBe(
        'action' in raw
          ? 'queries' in raw.action
            ? 'first\nsecond'
            : 'structured query'
          : 'legacy query',
      );
      expect(emit).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'tool_use',
          payload: expect.objectContaining({ item: state.liveItems[0] }),
        }),
      );
      expect(emit).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'tool_result',
          payload: expect.objectContaining({
            item: expect.objectContaining({
              toolUseId: 'search-1',
              content: '',
            }),
          }),
        }),
      );
    },
  );

  const session = {
    id: 7,
    repoId: 1,
    worktreePath: '/tmp/project',
    codexSessionId: '-1',
    planMode: false as boolean | null,
  };

  function createService(defaults: { model: string | null; reasoningEffort: string | null; fastMode?: boolean } = { model: null, reasoningEffort: null }) {
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
      waitForHistory: jest.fn<() => Promise<unknown[]>>().mockResolvedValue([]),
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
    const interactionRows: Record<string, unknown>[] = [];
    const db = {
      select: () => ({ from: () => ({ where: async () => interactionRows }) }),
      insert: () => ({
        values: (row: Record<string, unknown>) => ({
          onConflictDoUpdate: async () => {
            interactionRows.push(row);
          },
        }),
      }),
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
          getAgentProviderDefaults: () => defaults,
        } as never,
        mcpAgentTokens as never,
        db as never,
      ),
      sessionsService,
      authService,
      appServer,
      hooksService,
      historyService,
      mcpAgentTokens,
      interactionRows,
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

  function forkResult(id: string, count = 2) {
    return {
      thread: {
        id,
        path: '/tmp/fork.jsonl',
        turns: Array.from({ length: count }, (_, index) => ({
          id: `turn-${index + 1}`,
          status: 'completed',
          items: [{ type: 'userMessage' }],
        })),
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

  it('persists and emits denial feedback, including approvals with no provider tool item', async () => {
    const { service, sessionsService, interactionRows } = createService();
    sessionsService.findOne.mockResolvedValue({
      ...session,
      codexSessionId: 'thread-1',
    });
    const resolve = jest.fn();
    const request = {
      requestId: 'approval-1',
      toolUseId: 'command-1',
      toolName: 'Bash',
      input: { command: 'rm -rf tmp' },
      createdAt: '2026-09-30T08:00:00.000Z',
    };
    const run = {
      permissionRequests: new Map([['approval-1', { request, resolve }]]),
    };
    (service as any).ensureRuntimeState(7, 'thread-1');
    (service as any).activeRuns.set(7, run);
    const events: unknown[] = [];
    service.on('event', (event) => events.push(event));

    await service.denyPermission(
      7,
      'approval-1',
      'Keep these files.\nUse another folder.',
    );

    expect(resolve).toHaveBeenCalledWith({
      approved: false,
      message: 'Keep these files.\nUse another folder.',
    });
    expect(interactionRows[0].responseContent).toBe(
      JSON.stringify({ message: 'Keep these files.\nUse another folder.' }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'permission_resolved',
        payload: expect.objectContaining({
          interaction: expect.objectContaining({
            decision: 'denied',
            content: { message: 'Keep these files.\nUse another folder.' },
          }),
        }),
      }),
    );
    expect(await service.getHistory(7)).toEqual([
      expect.objectContaining({
        toolUseId: 'command-1',
        interaction: expect.objectContaining({
          content: { message: 'Keep these files.\nUse another folder.' },
        }),
      }),
    ]);
  });

  it('attaches a restored denial to the matching provider item without duplicating the call', async () => {
    const { service, sessionsService, historyService, interactionRows } =
      createService();
    sessionsService.findOne.mockResolvedValue({
      ...session,
      codexSessionId: 'thread-1',
    });
    interactionRows.push({
      toolUseId: 'command-1',
      toolName: 'Bash',
      decision: 'denied',
      responseContent: JSON.stringify({ message: 'Use another folder.' }),
      requestSnapshot: '{}',
      createdAt: '2026-09-30T08:00:00.000Z',
      resolvedAt: '2026-09-30T08:00:05.000Z',
    });
    historyService.getHistory.mockResolvedValue([
      {
        id: 'history-tool',
        kind: 'tool_use',
        toolUseId: 'call-1',
        sourceMessageId: 'command-1',
      },
    ]);
    const history = await service.getHistory(7);
    expect(history).toHaveLength(1);
    expect(history[0].interaction?.content).toEqual({
      message: 'Use another folder.',
    });
  });

  it('does not restore an orphan denial from a thread removed by rewinding', async () => {
    const { service, sessionsService, interactionRows } = createService();
    sessionsService.findOne.mockResolvedValue({
      ...session,
      codexSessionId: 'rewound-thread',
    });
    interactionRows.push({
      toolUseId: 'command-1',
      toolName: 'Bash',
      decision: 'denied',
      responseContent: JSON.stringify({ message: 'Use another folder.' }),
      requestSnapshot: JSON.stringify({ codexSessionId: 'old-thread' }),
      createdAt: '2026-09-30T08:00:00.000Z',
      resolvedAt: '2026-09-30T08:00:05.000Z',
    });
    expect(await service.getHistory(7)).toEqual([]);
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

  it.each([true, false])(
    'answers Codex user input with isBlocking=%s',
    async (isBlocking) => {
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
          isBlocking,
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

      expect(state.runPhase).toBe(isBlocking ? 'waiting' : 'running');

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
    },
  );

  const asyncQuestionItem = {
    id: 'async-question-1',
    type: 'agentMessage',
    delivery: 'async',
    text: 'Choose an approach while I inspect the code.',
    questions: [
      { title: 'Which approach?', options: ['Minimal', 'Complete'] },
      { title: 'Any constraints?' },
    ],
  };

  it('receives native async questions on the owning thread without blocking it', async () => {
    const { service, appServer } = createService();
    const wire = wireAppServerTurn(appServer);
    const iterator = await startAppServerTurn(service, 'auto');
    const runtime = service as any;
    const state = runtime.ensureRuntimeState(7);
    state.runPhase = 'running';
    wire.notificationHandler({
      method: 'item/completed',
      params: { threadId: 'other-thread', item: asyncQuestionItem },
    });
    expect(state.pendingUserInputRequest).toBeNull();
    wire.notificationHandler({
      method: 'item/completed',
      params: { threadId: 'thread-1', item: asyncQuestionItem },
    });
    expect(state.pendingUserInputRequest).toMatchObject({
      requestId: 'codex-async-user-input:async-question-1',
      isBlocking: false,
      questions: [
        {
          id: 'question-1',
          question: 'Which approach?',
          options: [{ label: 'Minimal' }, { label: 'Complete' }],
        },
        { id: 'question-2', question: 'Any constraints?', options: [] },
      ],
    });
    // No active run was installed by this generator-only test.
    expect(state.runPhase).not.toBe('waiting');
    runtime.finishRun(7);
    expect(state.pendingUserInputRequest?.isBlocking).toBe(false);
    await iterator.return(undefined);
  });

  it('steers async answers into the active turn and restores failed submissions', async () => {
    const { service, appServer } = createService();
    const runtime = service as any;
    const state = runtime.ensureRuntimeState(7);
    runtime.activeRuns.set(7, {
      threadId: 'thread-1',
      turnId: 'turn-1',
      turnReadyPromise: Promise.resolve(),
      permissionRequests: new Map(),
      userInputRequests: new Map(),
    });
    runtime.receiveCodexAsyncUserInput(7, asyncQuestionItem);
    expect(state.runPhase).toBe('running');
    expect(state.sessionState).toBe('running');
    const requestId = state.pendingUserInputRequest.requestId;
    appServer.request.mockRejectedValueOnce(new Error('steer failed'));
    await expect(
      service.answerUserInput(7, requestId, 'accept', {
        'question-1': 'Complete',
      }),
    ).rejects.toThrow('steer failed');
    expect(state.pendingUserInputRequest.requestId).toBe(requestId);
    await service.answerUserInput(7, requestId, 'accept', {
      'question-1': 'Complete',
      'question-2': 'Keep existing APIs',
    });
    expect(appServer.request).toHaveBeenLastCalledWith('turn/steer', {
      threadId: 'thread-1',
      expectedTurnId: 'turn-1',
      input: [
        {
          type: 'text',
          text: 'Which approach?\nAnswer: Complete\n\nAny constraints?\nAnswer: Keep existing APIs',
        },
      ],
    });
    expect(state.pendingUserInputRequest).toBeNull();
  });

  it('queues multiple async questions, keeps them after completion, and accepts a late answer', async () => {
    const { service } = createService();
    const runtime = service as any;
    const state = runtime.ensureRuntimeState(7);
    const submit = jest
      .spyOn(service, 'submitPrompt')
      .mockResolvedValue(undefined);
    runtime.receiveCodexAsyncUserInput(7, asyncQuestionItem);
    runtime.receiveCodexAsyncUserInput(7, asyncQuestionItem);
    runtime.receiveCodexAsyncUserInput(7, {
      ...asyncQuestionItem,
      id: 'async-question-2',
    });
    expect(state.asyncUserInputRequests.size).toBe(2);
    runtime.finishRun(7);
    await service.answerUserInput(
      7,
      state.pendingUserInputRequest.requestId,
      'decline',
    );
    expect(submit).not.toHaveBeenCalled();
    expect(state.pendingUserInputRequest.requestId).toBe(
      'codex-async-user-input:async-question-2',
    );
    await service.answerUserInput(
      7,
      state.pendingUserInputRequest.requestId,
      'accept',
      {
        'question-1': 'Minimal',
        'question-2': 'None',
      },
    );
    expect(submit).toHaveBeenCalledWith(
      7,
      'Which approach?\nAnswer: Minimal\n\nAny constraints?\nAnswer: None',
    );
    expect(state.pendingUserInputRequest).toBeNull();
  });

  it('clears resolved RPC questions without sending a stale answer', async () => {
    const { service, appServer } = createService();
    const wire = wireAppServerTurn(appServer);
    const iterator = await startAppServerTurn(service, 'auto');
    const runtime = service as any;
    runtime.activeRuns.set(7, {
      userInputRequests: new Map(),
      permissionRequests: new Map(),
    });
    const response = (wire.requestHandler as any)({
      id: 42,
      method: 'item/tool/requestUserInput',
      params: {
        threadId: 'thread-1',
        itemId: 'question-tool-1',
        isBlocking: false,
        questions: [{ id: 'scope', question: 'Which scope?' }],
      },
    });
    wire.notificationHandler({
      method: 'serverRequest/resolved',
      params: { threadId: 'thread-1', requestId: 42 },
    });
    await response;
    expect(runtime.ensureRuntimeState(7).pendingUserInputRequest).toBeNull();
    expect(appServer.respondToRequest).not.toHaveBeenCalled();
    await iterator.return(undefined);
  });

  async function startAppServerTurn(
    service: CodexRuntimeService,
    selectedPermissionMode: string,
    planMode?: boolean,
  ) {
    const state = (service as any).ensureRuntimeState(7);
    state.selectedPermissionMode = selectedPermissionMode;
    if (planMode !== undefined) state.planMode = planMode;
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

  it.each([
    {
      kind: 'assistant' as const,
      boundary: { lastTurnId: 'turn-1' },
      retained: 1,
    },
    {
      kind: 'user' as const,
      boundary: { beforeTurnId: 'turn-2' },
      retained: 1,
    },
    {
      kind: 'user' as const,
      boundary: { beforeTurnId: 'turn-1' },
      retained: 0,
    },
  ])(
    'uses native fork boundaries for $kind with $retained retained turns',
    async ({ kind, boundary, retained }) => {
      const { service, historyService, appServer } = createService();
      historyService.forkHistory.mockResolvedValueOnce({
        threadId: 'source-thread',
        ...boundary,
        draft: kind === 'user' ? 'edited prompt' : null,
        anchorExcerpt: 'anchor',
      });
      appServer.request.mockResolvedValueOnce(forkResult('source-thread', 3));
      appServer.request.mockResolvedValueOnce(
        forkResult('forked-thread', retained),
      );

      await expect(
        service.forkConversation({
          parentSessionId: 7,
          childSessionId: 8,
          anchorMessageId: 'anchor',
          anchorMessageKind: kind,
          childSessionName: 'Fork',
        }),
      ).resolves.toMatchObject({ providerSessionId: 'forked-thread' });

      expect(appServer.request.mock.calls).toEqual([
        ['thread/read', { threadId: 'source-thread', includeTurns: true }],
        ['thread/fork', { threadId: 'source-thread', ...boundary }],
      ]);
      expect(historyService.waitForHistory).toHaveBeenCalledWith(
        'forked-thread',
        retained,
        '/tmp/fork.jsonl',
      );
    },
  );

  it('edits using a native fork without calling the removed rollback RPC', async () => {
    const { service, sessionsService, appServer } = createService();
    appServer.request.mockResolvedValueOnce(forkResult('source-thread', 3));
    appServer.request.mockResolvedValueOnce(forkResult('rewound-thread', 1));

    await service.rewindConversation(7, 'codex-record:3');

    expect(appServer.request.mock.calls).toEqual([
      ['thread/read', { threadId: 'source-thread', includeTurns: true }],
      ['thread/fork', { threadId: 'source-thread', beforeTurnId: 'turn-2' }],
    ]);
    expect(sessionsService.updateCodexSessionId).toHaveBeenCalledWith(
      7,
      'rewound-thread',
    );
  });

  it('rejects a native fork that loses retained turns without replacing the original', async () => {
    const { service, sessionsService, historyService, appServer } =
      createService();
    appServer.request.mockResolvedValueOnce(forkResult('source-thread', 3));
    appServer.request.mockResolvedValueOnce(forkResult('rewound-thread', 0));

    await expect(
      service.rewindConversation(7, 'codex-record:3'),
    ).rejects.toThrow('requested fork history');

    expect(sessionsService.updateCodexSessionId).not.toHaveBeenCalled();
    expect(historyService.waitForHistory).not.toHaveBeenCalled();
  });

  it('rejects an in-progress assistant boundary before creating a fork', async () => {
    const { service, appServer } = createService();
    const source = forkResult('source-thread');
    source.thread.turns[0].status = 'inProgress';
    appServer.request.mockResolvedValueOnce(source);

    await expect(
      service.forkConversation({
        parentSessionId: 7,
        childSessionId: 8,
        anchorMessageId: 'assistant-1',
        anchorMessageKind: 'assistant',
        childSessionName: 'Fork',
      }),
    ).rejects.toThrow('still running');
    expect(appServer.request).toHaveBeenCalledTimes(1);
  });

  it('forks history while a Codex run is active', async () => {
    const { service, historyService, appServer } = createService();
    (service as any).activeRuns.set(7, {});
    appServer.request.mockResolvedValueOnce(forkResult('source-thread', 2));
    appServer.request.mockResolvedValueOnce(forkResult('forked-thread'));
    appServer.request.mockResolvedValueOnce(forkResult('forked-thread', 1));

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
    });
    expect(appServer.request).toHaveBeenCalledWith('thread/rollback', {
      threadId: 'forked-thread',
      numTurns: 1,
    });
    expect(historyService.waitForHistory).toHaveBeenCalledWith(
      'forked-thread',
      1,
      '/tmp/fork.jsonl',
    );
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
    appServer.request.mockResolvedValueOnce(forkResult('source-thread', 2));
    appServer.request.mockResolvedValueOnce(forkResult('forked-thread'));
    appServer.request.mockResolvedValueOnce(forkResult('forked-thread', 1));

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
    });
    expect(appServer.request).toHaveBeenCalledWith('thread/rollback', {
      threadId: 'forked-thread',
      numTurns: 1,
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
    historyService.waitForHistory.mockResolvedValue([
      { id: 'user-1', kind: 'user', content: 'first' },
    ]);
    appServer.request.mockResolvedValueOnce(forkResult('source-thread', 3));
    appServer.request.mockResolvedValueOnce(forkResult('rewound-thread', 3));
    appServer.request.mockResolvedValueOnce(forkResult('rewound-thread', 1));

    const result = await service.rewindConversation(7, 'codex-record:3');

    expect(historyService.rewindHistory).toHaveBeenCalledWith(
      'source-thread',
      'codex-record:3',
    );
    expect(appServer.request).toHaveBeenCalledWith('thread/fork', {
      threadId: 'source-thread',
      beforeTurnId: 'turn-2',
    });
    expect(appServer.request).toHaveBeenCalledWith('thread/rollback', {
      threadId: 'rewound-thread',
      numTurns: 2,
    });
    expect(sessionsService.updateCodexSessionId).toHaveBeenCalledWith(
      7,
      'rewound-thread',
    );
    expect(historyService.waitForHistory).toHaveBeenCalledWith(
      'rewound-thread',
      1,
      '/tmp/fork.jsonl',
    );
    expect(result).toEqual([{ id: 'user-1', kind: 'user', content: 'first' }]);
  });

  it('keeps the original thread when the rewound rollout is not ready', async () => {
    const { service, sessionsService, historyService, appServer } =
      createService();
    appServer.request.mockResolvedValueOnce(forkResult('source-thread', 2));
    appServer.request.mockResolvedValueOnce(forkResult('rewound-thread'));
    appServer.request.mockResolvedValueOnce(forkResult('rewound-thread', 1));
    historyService.waitForHistory.mockRejectedValueOnce(
      new Error('History not ready'),
    );
    await expect(
      service.rewindConversation(7, 'codex-record:3'),
    ).rejects.toThrow('History not ready');
    expect(sessionsService.updateCodexSessionId).not.toHaveBeenCalled();
  });

  it('rejects a missing fork boundary without replacing the original thread', async () => {
    const { service, sessionsService, appServer } = createService();
    appServer.request.mockResolvedValueOnce(forkResult('source-thread', 1));
    appServer.request.mockResolvedValueOnce(forkResult('rewound-thread', 1));
    await expect(
      service.rewindConversation(7, 'codex-record:3'),
    ).rejects.toThrow('selected Codex turn');
    expect(sessionsService.updateCodexSessionId).not.toHaveBeenCalled();
    expect(appServer.request).toHaveBeenCalledTimes(1);
  });

  it('rejects an incorrect rollback without publishing empty history', async () => {
    const { service, sessionsService, historyService, appServer } =
      createService();
    appServer.request.mockResolvedValueOnce(forkResult('source-thread', 2));
    appServer.request.mockResolvedValueOnce(forkResult('rewound-thread'));
    appServer.request.mockResolvedValueOnce(forkResult('rewound-thread', 0));
    await expect(
      service.rewindConversation(7, 'codex-record:3'),
    ).rejects.toThrow('requested fork history');
    expect(sessionsService.updateCodexSessionId).not.toHaveBeenCalled();
    expect(historyService.waitForHistory).not.toHaveBeenCalled();
  });

  it('allows an empty rewind only when editing the first turn', async () => {
    const { service, historyService, appServer } = createService();
    historyService.rewindHistory.mockResolvedValueOnce({
      threadId: 'source-thread',
      beforeTurnId: 'turn-1',
    });
    appServer.request.mockResolvedValueOnce(forkResult('source-thread', 2));
    appServer.request.mockResolvedValueOnce(forkResult('rewound-thread'));
    appServer.request.mockResolvedValueOnce(forkResult('rewound-thread', 0));
    await expect(
      service.rewindConversation(7, 'codex-record:3'),
    ).resolves.toEqual([]);
    expect(historyService.waitForHistory).toHaveBeenCalledWith(
      'rewound-thread',
      0,
      '/tmp/fork.jsonl',
    );
  });

  it('does not rollback when forking at the latest assistant turn', async () => {
    const { service, appServer } = createService();
    appServer.request.mockResolvedValueOnce(forkResult('source-thread', 1));
    appServer.request.mockResolvedValueOnce(forkResult('forked-thread', 1));
    await service.forkConversation({
      parentSessionId: 7,
      childSessionId: 8,
      anchorMessageId: 'assistant-1',
      anchorMessageKind: 'assistant',
      childSessionName: 'Fork',
    });
    expect(appServer.request).toHaveBeenCalledTimes(2);
  });

  it('rejects Codex rewinds while a run is active', async () => {
    const { service, historyService } = createService();
    (service as any).activeRuns.set(7, {});

    await expect(
      service.rewindConversation(7, 'codex-record:3'),
    ).rejects.toThrow('Cannot edit a message while Codex is actively running.');
    expect(historyService.rewindHistory).not.toHaveBeenCalled();
  });

  it('prevents overlapping edits and prompts while a rewind is awaiting persistence', async () => {
    const { service, historyService, appServer } = createService();
    appServer.request.mockResolvedValueOnce(forkResult('source-thread', 2));
    appServer.request.mockResolvedValueOnce(forkResult('rewound-thread'));
    appServer.request.mockResolvedValueOnce(forkResult('rewound-thread', 1));
    let finish!: (history: unknown[]) => void;
    historyService.waitForHistory.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const editing = service.rewindConversation(7, 'codex-record:3');
    await new Promise((resolve) => setImmediate(resolve));
    await expect(
      service.rewindConversation(7, 'codex-record:3'),
    ).rejects.toThrow('edit is already in progress');
    await expect(service.submitPrompt(7, 'follow-up')).rejects.toThrow(
      'edit is already in progress',
    );
    finish([]);
    await editing;
    expect((service as any).rewindingSessions.size).toBe(0);
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

  it('starts new sessions with the default preset fast mode', () => {
    const { service } = createService({ model: 'gpt-5.5', reasoningEffort: 'low', fastMode: true });
    const state = (service as any).ensureRuntimeState(7, null);
    expect(state.selectedModel).toBe('gpt-5.5');
    expect(state.reasoningEffort).toBe('low');
    expect(state.fastMode).toBe(true);
  });

  it('does not enable preset fast mode for a model without support', () => {
    const { service } = createService({ model: 'unknown-model', reasoningEffort: null, fastMode: true });
    expect((service as any).ensureRuntimeState(7, null).fastMode).toBe(false);
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

  it.each([true, false])(
    'sets the Codex service tier when starting a thread with fast mode %s',
    async (enabled) => {
      const { service, appServer } = createService();
      const wire = wireAppServerTurn(appServer);
      await service.setFastMode(7, enabled);

      const iterator = await startAppServerTurn(service, 'default');
      const serviceTier = enabled ? 'fast' : null;

      expect(appServer.request).toHaveBeenCalledWith(
        'thread/start',
        expect.objectContaining({ serviceTier }),
      );
      const threadParams = appServer.request.mock.calls.find(
        ([method]) => method === 'thread/start',
      )?.[1];
      expect(threadParams).not.toHaveProperty('speedTier');
      expect(wire.turnStartParams).toMatchObject({ serviceTier });

      await iterator.return(undefined);
    },
  );

  it('applies fast mode changes on each turn of an already-loaded thread', async () => {
    const { service, appServer } = createService();
    const wire = wireAppServerTurn(appServer);

    for (const [enabled, threadMethod] of [
      [false, 'thread/start'],
      [true, 'thread/resume'],
      [false, 'thread/resume'],
    ] as const) {
      await service.setFastMode(7, enabled);
      const iterator = await startAppServerTurn(service, 'default');
      const serviceTier = enabled ? 'fast' : null;

      expect(appServer.request).toHaveBeenLastCalledWith(
        'turn/start',
        expect.objectContaining({ threadId: 'thread-1', serviceTier }),
      );
      expect(appServer.request).toHaveBeenCalledWith(
        threadMethod,
        expect.objectContaining({ serviceTier }),
      );

      wire.notificationHandler({
        method: 'turn/completed',
        params: { threadId: 'thread-1', turn: { status: 'completed' } },
      });
      await iterator.next();
      await expect(iterator.next()).resolves.toMatchObject({ done: true });
      (service as any).ensureRuntimeState(7, 'thread-1');
    }

    expect(
      appServer.request.mock.calls.filter(
        ([method]) => method === 'thread/start',
      ),
    ).toHaveLength(1);
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
      cwd: '/tmp/project',
      sandboxPolicy: { type: 'readOnly' },
      approvalPolicy: 'never',
      approvalsReviewer: 'user',
      serviceTier: null,
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

  it('selects native Codex default mode for implementation turns', async () => {
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
      cwd: '/tmp/project',
      sandboxPolicy: {
        type: 'workspaceWrite',
        writableRoots: ['/tmp/project'],
      },
      approvalPolicy: 'on-request',
      approvalsReviewer: 'user',
      serviceTier: null,
      collaborationMode: {
        mode: 'default',
        settings: {
          model: 'gpt-test',
          reasoning_effort: null,
          developer_instructions: null,
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

  it('gives Codex missions the full Elevenex toolset and current autonomy instructions', async () => {
    const { service, appServer, sessionsService } = createService();
    sessionsService.findOne.mockResolvedValue({
      ...session,
      surface: 'agent',
      activeAgentProvider: 'codex',
      agentAutonomyMode: 'review',
    } as never);
    const wire = wireAppServerTurn(appServer);
    const iterator = await startAppServerTurn(service, 'default');
    const threadParams = (
      appServer.request.mock.calls.find(
        ([method]) => method === 'thread/start',
      ) as any
    )[1];
    expect(threadParams.developerInstructions).toContain('Review destructive');
    expect(threadParams.config.mcp_servers.elevenex).toMatchObject({
      http_headers: { Authorization: 'Bearer evx_codex_test' },
      tool_timeout_sec: 660,
    });
    expect(
      threadParams.config.mcp_servers.elevenex.enabled_tools,
    ).toBeUndefined();
    expect(
      threadParams.config.mcp_servers.elevenex_local_computer,
    ).toBeUndefined();
    expect(
      (wire.turnStartParams as any).collaborationMode.settings
        .developer_instructions,
    ).toContain('Review destructive');
    await iterator.return(undefined);
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
      cwd: '/tmp/project',
      sandboxPolicy: {
        type: 'workspaceWrite',
        writableRoots: ['/tmp/project'],
      },
      approvalPolicy: 'on-request',
      approvalsReviewer: 'auto_review',
      serviceTier: null,
      collaborationMode: {
        mode: 'default',
        settings: {
          model: 'gpt-test',
          reasoning_effort: null,
          developer_instructions: null,
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

  it.each([
    ['default', 'workspaceWrite', 'on-request', 'user'],
    ['auto', 'workspaceWrite', 'on-request', 'auto_review'],
    ['acceptEdits', 'workspaceWrite', 'never', 'user'],
    ['bypassPermissions', 'dangerFullAccess', 'never', 'user'],
  ])(
    'restores %s permissions on the same loaded thread after leaving plan mode',
    async (mode, sandboxType, approvalPolicy, approvalsReviewer) => {
      const { service, appServer } = createService();
      const wire = wireAppServerTurn(appServer);
      const planIterator = await startAppServerTurn(service, mode, true);
      const completeTurn = async (iterator: AsyncGenerator<unknown>) => {
        wire.notificationHandler({
          method: 'turn/completed',
          params: { threadId: 'thread-1', turn: { status: 'completed' } },
        });
        await iterator.next();
        await expect(iterator.next()).resolves.toMatchObject({ done: true });
      };
      await completeTurn(planIterator);
      // The runtime stores the thread id when consuming thread.started.
      (service as any).ensureRuntimeState(7, 'thread-1');

      await service.setPlanMode(7, false);
      const implementationIterator = await startAppServerTurn(service, mode);

      expect(appServer.request).toHaveBeenCalledWith(
        'thread/resume',
        expect.objectContaining({ threadId: 'thread-1' }),
      );
      // A resume of an already-loaded thread can ignore configuration
      // overrides. The permissions must therefore be set on turn/start too.
      expect(wire.turnStartParams).toMatchObject({
        threadId: 'thread-1',
        cwd: '/tmp/project',
        sandboxPolicy: {
          type: sandboxType,
          ...(sandboxType === 'workspaceWrite'
            ? { writableRoots: ['/tmp/project'] }
            : {}),
        },
        approvalPolicy,
        approvalsReviewer,
        collaborationMode: { mode: 'default' },
      });
      await completeTurn(implementationIterator);

      await service.setPlanMode(7, true);
      const nextPlanIterator = await startAppServerTurn(service, mode);
      expect(wire.turnStartParams).toMatchObject({
        threadId: 'thread-1',
        sandboxPolicy: { type: 'readOnly' },
        approvalPolicy: 'never',
        approvalsReviewer: 'user',
        collaborationMode: { mode: 'plan' },
      });
      await completeTurn(nextPlanIterator);
      expect(
        appServer.request.mock.calls.filter(
          ([method]) => method === 'thread/start',
        ),
      ).toHaveLength(1);
    },
  );

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
