import '@angular/compiler';
import { TestBed } from '@angular/core/testing';
import { NEVER, of, Subject } from 'rxjs';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { ClaudeWorkspaceComponent } from './claude-workspace.component';
import { ClaudeRuntimeApiService } from '@/shared/services/claude-runtime-api.service';
import { ClaudeRuntimeWebsocketService } from '@/shared/services/claude-runtime-websocket.service';
import { ClaudeRuntimeEvent, ClaudeRuntimeState } from '@/shared/models/claude-runtime.model';
import { WorktreeContextService } from '@/shared/services/worktree-context.service';

vi.mock('ngx-sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

describe('ClaudeWorkspaceComponent', () => {
  const runtimeState = (): ClaudeRuntimeState => ({
    sessionId: 7,
    claudeSessionId: 'claude-session-1',
    runPhase: 'idle',
    sessionState: 'idle',
    canInterrupt: false,
    pendingPermissionRequest: null,
    pendingUserInputRequest: null,
    liveItems: [],
    lastError: null,
    selectedModel: null,
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
    disconnect: ReturnType<typeof vi.fn>;
  };
  let worktreeContextServiceMock: {
    get: ReturnType<typeof vi.fn>;
    generate: ReturnType<typeof vi.fn>;
    updateRootRef: ReturnType<typeof vi.fn>;
    consume: ReturnType<typeof vi.fn>;
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
      disconnect: vi.fn(),
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

    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', {
      clipboard: { writeText },
    });

    await fixture.componentInstance.copyMessage({
      id: 'user-1',
      kind: 'user',
      content: 'Copy this',
      timestamp: '2026-04-24T08:00:00.000Z',
      sourceMessageId: 'source-user-1',
    });

    expect(writeText).toHaveBeenCalledWith('Copy this');
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

  it('rewinds conversation and restores the prompt into the composer state', async () => {
    const fixture = TestBed.createComponent(ClaudeWorkspaceComponent);
    fixture.componentInstance.sessionId = 7;
    fixture.detectChanges();

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

  it('clears the composer immediately before worktree context preparation resolves', async () => {
    vi.useFakeTimers();
    worktreeContextServiceMock.consume.mockReturnValue(NEVER);

    const fixture = TestBed.createComponent(ClaudeWorkspaceComponent);
    fixture.componentInstance.sessionId = 7;
    fixture.detectChanges();

    fixture.componentInstance.prompt.set('Ship this change');
    const submitPromise = fixture.componentInstance.submitPrompt('Ship this change');

    expect(fixture.componentInstance.prompt()).toBe('');
    expect(fixture.componentInstance.submitting()).toBe(true);
    expect(fixture.componentInstance.optimisticUserItems()).toEqual([
      expect.objectContaining({ content: 'Ship this change' }),
    ]);
    expect(wsMock.send).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(151);
    await submitPromise;

    expect(wsMock.send).toHaveBeenCalledWith(7, {
      type: 'submit_prompt',
      prompt: 'Ship this change',
    });
    vi.useRealTimers();
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
});
