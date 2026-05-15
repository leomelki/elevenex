import '@angular/compiler';
import { TestBed } from '@angular/core/testing';
import { of, Subject } from 'rxjs';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { toast } from 'ngx-sonner';
import { ClaudeWorkspaceComponent } from './claude-workspace.component';
import { ClaudeRuntimeApiService } from '@/shared/services/claude-runtime-api.service';
import { ClaudeRuntimeWebsocketService } from '@/shared/services/claude-runtime-websocket.service';
import { ClaudeRuntimeEvent, ClaudeRuntimeState } from '@/shared/models/claude-runtime.model';
import { WorktreeContextService } from '@/shared/services/worktree-context.service';
import { SessionsService } from '@/shared/services/sessions.service';

vi.mock('ngx-sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

describe('ClaudeWorkspaceComponent', () => {
  const stubClipboard = (writeText: ReturnType<typeof vi.fn>) => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
  };

  const runtimeState = (): ClaudeRuntimeState => ({
    sessionId: 7,
    claudeSessionId: 'claude-session-1',
    runPhase: 'idle',
    sessionState: 'idle',
    canInterrupt: false,
    pendingPermissionRequest: null,
    pendingUserInputRequest: null,
    pendingPrompts: [],
    liveItems: [],
    lastError: null,
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
  });

  let apiMock: {
    getAutocompleteItems: ReturnType<typeof vi.fn>;
    getSubagentHistory: ReturnType<typeof vi.fn>;
    rewindConversation: ReturnType<typeof vi.fn>;
    getRuntimeState: ReturnType<typeof vi.fn>;
    setSelectedModel: ReturnType<typeof vi.fn>;
    setPermissionMode: ReturnType<typeof vi.fn>;
    openTerminalFallback: ReturnType<typeof vi.fn>;
    getHistory: ReturnType<typeof vi.fn>;
  };
  let wsMock: {
    connect: ReturnType<typeof vi.fn>;
    send: ReturnType<typeof vi.fn>;
    isConnected: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
    connectionState$: ReturnType<typeof vi.fn>;
  };
  let worktreeContextServiceMock: {
    get: ReturnType<typeof vi.fn>;
    generate: ReturnType<typeof vi.fn>;
    updateRootRef: ReturnType<typeof vi.fn>;
    consume: ReturnType<typeof vi.fn>;
  };
  const readyWorktreeContext = () => ({
    repoId: 1,
    worktreePath: '/tmp/project',
    contextSentence: 'This branch updates first-message context handling.',
    rootRef: 'origin/main',
    generationStatus: 'ready' as const,
    generatedAt: '2026-04-24T08:00:00.000Z',
    lastUsedAt: null,
    canGenerate: true,
    hasChanges: true,
    usingRepoDefaultRootRef: true,
    errorMessage: null,
    hasRecord: true,
  });

  const timestampAfter = (start: string, ms: number) =>
    new Date(new Date(start).getTime() + ms).toISOString();

  const linesOf = (count: number) =>
    Array.from({ length: count }, (_, i) => `line-${i}`).join('\n');

  type EditCall = {
    tool: 'Edit' | 'Write' | 'MultiEdit';
    file: string;
    oldString?: string;
    newString?: string;
    content?: string;
    edits?: { old_string: string; new_string: string }[];
    isError?: boolean;
  };

  const editTurnHistory = (
    suffix: string,
    start: string,
    calls: EditCall[],
  ) => {
    const items: Record<string, unknown>[] = [
      {
        id: `user-${suffix}`,
        kind: 'user',
        content: `Ship change ${suffix}`,
        timestamp: start,
        authoredAt: start,
      },
    ];
    calls.forEach((call, idx) => {
      const callId = `tool-${suffix}-${idx}`;
      const offset = (idx + 1) * 1000;
      let toolInput: Record<string, unknown>;
      if (call.tool === 'Edit') {
        toolInput = {
          file_path: call.file,
          old_string: call.oldString ?? '',
          new_string: call.newString ?? '',
        };
      } else if (call.tool === 'Write') {
        toolInput = { file_path: call.file, content: call.content ?? '' };
      } else {
        toolInput = { file_path: call.file, edits: call.edits ?? [] };
      }
      items.push({
        id: callId,
        kind: 'tool_use',
        toolUseId: callId,
        toolName: call.tool,
        toolInput,
        timestamp: timestampAfter(start, offset),
        receivedAt: timestampAfter(start, offset),
      });
      items.push({
        id: `tool-result-${suffix}-${idx}`,
        kind: 'tool_result',
        toolUseId: callId,
        content: call.isError ? 'failed' : 'ok',
        isError: call.isError ?? false,
        timestamp: timestampAfter(start, offset + 500),
        authoredAt: timestampAfter(start, offset + 500),
      });
    });
    items.push({
      id: `assistant-${suffix}`,
      kind: 'assistant',
      content: `Done ${suffix}`,
      timestamp: timestampAfter(start, (calls.length + 1) * 1000 + 500),
      receivedAt: timestampAfter(start, (calls.length + 1) * 1000 + 500),
    });
    return items as never[];
  };

  const collapsibleTurnHistory = (suffix = '1', start = '2026-04-24T08:00:00.000Z') => [
    {
      id: `user-${suffix}`,
      kind: 'user' as const,
      content: `Ship change ${suffix}`,
      timestamp: start,
      authoredAt: start,
    },
    {
      id: `tool-${suffix}`,
      kind: 'tool_use' as const,
      toolUseId: `tool-${suffix}`,
      toolName: 'Bash',
      toolInput: { command: 'pnpm test' },
      timestamp: timestampAfter(start, 1000),
      receivedAt: timestampAfter(start, 1000),
    },
    {
      id: `tool-result-${suffix}`,
      kind: 'tool_result' as const,
      toolUseId: `tool-${suffix}`,
      content: 'done',
      timestamp: timestampAfter(start, 2000),
      authoredAt: timestampAfter(start, 2000),
    },
    {
      id: `assistant-${suffix}`,
      kind: 'assistant' as const,
      content: `Done ${suffix}`,
      timestamp: timestampAfter(start, 3000),
      receivedAt: timestampAfter(start, 3000),
    },
  ];

  const flushPromises = async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  };

  const setScrollMetrics = (
    el: HTMLElement,
    metrics: { scrollTop: number; scrollHeight: number; clientHeight: number },
  ) => {
    Object.defineProperty(el, 'scrollHeight', {
      configurable: true,
      value: metrics.scrollHeight,
    });
    Object.defineProperty(el, 'clientHeight', {
      configurable: true,
      value: metrics.clientHeight,
    });
    el.scrollTop = metrics.scrollTop;
  };

  beforeEach(async () => {
    apiMock = {
      getAutocompleteItems: vi.fn(() => of([])),
      getSubagentHistory: vi.fn(() =>
        of({
          subagent: {
            agentId: 'agent-1',
            agentType: 'code-reviewer',
            status: 'stopped',
            lastAssistantMessage: 'Done.',
            timestamp: '2026-04-24T08:00:05.000Z',
          },
          history: [
            {
              id: 'agent-user-1',
              kind: 'user',
              content: 'Inspect tests',
              timestamp: '2026-04-24T08:00:00.000Z',
              authoredAt: '2026-04-24T08:00:00.000Z',
            },
          ],
          transcriptAvailable: true,
        }),
      ),
      rewindConversation: vi.fn(() =>
        of([
          {
            id: 'user-1',
            kind: 'user',
            content: 'Edited prompt source',
            timestamp: '2026-04-24T08:00:00.000Z',
            authoredAt: '2026-04-24T08:00:00.000Z',
            sourceMessageId: 'source-user-1',
          },
        ]),
      ),
      getRuntimeState: vi.fn(() => of(runtimeState())),
      setSelectedModel: vi.fn(() => of(runtimeState())),
      setPermissionMode: vi.fn(() => of(runtimeState())),
      openTerminalFallback: vi.fn(() => of({})),
      getHistory: vi.fn(() => of([])),
    };
    wsMock = {
      connect: vi.fn(() => new Subject().asObservable()),
      send: vi.fn(),
      isConnected: vi.fn(() => true),
      disconnect: vi.fn(),
      connectionState$: vi.fn(() => new Subject().asObservable()),
    };
    worktreeContextServiceMock = {
      get: vi.fn(() => of({
        repoId: 1,
        worktreePath: '/tmp/project',
        contextSentence: null,
        rootRef: null,
        generationStatus: 'idle',
        generatedAt: null,
        lastUsedAt: null,
        canGenerate: true,
        hasChanges: false,
        usingRepoDefaultRootRef: true,
        errorMessage: null,
        hasRecord: false,
      })),
      generate: vi.fn(() => of({
        repoId: 1,
        worktreePath: '/tmp/project',
        contextSentence: null,
        rootRef: null,
        generationStatus: 'idle',
        generatedAt: null,
        lastUsedAt: null,
        canGenerate: true,
        hasChanges: false,
        usingRepoDefaultRootRef: true,
        errorMessage: null,
        hasRecord: false,
      })),
      updateRootRef: vi.fn(() => of({})),
      consume: vi.fn(() => of({ shouldInject: false, contextSentence: null })),
    };
    await TestBed.configureTestingModule({
      imports: [ClaudeWorkspaceComponent],
      providers: [
        { provide: ClaudeRuntimeApiService, useValue: apiMock },
        { provide: ClaudeRuntimeWebsocketService, useValue: wsMock },
        { provide: WorktreeContextService, useValue: worktreeContextServiceMock },
        { provide: SessionsService, useValue: { updateActiveAgentProvider: vi.fn(() => of({})) } },
      ],
    }).compileComponents();
  });

  it('refreshes autocomplete after session metadata arrives', async () => {
    const events$ = new Subject<ClaudeRuntimeEvent>();
    wsMock.connect.mockReturnValue(events$.asObservable());
    apiMock.getAutocompleteItems
      .mockReturnValueOnce(of([{ id: 'builtin:/help', kind: 'command', trigger: '/', label: '/help', insertText: '/help ', description: 'Help', source: 'builtin' }]))
      .mockReturnValueOnce(of([{ id: 'runtime:/myskill', kind: 'skill', trigger: '/', label: '/myskill', insertText: '/myskill ', description: 'Runtime skill', source: 'runtime' }]));

    const fixture = TestBed.createComponent(ClaudeWorkspaceComponent);
    fixture.componentInstance.sessionId = 7;
    fixture.detectChanges();
    await Promise.resolve();

    events$.next({
      type: 'session_metadata',
      payload: {
        sessionId: 7,
        metadata: {
          cwd: '/tmp/project',
          model: 'sonnet',
          permissionMode: 'default',
          claudeCodeVersion: '1.2.3',
          outputStyle: 'default',
          apiKeySource: 'oauth',
          tools: [],
          slashCommands: ['/myskill'],
          skills: ['$myskill'],
          agents: [],
          fastModeState: null,
          mcpServers: [],
          plugins: [],
        },
      },
    });
    await Promise.resolve();

    expect(apiMock.getAutocompleteItems).toHaveBeenCalledTimes(2);
    expect(fixture.componentInstance.autocompleteItems()).toEqual([
      expect.objectContaining({ label: '/myskill', source: 'runtime' }),
    ]);
  });

  it('copies message content to the clipboard', async () => {
    const fixture = TestBed.createComponent(ClaudeWorkspaceComponent);
    fixture.componentInstance.sessionId = 7;
    fixture.detectChanges();
    fixture.componentInstance.loading.set(false);

    const writeText = vi.fn().mockResolvedValue(undefined);
    stubClipboard(writeText);

    await fixture.componentInstance.copyMessage({
      id: 'user-1',
      kind: 'user',
      content: 'Copy this',
      timestamp: '2026-04-24T08:00:00.000Z',
      sourceMessageId: 'source-user-1',
    });

    expect(writeText).toHaveBeenCalledWith('Copy this');
  });

  it('copies selected message text when provided', async () => {
    const fixture = TestBed.createComponent(ClaudeWorkspaceComponent);
    fixture.componentInstance.sessionId = 7;
    fixture.detectChanges();
    fixture.componentInstance.loading.set(false);

    const writeText = vi.fn().mockResolvedValue(undefined);
    stubClipboard(writeText);

    await fixture.componentInstance.copyMessage(
      {
        id: 'user-1',
        kind: 'user',
        content: 'Copy this whole message',
        timestamp: '2026-04-24T08:00:00.000Z',
        sourceMessageId: 'source-user-1',
      },
      'this whole',
    );

    expect(writeText).toHaveBeenCalledWith('this whole');
  });

  it('falls back to full message content when selected text is empty', async () => {
    const fixture = TestBed.createComponent(ClaudeWorkspaceComponent);
    fixture.componentInstance.sessionId = 7;
    fixture.detectChanges();
    fixture.componentInstance.loading.set(false);

    const writeText = vi.fn().mockResolvedValue(undefined);
    stubClipboard(writeText);

    await fixture.componentInstance.copyMessage(
      {
        id: 'user-1',
        kind: 'user',
        content: 'Copy fallback',
        timestamp: '2026-04-24T08:00:00.000Z',
        sourceMessageId: 'source-user-1',
      },
      '   ',
    );

    expect(writeText).toHaveBeenCalledWith('Copy fallback');
  });


  it('shows the waiting caret while Claude is still thinking', async () => {
    const fixture = TestBed.createComponent(ClaudeWorkspaceComponent);
    fixture.componentInstance.sessionId = 7;
    fixture.detectChanges();

    fixture.componentInstance.loading.set(false);
    fixture.componentInstance.hydrated.set(true);
    fixture.componentInstance.runPhase.set('running');
    fixture.componentInstance.liveItems.set([
      {
        id: 'thinking-1',
        kind: 'thinking',
        content: 'Planning the next step',
        timestamp: '2026-04-24T08:00:01.000Z',
        receivedAt: '2026-04-24T08:00:01.000Z',
      },
    ]);
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.cw-caret--waiting')).not.toBeNull();
  });

  it('keeps the waiting caret visible after thinking finishes until assistant output arrives', async () => {
    const fixture = TestBed.createComponent(ClaudeWorkspaceComponent);
    fixture.componentInstance.sessionId = 7;
    fixture.detectChanges();

    fixture.componentInstance.loading.set(false);
    fixture.componentInstance.hydrated.set(true);
    fixture.componentInstance.runPhase.set('waiting');
    fixture.componentInstance.historyItems.set([
      {
        id: 'thinking-1',
        kind: 'thinking',
        content: 'Planning the next step',
        timestamp: '2026-04-24T08:00:01.000Z',
        receivedAt: '2026-04-24T08:00:01.000Z',
      },
    ]);
    fixture.componentInstance.liveItems.set([]);
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.cw-caret--waiting')).not.toBeNull();
  });

  it('keeps transcript auto-scroll pinned while the user is at the bottom', async () => {
    const fixture = TestBed.createComponent(ClaudeWorkspaceComponent);
    fixture.componentInstance.sessionId = 7;
    fixture.detectChanges();
    fixture.componentInstance.loading.set(false);
    fixture.componentInstance.hydrated.set(true);
    fixture.detectChanges();
    await flushPromises();

    const transcript = fixture.nativeElement.querySelector('.cw-transcript') as HTMLElement;
    setScrollMetrics(transcript, { scrollTop: 800, scrollHeight: 1000, clientHeight: 200 });
    transcript.dispatchEvent(new Event('scroll'));

    setScrollMetrics(transcript, { scrollTop: 800, scrollHeight: 1200, clientHeight: 200 });
    fixture.componentInstance.historyItems.set([
      {
        id: 'user-1',
        kind: 'user',
        content: 'Keep following output',
        timestamp: '2026-04-24T08:00:00.000Z',
        authoredAt: '2026-04-24T08:00:00.000Z',
      },
    ]);
    fixture.detectChanges();
    await flushPromises();

    expect(transcript.scrollTop).toBe(1200);
  });

  it('does not force transcript auto-scroll while the user is reading older messages', async () => {
    const fixture = TestBed.createComponent(ClaudeWorkspaceComponent);
    fixture.componentInstance.sessionId = 7;
    fixture.detectChanges();
    fixture.componentInstance.loading.set(false);
    fixture.componentInstance.hydrated.set(true);
    fixture.componentInstance.historyItems.set([
      {
        id: 'user-1',
        kind: 'user',
        content: 'Older message',
        timestamp: '2026-04-24T08:00:00.000Z',
        authoredAt: '2026-04-24T08:00:00.000Z',
      },
    ]);
    fixture.detectChanges();
    await flushPromises();

    const transcript = fixture.nativeElement.querySelector('.cw-transcript') as HTMLElement;
    setScrollMetrics(transcript, { scrollTop: 500, scrollHeight: 1000, clientHeight: 200 });
    transcript.dispatchEvent(new Event('scroll'));

    setScrollMetrics(transcript, { scrollTop: 500, scrollHeight: 1200, clientHeight: 200 });
    fixture.componentInstance.historyItems.set([
      ...fixture.componentInstance.historyItems(),
      {
        id: 'assistant-1',
        kind: 'assistant',
        content: 'New output',
        timestamp: '2026-04-24T08:00:01.000Z',
        receivedAt: '2026-04-24T08:00:01.000Z',
      },
    ]);
    fixture.detectChanges();
    await flushPromises();

    expect(transcript.scrollTop).toBe(500);
  });

  it('resumes transcript auto-scroll after the user scrolls back to the bottom', async () => {
    const fixture = TestBed.createComponent(ClaudeWorkspaceComponent);
    fixture.componentInstance.sessionId = 7;
    fixture.detectChanges();
    fixture.componentInstance.loading.set(false);
    fixture.componentInstance.hydrated.set(true);
    fixture.componentInstance.historyItems.set([
      {
        id: 'user-1',
        kind: 'user',
        content: 'Older message',
        timestamp: '2026-04-24T08:00:00.000Z',
        authoredAt: '2026-04-24T08:00:00.000Z',
      },
    ]);
    fixture.detectChanges();
    await flushPromises();

    const transcript = fixture.nativeElement.querySelector('.cw-transcript') as HTMLElement;
    setScrollMetrics(transcript, { scrollTop: 500, scrollHeight: 1200, clientHeight: 200 });
    transcript.dispatchEvent(new Event('scroll'));
    setScrollMetrics(transcript, { scrollTop: 1000, scrollHeight: 1200, clientHeight: 200 });
    transcript.dispatchEvent(new Event('scroll'));

    setScrollMetrics(transcript, { scrollTop: 1000, scrollHeight: 1400, clientHeight: 200 });
    fixture.componentInstance.historyItems.set([
      ...fixture.componentInstance.historyItems(),
      {
        id: 'assistant-1',
        kind: 'assistant',
        content: 'New output',
        timestamp: '2026-04-24T08:00:01.000Z',
        receivedAt: '2026-04-24T08:00:01.000Z',
      },
    ]);
    fixture.detectChanges();
    await flushPromises();

    expect(transcript.scrollTop).toBe(1400);
  });

  it('rewinds conversation and restores the prompt into the composer state', async () => {
    const fixture = TestBed.createComponent(ClaudeWorkspaceComponent);
    fixture.componentInstance.sessionId = 7;
    fixture.detectChanges();
    fixture.componentInstance.loading.set(false);
    fixture.componentInstance.hydrated.set(true);

    await fixture.componentInstance.confirmEditMessage({
      id: 'user-1',
      kind: 'user',
      content: 'Edited prompt source',
      timestamp: '2026-04-24T08:00:00.000Z',
      authoredAt: '2026-04-24T08:00:00.000Z',
      sourceMessageId: 'source-user-1',
    });

    expect(apiMock.rewindConversation).toHaveBeenCalledWith(7, 'source-user-1');
    expect(fixture.componentInstance.prompt()).toBe('Edited prompt source');
    expect(fixture.componentInstance.historyItems()).toEqual([
      expect.objectContaining({
        content: 'Edited prompt source',
        sourceMessageId: 'source-user-1',
      }),
    ]);
    expect(fixture.componentInstance.armedEditMessageId()).toBeNull();
  });

  it('restores the last prompt when an interrupted run only produced thinking', async () => {
    const fixture = TestBed.createComponent(ClaudeWorkspaceComponent);
    fixture.componentInstance.sessionId = 7;
    fixture.detectChanges();
    fixture.componentInstance.loading.set(false);
    fixture.componentInstance.hydrated.set(true);
    apiMock.getHistory.mockReturnValueOnce(of([
      {
        id: 'user-1',
        kind: 'user',
        content: 'Change the stopped prompt',
        timestamp: '2026-04-24T08:00:00.000Z',
        authoredAt: '2026-04-24T08:00:00.000Z',
        sourceMessageId: 'source-user-1',
      },
      {
        id: 'thinking-1',
        kind: 'thinking',
        content: 'Internal planning',
        timestamp: '2026-04-24T08:00:01.000Z',
        receivedAt: '2026-04-24T08:00:01.000Z',
      },
    ]));
    apiMock.rewindConversation.mockReturnValueOnce(of([]));

    fixture.componentInstance.interrupt();
    (fixture.componentInstance as any).handleRuntimeEvent({
      type: 'complete',
      payload: { sessionId: 7 },
    });
    await flushPromises();

    expect(apiMock.rewindConversation).toHaveBeenCalledWith(7, 'source-user-1');
    expect(fixture.componentInstance.prompt()).toBe('Change the stopped prompt');
    expect(fixture.componentInstance.historyItems()).toEqual([]);
  });

  it('keeps the stopped prompt editable when Claude already responded', async () => {
    const fixture = TestBed.createComponent(ClaudeWorkspaceComponent);
    fixture.componentInstance.sessionId = 7;
    fixture.detectChanges();
    fixture.componentInstance.loading.set(false);
    fixture.componentInstance.hydrated.set(true);
    const userItem = {
      id: 'user-1',
      kind: 'user' as const,
      content: 'Prompt with partial response',
      timestamp: '2026-04-24T08:00:00.000Z',
      authoredAt: '2026-04-24T08:00:00.000Z',
      sourceMessageId: 'source-user-1',
    };
    apiMock.getHistory.mockReturnValueOnce(of([
      userItem,
      {
        id: 'assistant-1',
        kind: 'assistant',
        content: 'Started answering',
        timestamp: '2026-04-24T08:00:01.000Z',
        receivedAt: '2026-04-24T08:00:01.000Z',
      },
    ]));

    fixture.componentInstance.interrupt();
    (fixture.componentInstance as any).handleRuntimeEvent({
      type: 'complete',
      payload: { sessionId: 7 },
    });
    await flushPromises();

    expect(apiMock.rewindConversation).not.toHaveBeenCalled();
    expect(fixture.componentInstance.canShowMessageActions(userItem)).toBe(true);
    expect(fixture.componentInstance.messageActionsDisabled()).toBe(false);
  });

  it('opens agent inspector from a collapsed turn and lazy-loads subagent history once', async () => {
    const events$ = new Subject<ClaudeRuntimeEvent>();
    wsMock.connect.mockReturnValue(events$.asObservable());

    const fixture = TestBed.createComponent(ClaudeWorkspaceComponent);
    fixture.componentInstance.sessionId = 7;
    fixture.detectChanges();

    events$.next({
      type: 'session_snapshot',
      payload: {
        ...runtimeState(),
        history: [
          {
            id: 'user-1',
            kind: 'user',
            content: 'Ship it',
            timestamp: '2026-04-24T08:00:00.000Z',
            authoredAt: '2026-04-24T08:00:00.000Z',
          },
          {
            id: 'tool-1',
            kind: 'tool_use',
            toolUseId: 'tool-1',
            toolName: 'Task',
            toolInput: { description: 'inspect tests', subagent_type: 'code-reviewer' },
            timestamp: '2026-04-24T08:00:02.000Z',
            receivedAt: '2026-04-24T08:00:02.000Z',
          },
          {
            id: 'tool-result-1',
            kind: 'tool_result',
            toolUseId: 'tool-1',
            content: 'done',
            timestamp: '2026-04-24T08:00:04.000Z',
            authoredAt: '2026-04-24T08:00:04.000Z',
          },
          {
            id: 'assistant-1',
            kind: 'assistant',
            content: 'Done',
            timestamp: '2026-04-24T08:00:05.000Z',
            receivedAt: '2026-04-24T08:00:05.000Z',
          },
        ],
        subagents: [
          {
            agentId: 'agent-1',
            agentType: 'code-reviewer',
            status: 'stopped',
            lastAssistantMessage: 'Done.',
            transcriptPath: '/tmp/agent-1.jsonl',
            timestamp: '2026-04-24T08:00:05.000Z',
          },
        ],
        recentHookEvents: [
          {
            eventName: 'SubagentStart',
            agentId: 'agent-1',
            agentType: 'code-reviewer',
            timestamp: '2026-04-24T08:00:02.500Z',
            raw: {},
          },
          {
            eventName: 'SubagentStop',
            agentId: 'agent-1',
            agentType: 'code-reviewer',
            timestamp: '2026-04-24T08:00:05.000Z',
            raw: {},
          },
        ],
      },
    });
    fixture.componentInstance.loading.set(false);
    fixture.detectChanges();

    const inspect = Array.from(
      fixture.nativeElement.querySelectorAll('.cw-turn-gap__inspect'),
    ) as HTMLButtonElement[];
    inspect[0]?.click();

    await Promise.resolve();
    fixture.detectChanges();

    expect(apiMock.getSubagentHistory).toHaveBeenCalledWith(7, 'agent-1');
    expect(fixture.componentInstance.selectedAgentInspectorTurn()?.agents).toHaveLength(1);

    fixture.componentInstance.selectAgentInspectorAgent('agent-1');
    await Promise.resolve();
    expect(apiMock.getSubagentHistory).toHaveBeenCalledTimes(1);
  });

  it('renders completed turn change stats from edit tool calls', async () => {
    const events$ = new Subject<ClaudeRuntimeEvent>();
    wsMock.connect.mockReturnValue(events$.asObservable());
    apiMock.getHistory.mockReturnValue(of(editTurnHistory('1', '2026-04-24T08:00:00.000Z', [
      { tool: 'Edit', file: 'a.ts', oldString: linesOf(4), newString: linesOf(14) },
      { tool: 'Edit', file: 'b.ts', oldString: linesOf(4), newString: linesOf(14) },
      { tool: 'Write', file: 'c.ts', content: linesOf(14) },
    ])));

    const fixture = TestBed.createComponent(ClaudeWorkspaceComponent);
    fixture.componentInstance.sessionId = 7;
    fixture.componentInstance.worktreePath = '/tmp/project';
    fixture.detectChanges();
    fixture.componentInstance.loading.set(false);
    fixture.componentInstance.hydrated.set(true);

    events$.next({ type: 'complete', payload: { sessionId: 7 } });
    await flushPromises();
    fixture.detectChanges();

    const changes = fixture.nativeElement.querySelector('.cw-turn-gap__changes') as HTMLElement | null;
    expect(changes?.textContent).toContain('3 files');
    expect(changes?.textContent).toContain('+42');
    expect(changes?.textContent).toContain('-8');
  });

  it('opens a file-by-file diff view for turn changes', async () => {
    const events$ = new Subject<ClaudeRuntimeEvent>();
    wsMock.connect.mockReturnValue(events$.asObservable());
    apiMock.getHistory.mockReturnValue(of(editTurnHistory('1', '2026-04-24T08:00:00.000Z', [
      {
        tool: 'MultiEdit',
        file: 'src/app.ts',
        edits: [
          { old_string: 'const a = 1;\nconst b = 2;', new_string: 'const a = 1;\nconst b = 3;' },
          { old_string: 'export const name = "old";', new_string: 'export const name = "new";' },
        ],
      },
      { tool: 'Write', file: 'src/new.ts', content: 'export const created = true;' },
    ])));

    const fixture = TestBed.createComponent(ClaudeWorkspaceComponent);
    fixture.componentInstance.sessionId = 7;
    fixture.componentInstance.worktreePath = '/tmp/project';
    fixture.detectChanges();
    fixture.componentInstance.loading.set(false);
    fixture.componentInstance.hydrated.set(true);

    events$.next({ type: 'complete', payload: { sessionId: 7 } });
    await flushPromises();
    fixture.detectChanges();

    const button = fixture.nativeElement.querySelector('.cw-turn-gap__changes-button') as HTMLButtonElement | null;
    expect(button?.textContent).toContain('View changes');
    button?.click();
    fixture.detectChanges();

    const panel = fixture.nativeElement.querySelector('cw-turn-changes') as HTMLElement | null;
    expect(panel?.textContent).toContain('Changes in this turn');
    expect(panel?.textContent).toContain('app.ts');
    expect(panel?.textContent).toContain('new.ts');
    expect(panel?.querySelectorAll('.cw-turn-changes__file')).toHaveLength(2);
    expect(panel?.querySelector('.cw-turn-changes__diff')?.innerHTML).toContain('cw-diff-line');
  });

  it('opens turn changes from an already hydrated historical session', async () => {
    const events$ = new Subject<ClaudeRuntimeEvent>();
    wsMock.connect.mockReturnValue(events$.asObservable());

    const fixture = TestBed.createComponent(ClaudeWorkspaceComponent);
    fixture.componentInstance.sessionId = 7;
    fixture.componentInstance.worktreePath = '/tmp/project';
    fixture.detectChanges();
    await Promise.resolve();

    events$.next({
      type: 'session_snapshot',
      payload: {
        ...runtimeState(),
        sessionId: 7,
        history: editTurnHistory('yesterday', '2026-04-23T18:00:00.000Z', [
          { tool: 'Edit', file: 'src/yesterday.ts', oldString: 'export const value = 1;', newString: 'export const value = 2;' },
        ]),
      },
    });
    await flushPromises();
    fixture.detectChanges();

    const button = fixture.nativeElement.querySelector('.cw-turn-gap__changes-button') as HTMLButtonElement | null;
    expect(button?.textContent).toContain('View changes');
    button?.click();
    fixture.detectChanges();

    const panel = fixture.nativeElement.querySelector('cw-turn-changes') as HTMLElement | null;
    expect(panel?.textContent).toContain('yesterday.ts');
    expect(panel?.textContent).toContain('Changes in this turn');
  });

  it('includes nested subagent edits in the parent turn changes', async () => {
    const events$ = new Subject<ClaudeRuntimeEvent>();
    wsMock.connect.mockReturnValue(events$.asObservable());

    const fixture = TestBed.createComponent(ClaudeWorkspaceComponent);
    fixture.componentInstance.sessionId = 7;
    fixture.componentInstance.worktreePath = '/tmp/project';
    fixture.detectChanges();
    await Promise.resolve();

    events$.next({
      type: 'session_snapshot',
      payload: {
        ...runtimeState(),
        sessionId: 7,
        history: [
          {
            id: 'user-nested',
            kind: 'user',
            content: 'Delegate edit',
            timestamp: '2026-04-23T18:00:00.000Z',
          },
          {
            id: 'task-nested',
            kind: 'tool_use',
            toolUseId: 'task-nested',
            toolName: 'Task',
            toolInput: { description: 'Edit nested file' },
            timestamp: '2026-04-23T18:00:01.000Z',
          },
          {
            id: 'child-edit',
            kind: 'tool_use',
            toolUseId: 'child-edit',
            parentToolUseId: 'task-nested',
            toolName: 'Edit',
            toolInput: {
              file_path: 'src/nested.ts',
              old_string: 'export const nested = false;',
              new_string: 'export const nested = true;',
            },
            timestamp: '2026-04-23T18:00:02.000Z',
          },
          {
            id: 'child-result',
            kind: 'tool_result',
            toolUseId: 'child-edit',
            parentToolUseId: 'task-nested',
            content: 'ok',
            timestamp: '2026-04-23T18:00:03.000Z',
          },
          {
            id: 'task-result',
            kind: 'tool_result',
            toolUseId: 'task-nested',
            content: 'done',
            timestamp: '2026-04-23T18:00:04.000Z',
          },
          {
            id: 'assistant-nested',
            kind: 'assistant',
            content: 'Done',
            timestamp: '2026-04-23T18:00:05.000Z',
          },
        ],
      },
    });
    await flushPromises();
    fixture.detectChanges();

    const changes = fixture.nativeElement.querySelector('.cw-turn-gap__changes') as HTMLElement | null;
    expect(changes?.textContent).toContain('1 file');

    const button = fixture.nativeElement.querySelector('.cw-turn-gap__changes-button') as HTMLButtonElement | null;
    button?.click();
    fixture.detectChanges();

    const panel = fixture.nativeElement.querySelector('cw-turn-changes') as HTMLElement | null;
    expect(panel?.textContent).toContain('nested.ts');
  });

  it('dedupes identical edits and counts each file once', async () => {
    const events$ = new Subject<ClaudeRuntimeEvent>();
    wsMock.connect.mockReturnValue(events$.asObservable());
    // Same Edit retried, plus a second Edit on the same file → file counted once,
    // first edit's lines counted once, second edit adds its own lines.
    apiMock.getHistory.mockReturnValue(of(editTurnHistory('1', '2026-04-24T08:00:00.000Z', [
      { tool: 'Edit', file: 'a.ts', oldString: linesOf(2), newString: linesOf(5) },
      { tool: 'Edit', file: 'a.ts', oldString: linesOf(2), newString: linesOf(5) },
      { tool: 'Edit', file: 'a.ts', oldString: linesOf(1), newString: linesOf(3) },
    ])));

    const fixture = TestBed.createComponent(ClaudeWorkspaceComponent);
    fixture.componentInstance.sessionId = 7;
    fixture.componentInstance.worktreePath = '/tmp/project';
    fixture.detectChanges();
    fixture.componentInstance.loading.set(false);
    fixture.componentInstance.hydrated.set(true);

    events$.next({ type: 'complete', payload: { sessionId: 7 } });
    await flushPromises();
    fixture.detectChanges();

    const changes = fixture.nativeElement.querySelector('.cw-turn-gap__changes') as HTMLElement | null;
    expect(changes?.textContent).toContain('1 file');
    expect(changes?.textContent).toContain('+8');
    expect(changes?.textContent).toContain('-3');
  });

  it('omits completed turn change stats when no edit tools ran', async () => {
    const events$ = new Subject<ClaudeRuntimeEvent>();
    wsMock.connect.mockReturnValue(events$.asObservable());
    apiMock.getHistory.mockReturnValue(of(collapsibleTurnHistory()));

    const fixture = TestBed.createComponent(ClaudeWorkspaceComponent);
    fixture.componentInstance.sessionId = 7;
    fixture.componentInstance.worktreePath = '/tmp/project';
    fixture.detectChanges();
    fixture.componentInstance.loading.set(false);
    fixture.componentInstance.hydrated.set(true);

    events$.next({ type: 'complete', payload: { sessionId: 7 } });
    await flushPromises();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.cw-turn-gap__changes')).toBeNull();
  });

  it('skips failed edit tool calls when computing change stats', async () => {
    const events$ = new Subject<ClaudeRuntimeEvent>();
    wsMock.connect.mockReturnValue(events$.asObservable());
    apiMock.getHistory.mockReturnValue(of(editTurnHistory('1', '2026-04-24T08:00:00.000Z', [
      { tool: 'Edit', file: 'a.ts', oldString: linesOf(3), newString: linesOf(5), isError: true },
    ])));

    const fixture = TestBed.createComponent(ClaudeWorkspaceComponent);
    fixture.componentInstance.sessionId = 7;
    fixture.componentInstance.worktreePath = '/tmp/project';
    fixture.detectChanges();
    fixture.componentInstance.loading.set(false);
    fixture.componentInstance.hydrated.set(true);

    events$.next({ type: 'complete', payload: { sessionId: 7 } });
    await flushPromises();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.cw-turn-gap__changes')).toBeNull();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('attaches change stats to every collapsed turn rendered from history', async () => {
    const events$ = new Subject<ClaudeRuntimeEvent>();
    wsMock.connect.mockReturnValue(events$.asObservable());
    apiMock.getHistory.mockReturnValue(of([
      ...editTurnHistory('1', '2026-04-24T08:00:00.000Z', [
        { tool: 'Edit', file: 'a.ts', oldString: linesOf(2), newString: linesOf(2) },
      ]),
      ...editTurnHistory('2', '2026-04-24T08:01:00.000Z', [
        { tool: 'Edit', file: 'a.ts', oldString: linesOf(1), newString: linesOf(5) },
        { tool: 'Write', file: 'b.ts', content: linesOf(4) },
      ]),
    ]));

    const fixture = TestBed.createComponent(ClaudeWorkspaceComponent);
    fixture.componentInstance.sessionId = 7;
    fixture.componentInstance.worktreePath = '/tmp/project';
    fixture.detectChanges();
    fixture.componentInstance.loading.set(false);
    fixture.componentInstance.hydrated.set(true);

    events$.next({ type: 'complete', payload: { sessionId: 7 } });
    await flushPromises();
    fixture.detectChanges();

    // Both turns get their stats inline from renderItems, so reopened sessions
    // never have to wait for `complete` to repopulate the badges.
    const badges = fixture.nativeElement.querySelectorAll('.cw-turn-gap__changes');
    expect(badges).toHaveLength(2);
    expect((badges[0] as HTMLElement).textContent).toContain('1 file');
    expect((badges[0] as HTMLElement).textContent).toContain('+2');
    expect((badges[0] as HTMLElement).textContent).toContain('-2');
    expect((badges[1] as HTMLElement).textContent).toContain('2 files');
    expect((badges[1] as HTMLElement).textContent).toContain('+9');
    expect((badges[1] as HTMLElement).textContent).toContain('-1');
  });

  it('injects the already-fetched ready context into the first prompt', async () => {
    const fixture = TestBed.createComponent(ClaudeWorkspaceComponent);
    fixture.componentInstance.sessionId = 7;
    fixture.componentInstance.repoId = 1;
    fixture.componentInstance.worktreePath = '/tmp/project';
    fixture.detectChanges();
    await Promise.resolve();

    fixture.componentInstance.worktreeContext.set(readyWorktreeContext());
    worktreeContextServiceMock.consume.mockReturnValue(of({
      shouldInject: true,
      contextSentence: 'This branch updates first-message context handling.',
    }));

    await fixture.componentInstance.submitPrompt('Ship this change');

    expect(worktreeContextServiceMock.consume).toHaveBeenCalledWith(
      7,
      true,
      'This branch updates first-message context handling.',
    );
    expect(wsMock.send).toHaveBeenLastCalledWith(7, {
      type: 'submit_prompt',
      prompt: [
        '<elevenex-worktree-context>',
        'Context for this session: This branch updates first-message context handling.',
        '</elevenex-worktree-context>',
        '',
        'Ship this change',
      ].join('\n'),
      titlePrompt: 'Ship this change',
    });
    expect(fixture.componentInstance.hasInjectedContext()).toBe(true);
  });

  it('does not call consume when local context is not ready', async () => {
    const fixture = TestBed.createComponent(ClaudeWorkspaceComponent);
    fixture.componentInstance.sessionId = 7;
    fixture.detectChanges();
    await Promise.resolve();

    fixture.componentInstance.worktreeContext.set({
      ...readyWorktreeContext(),
      contextSentence: null,
      generationStatus: 'generating',
    });

    await fixture.componentInstance.submitPrompt('Ship this change');

    expect(worktreeContextServiceMock.consume).not.toHaveBeenCalled();
    expect(wsMock.send).toHaveBeenLastCalledWith(7, {
      type: 'submit_prompt',
      prompt: 'Ship this change',
      titlePrompt: 'Ship this change',
    });
  });

  it('does not call consume when first-message context is disabled', async () => {
    const fixture = TestBed.createComponent(ClaudeWorkspaceComponent);
    fixture.componentInstance.sessionId = 7;
    fixture.detectChanges();
    await Promise.resolve();

    fixture.componentInstance.worktreeContext.set(readyWorktreeContext());
    fixture.componentInstance.firstPromptContextEnabled.set(false);

    await fixture.componentInstance.submitPrompt('Ship this change');

    expect(worktreeContextServiceMock.consume).not.toHaveBeenCalled();
    expect(wsMock.send).toHaveBeenLastCalledWith(7, {
      type: 'submit_prompt',
      prompt: 'Ship this change',
      titlePrompt: 'Ship this change',
    });
  });

  it('does not call consume for slash commands', async () => {
    const fixture = TestBed.createComponent(ClaudeWorkspaceComponent);
    fixture.componentInstance.sessionId = 7;
    fixture.detectChanges();
    await Promise.resolve();

    fixture.componentInstance.worktreeContext.set(readyWorktreeContext());

    await fixture.componentInstance.submitPrompt('/status');

    expect(worktreeContextServiceMock.consume).not.toHaveBeenCalled();
    expect(wsMock.send).toHaveBeenLastCalledWith(7, {
      type: 'submit_prompt',
      prompt: '/status',
      titlePrompt: '/status',
    });
  });

  it('sends cached context immediately even when consume bookkeeping resolves later', async () => {
    const consume$ = new Subject<{ shouldInject: boolean; contextSentence: string | null }>();
    worktreeContextServiceMock.consume.mockReturnValue(consume$.asObservable());

    const fixture = TestBed.createComponent(ClaudeWorkspaceComponent);
    fixture.componentInstance.sessionId = 7;
    fixture.detectChanges();
    await Promise.resolve();

    fixture.componentInstance.worktreeContext.set(readyWorktreeContext());

    const submitPromise = fixture.componentInstance.submitPrompt('Ship this change');
    await submitPromise;

    expect(wsMock.send).toHaveBeenLastCalledWith(7, {
      type: 'submit_prompt',
      prompt: [
        '<elevenex-worktree-context>',
        'Context for this session: This branch updates first-message context handling.',
        '</elevenex-worktree-context>',
        '',
        'Ship this change',
      ].join('\n'),
      titlePrompt: 'Ship this change',
    });
    expect(worktreeContextServiceMock.consume).toHaveBeenCalledWith(
      7,
      true,
      'This branch updates first-message context handling.',
    );
    expect(fixture.componentInstance.hasInjectedContext()).toBe(true);

    consume$.next({ shouldInject: false, contextSentence: null });
    consume$.complete();
  });

  it('clears the composer immediately without waiting for worktree context consume', async () => {
    const consume$ = new Subject<{ shouldInject: boolean; contextSentence: string | null }>();
    worktreeContextServiceMock.consume.mockReturnValue(consume$.asObservable());

    const fixture = TestBed.createComponent(ClaudeWorkspaceComponent);
    fixture.componentInstance.sessionId = 7;
    fixture.detectChanges();
    await Promise.resolve();

    fixture.componentInstance.worktreeContext.set(readyWorktreeContext());
    fixture.componentInstance.prompt.set('Ship this change');
    const submitPromise = fixture.componentInstance.submitPrompt('Ship this change');

    expect(fixture.componentInstance.prompt()).toBe('');
    expect(fixture.componentInstance.submitting()).toBe(true);
    expect(fixture.componentInstance.optimisticUserItems()).toEqual([
      expect.objectContaining({ content: 'Ship this change' }),
    ]);
    expect(wsMock.send).toHaveBeenLastCalledWith(7, {
      type: 'submit_prompt',
      prompt: [
        '<elevenex-worktree-context>',
        'Context for this session: This branch updates first-message context handling.',
        '</elevenex-worktree-context>',
        '',
        'Ship this change',
      ].join('\n'),
      titlePrompt: 'Ship this change',
    });

    consume$.next({
      shouldInject: true,
      contextSentence: 'This branch updates first-message context handling.',
    });
    consume$.complete();
    await submitPromise;

    expect(wsMock.send).toHaveBeenLastCalledWith(7, {
      type: 'submit_prompt',
      prompt: [
        '<elevenex-worktree-context>',
        'Context for this session: This branch updates first-message context handling.',
        '</elevenex-worktree-context>',
        '',
        'Ship this change',
      ].join('\n'),
      titlePrompt: 'Ship this change',
    });
  });

  it('uses cached-only worktree context loading before a new Codex session starts', async () => {
    const fixture = TestBed.createComponent(ClaudeWorkspaceComponent);
    fixture.componentInstance.sessionId = 7;
    fixture.componentInstance.repoId = 1;
    fixture.componentInstance.worktreePath = '/tmp/project';
    fixture.componentInstance.activeAgentProvider = 'codex';
    fixture.componentInstance.hasStartedAgentRuntime = false;

    fixture.detectChanges();
    await Promise.resolve();

    expect(worktreeContextServiceMock.get).toHaveBeenCalledWith(
      1,
      '/tmp/project',
      { cachedOnly: true },
    );
    expect(worktreeContextServiceMock.generate).not.toHaveBeenCalled();
  });

  it('updates the live tool card when permission resolution arrives', async () => {
    const events$ = new Subject<ClaudeRuntimeEvent>();
    wsMock.connect.mockReturnValue(events$.asObservable());

    const fixture = TestBed.createComponent(ClaudeWorkspaceComponent);
    fixture.componentInstance.sessionId = 7;
    fixture.detectChanges();

    events$.next({
      type: 'tool_use',
      payload: {
        sessionId: 7,
        item: {
          id: 'tool-1',
          kind: 'tool_use',
          toolUseId: 'tool-1',
          toolName: 'AskUserQuestion',
          toolInput: { questions: [{ question: 'Which approach should we use?' }] },
          timestamp: '2026-04-24T08:00:00.000Z',
        },
      },
    });

    events$.next({
      type: 'permission_resolved',
      payload: {
        sessionId: 7,
        requestId: 'perm-1',
        toolUseId: 'tool-1',
        decision: 'approved',
        interaction: {
          kind: 'ask_user_question',
          decision: 'answered',
          decisionLabel: 'Answered',
          decisionTone: 'ok',
          remember: false,
          answers: [{ question: 'Which approach should we use?', answer: 'Option A' }],
          createdAt: '2026-04-24T08:00:00.000Z',
          resolvedAt: '2026-04-24T08:00:05.000Z',
        },
      },
    });

    fixture.detectChanges();

    expect(fixture.componentInstance.liveItems()).toEqual([
      expect.objectContaining({
        toolUseId: 'tool-1',
        interaction: expect.objectContaining({
          decisionLabel: 'Answered',
          answers: [{ question: 'Which approach should we use?', answer: 'Option A' }],
        }),
      }),
    ]);
  });

  it('rehydrates the runtime socket before answering a pending question when disconnected', async () => {
    const events$ = new Subject<ClaudeRuntimeEvent>();
    wsMock.connect.mockReturnValue(events$.asObservable());

    const fixture = TestBed.createComponent(ClaudeWorkspaceComponent);
    fixture.componentInstance.sessionId = 7;
    fixture.detectChanges();
    wsMock.send.mockClear();
    wsMock.disconnect.mockClear();
    wsMock.connect.mockClear();
    wsMock.isConnected.mockReturnValue(false);

    fixture.componentInstance.pendingUserInputRequest.set({
      requestId: 'input-1',
      serverName: 'github',
      message: 'Authorize GitHub?',
      createdAt: '2026-04-24T08:00:00.000Z',
    });

    fixture.componentInstance.answerUserInput({
      action: 'accept',
      content: { token: 'abc' },
    });

    expect(wsMock.disconnect).toHaveBeenCalledWith(7);
    expect(wsMock.connect).toHaveBeenCalledWith(7);
    expect(wsMock.send).toHaveBeenNthCalledWith(1, 7, { type: 'hydrate' });
    expect(wsMock.send).toHaveBeenNthCalledWith(2, 7, {
      type: 'answer_user_input',
      requestId: 'input-1',
      action: 'accept',
      content: { token: 'abc' },
    });
  });

  it('clears pending permission when run state reports no pending request', async () => {
    const events$ = new Subject<ClaudeRuntimeEvent>();
    wsMock.connect.mockReturnValue(events$.asObservable());

    const fixture = TestBed.createComponent(ClaudeWorkspaceComponent);
    fixture.componentInstance.sessionId = 7;
    fixture.detectChanges();

    fixture.componentInstance.pendingPermissionRequest.set({
      requestId: 'perm-1',
      toolUseId: 'tool-1',
      toolName: 'ExitPlanMode',
      input: {},
      createdAt: '2026-04-24T08:00:00.000Z',
    });

    events$.next({
      type: 'run_state',
      payload: {
        sessionId: 7,
        runPhase: 'running',
        sessionState: 'running',
        canInterrupt: true,
        lastError: null,
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

    expect(fixture.componentInstance.pendingPermissionRequest()).toBeNull();
  });

  it('deduplicates matching history and live tool items after hydrate snapshot reload', async () => {
    const events$ = new Subject<ClaudeRuntimeEvent>();
    wsMock.connect.mockReturnValue(events$.asObservable());

    const fixture = TestBed.createComponent(ClaudeWorkspaceComponent);
    fixture.componentInstance.sessionId = 7;
    fixture.detectChanges();

    events$.next({
      type: 'session_snapshot',
      payload: {
        ...runtimeState(),
        history: [
          {
            id: 'user-1',
            kind: 'user',
            content: 'Inspect repo state',
            timestamp: '2026-04-28T08:00:00.000Z',
            authoredAt: '2026-04-28T08:00:00.000Z',
          },
          {
            id: 'msg-1:tool_use:toolu_1',
            kind: 'tool_use',
            toolUseId: 'toolu_1',
            toolName: 'Bash',
            toolInput: { command: 'pwd' },
            sourceMessageId: 'msg-1',
            timestamp: '2026-04-28T08:00:01.000Z',
            receivedAt: '2026-04-28T08:00:01.000Z',
          },
          {
            id: 'msg-2:tool_result:toolu_1',
            kind: 'tool_result',
            toolUseId: 'toolu_1',
            content: '/workspace',
            sourceMessageId: 'msg-2',
            timestamp: '2026-04-28T08:00:02.000Z',
            authoredAt: '2026-04-28T08:00:02.000Z',
          },
        ],
        liveItems: [
          {
            id: 'msg-1:tool:toolu_1',
            kind: 'tool_use',
            toolUseId: 'toolu_1',
            toolName: 'Bash',
            toolInput: {},
            timestamp: '2026-04-28T08:00:01.000Z',
            receivedAt: '2026-04-28T08:00:01.000Z',
          },
          {
            id: 'msg-2:tool:toolu_1',
            kind: 'tool_result',
            toolUseId: 'toolu_1',
            content: '/work',
            timestamp: '2026-04-28T08:00:02.000Z',
            authoredAt: '2026-04-28T08:00:02.000Z',
          },
        ],
      },
    });
    fixture.detectChanges();

    const toolUnits = fixture.componentInstance.pairedTranscript().filter((unit) => unit.kind === 'tool');
    expect(toolUnits).toHaveLength(1);
    expect(toolUnits[0]).toMatchObject({
      toolUseId: 'toolu_1',
      call: expect.objectContaining({
        id: 'msg-1:tool_use:toolu_1',
        toolInput: { command: 'pwd' },
      }),
      result: expect.objectContaining({
        id: 'msg-2:tool_result:toolu_1',
        content: '/workspace',
      }),
    });
  });

  it('renders pending permissions in the composer dock and disables send', async () => {
    const fixture = TestBed.createComponent(ClaudeWorkspaceComponent);
    fixture.componentInstance.sessionId = 7;
    fixture.detectChanges();

    fixture.componentInstance.loading.set(false);
    fixture.componentInstance.hydrated.set(true);
    fixture.componentInstance.prompt.set('Can you continue?');
    fixture.componentInstance.pendingPermissionRequest.set({
      requestId: 'perm-1',
      toolUseId: 'tool-1',
      toolName: 'Bash',
      displayName: 'Bash',
      description: 'Needs permission to read outside the workspace.',
      blockedPath: '/outside-boundary/file.txt',
      input: { command: 'cat /outside-boundary/file.txt' },
      suggestions: [
        {
          type: 'addRules',
          behavior: 'allow',
          destination: 'localSettings',
          rules: [{ toolName: 'Bash', ruleContent: 'cat /outside-boundary/*' }],
        },
      ],
      createdAt: '2026-04-24T08:00:02.000Z',
    });
    fixture.detectChanges();

    const element = fixture.nativeElement as HTMLElement;
    const permissionCard = element.querySelector('.cw-compose-shell__permission');
    const sendButton = element.querySelector('.cw-comp__btn--send') as HTMLButtonElement;
    expect(permissionCard?.textContent).toContain('Approval required');
    expect(permissionCard?.textContent).toContain('/outside-boundary/file.txt');
    expect(permissionCard?.textContent).toContain('Always allow saves this pattern');
    expect(permissionCard?.textContent).toContain('Bash(cat /outside-boundary/*)');
    expect(permissionCard?.textContent).toContain('Always allow');
    expect(sendButton.disabled).toBe(true);
    expect(element.querySelector('.cw-stream .cw-perm')).toBeNull();
  });

  it('shows subagent permissions in the composer dock instead of nested tool cards', async () => {
    const fixture = TestBed.createComponent(ClaudeWorkspaceComponent);
    fixture.componentInstance.sessionId = 7;
    fixture.detectChanges();

    fixture.componentInstance.loading.set(false);
    fixture.componentInstance.hydrated.set(true);
    fixture.componentInstance.historyItems.set([
      {
        id: 'user-1',
        kind: 'user',
        content: 'Inspect files',
        timestamp: '2026-04-24T08:00:00.000Z',
      },
      {
        id: 'task-1',
        kind: 'tool_use',
        toolUseId: 'task-1',
        toolName: 'Task',
        toolInput: { description: 'Inspect files' },
        timestamp: '2026-04-24T08:00:01.000Z',
      },
      {
        id: 'child-bash-1',
        kind: 'tool_use',
        toolUseId: 'child-bash-1',
        parentToolUseId: 'task-1',
        toolName: 'Bash',
        toolInput: { command: 'cat /outside-boundary/file.txt' },
        timestamp: '2026-04-24T08:00:02.000Z',
      },
    ]);
    fixture.componentInstance.pendingPermissionRequest.set({
      requestId: 'perm-subagent-1',
      toolUseId: 'child-bash-1',
      toolName: 'Bash',
      displayName: 'Bash',
      agentId: 'agent-7',
      description: 'The delegated agent needs workspace-external access.',
      blockedPath: '/outside-boundary/file.txt',
      input: { command: 'cat /outside-boundary/file.txt' },
      createdAt: '2026-04-24T08:00:03.000Z',
    });
    fixture.detectChanges();

    const element = fixture.nativeElement as HTMLElement;
    const permissionCard = element.querySelector('.cw-compose-shell__permission');
    expect(permissionCard?.textContent).toContain('Subagent');
    expect(permissionCard?.textContent).toContain('agent-7');
    expect(element.querySelector('.cw-tool .cw-perm')).toBeNull();
  });
});
