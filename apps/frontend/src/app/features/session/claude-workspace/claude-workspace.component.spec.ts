import type { ComposerImageAttachment } from '@/shared/agent-chat/composer/claude-composer.component';
import { ComposerDraftService } from '@/shared/agent-chat/composer/composer-draft.service';
import type { ClaudeTranscriptItem } from '@/shared/models/claude-runtime.model';
import { ClaudeRuntimeEvent, ClaudeRuntimeState } from '@/shared/models/claude-runtime.model';
import type { DiffSelectionMention } from '@/shared/models/diff-selection-mention.model';
import type { SessionMention } from '@/shared/models/session-mention.model';
import { AgentRuntimeApiService } from '@/shared/services/agent-runtime-api.service';
import { AppSettingsService } from '@/shared/services/app-settings.service';
import { ClaudeRuntimeApiService } from '@/shared/services/claude-runtime-api.service';
import { ClaudeRuntimeWebsocketService } from '@/shared/services/claude-runtime-websocket.service';
import { ClaudeTerminalTranscriptWebsocketService } from '@/shared/services/claude-terminal-transcript-websocket.service';
import { ConversationForkDraftService } from '@/shared/services/conversation-fork-draft.service';
import { SessionsService } from '@/shared/services/sessions.service';
import { WorktreeContextService } from '@/shared/services/worktree-context.service';
import '@angular/compiler';
import { TestBed } from '@angular/core/testing';
import { toast } from 'ngx-sonner';
import { of, Subject } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ClaudeWorkspaceComponent } from './claude-workspace.component';

vi.mock('ngx-sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

describe('ClaudeWorkspaceComponent', () => {
  const createWorkspace = () => {
    const fixture = TestBed.createComponent(ClaudeWorkspaceComponent);
    fixture.componentRef.setInput('sessionId', 7);
    fixture.componentRef.setInput('repoId', 1);
    fixture.componentRef.setInput('worktreePath', '/tmp/project');
    return fixture;
  };
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
    queuePaused: false,
    liveItems: [],
    lastError: null,
    selectedModel: null,
    reasoningEffort: null,
    fastMode: false,
    permissionMode: null,
    planMode: false,
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
    warmState: 'cold',
    lastWarmedAt: null,
    lastPromptTiming: null,
  });

  let apiMock: {
    getAutocompleteItems: ReturnType<typeof vi.fn>;
    getSubagentHistory: ReturnType<typeof vi.fn>;
    rewindConversation: ReturnType<typeof vi.fn>;
    getRuntimeState: ReturnType<typeof vi.fn>;
    setSelectedModel: ReturnType<typeof vi.fn>;
    setPermissionMode: ReturnType<typeof vi.fn>;
    setPlanMode: ReturnType<typeof vi.fn>;
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
  let terminalTranscriptWsMock: typeof wsMock;
  let worktreeContextServiceMock: {
    get: ReturnType<typeof vi.fn>;
    generate: ReturnType<typeof vi.fn>;
    updateRootRef: ReturnType<typeof vi.fn>;
    consume: ReturnType<typeof vi.fn>;
  };
  let composerDraftsMock: {
    load: ReturnType<typeof vi.fn>;
    save: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
    flush: ReturnType<typeof vi.fn>;
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
    contextEnabled: true,
  });

  const timestampAfter = (start: string, ms: number) =>
    new Date(new Date(start).getTime() + ms).toISOString();

  const linesOf = (count: number) =>
    Array.from({ length: count }, (_, i) => `line-${i}`).join('\n');

  const image = (overrides: Partial<ComposerImageAttachment> = {}): ComposerImageAttachment => ({
    id: 'img-1',
    name: 'screen.png',
    mediaType: 'image/png',
    dataUrl: 'data:image/png;base64,abc',
    size: 3,
    ...overrides,
  });

  type EditCall = {
    tool: 'Edit' | 'Write' | 'MultiEdit';
    file: string;
    oldString?: string;
    newString?: string;
    content?: string;
    edits?: { old_string: string; new_string: string }[];
    isError?: boolean;
  };

  const editTurnHistory = (suffix: string, start: string, calls: EditCall[]) => {
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
    vi.clearAllMocks();
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
      setPlanMode: vi.fn(() => of(runtimeState())),
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
    terminalTranscriptWsMock = {
      connect: vi.fn(() => new Subject().asObservable()),
      send: vi.fn(),
      isConnected: vi.fn(() => true),
      disconnect: vi.fn(),
      connectionState$: vi.fn(() => new Subject().asObservable()),
    };
    worktreeContextServiceMock = {
      get: vi.fn(() =>
        of({
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
        }),
      ),
      generate: vi.fn(() =>
        of({
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
        }),
      ),
      updateRootRef: vi.fn(() => of({})),
      consume: vi.fn(() => of({ shouldInject: false, contextSentence: null })),
    };
    composerDraftsMock = {
      load: vi.fn(() => Promise.resolve(null)),
      save: vi.fn(),
      delete: vi.fn(),
      flush: vi.fn(() => Promise.resolve()),
    };
    await TestBed.configureTestingModule({
      imports: [ClaudeWorkspaceComponent],
      providers: [
        { provide: ClaudeRuntimeApiService, useValue: apiMock },
        { provide: ClaudeRuntimeWebsocketService, useValue: wsMock },
        { provide: ClaudeTerminalTranscriptWebsocketService, useValue: terminalTranscriptWsMock },
        { provide: WorktreeContextService, useValue: worktreeContextServiceMock },
        { provide: ComposerDraftService, useValue: composerDraftsMock },
        {
          provide: SessionsService,
          useValue: {
            updateActiveAgentProvider: vi.fn(() => of({})),
            getForks: vi.fn(() => of([])),
            createFork: vi.fn(() => of({})),
          },
        },
      ],
    }).compileComponents();
  });

  it('keeps independent workspace services and drafts for mounted session tabs', () => {
    const first = createWorkspace();
    const second = createWorkspace();
    second.componentRef.setInput('sessionId', 8);
    first.componentInstance.draft.onPromptChange('First tab');
    second.componentInstance.draft.onPromptChange('Second tab');

    expect(first.componentInstance.runtime).not.toBe(second.componentInstance.runtime);
    expect(first.componentInstance.actions).not.toBe(second.componentInstance.actions);
    expect(first.componentInstance.draft.prompt()).toBe('First tab');
    expect(second.componentInstance.draft.prompt()).toBe('Second tab');
  });

  it('ignores a late mention and keeps the new session mention request intact', async () => {
    const fixture = createWorkspace();
    fixture.detectChanges();
    const agentApi = TestBed.inject(AgentRuntimeApiService);
    const oldResponse = new Subject<SessionMention>();
    const newResponse = new Subject<SessionMention>();
    vi.spyOn(agentApi, 'getConversationMention')
      .mockReturnValueOnce(oldResponse)
      .mockReturnValueOnce(newResponse);
    const draft = fixture.componentInstance.draft;
    const oldRequest = draft.addSessionMention(12);
    fixture.componentRef.setInput('sessionId', 8);
    fixture.detectChanges();
    const newRequest = draft.addSessionMention(12);
    const mention: SessionMention = {
      sessionId: 12,
      title: 'Mentioned session',
      provider: 'codex',
      providerSessionId: null,
      branch: 'main',
      status: 'idle',
      transcriptExportPath: '/tmp/context.md',
      contextMarkdown: 'Context',
      omittedTurns: 0,
      generatedAt: '2026-10-01T12:00:00Z',
    };
    oldResponse.next(mention);
    await oldRequest;
    expect(draft.pendingSessionMentions()).toEqual([]);
    expect(draft.loadingSessionMentionId()).toBe(12);
    newResponse.next(mention);
    await newRequest;
    expect(draft.pendingSessionMentions()).toEqual([mention]);
    expect(composerDraftsMock.save).toHaveBeenLastCalledWith(
      expect.objectContaining({ sessionId: 8, sessionMentions: [mention] }),
    );
  });

  it('does not attach a pending mention to the next draft after submission', async () => {
    const fixture = createWorkspace();
    const response = new Subject<SessionMention>();
    vi.spyOn(TestBed.inject(AgentRuntimeApiService), 'getConversationMention').mockReturnValue(
      response,
    );
    const draft = fixture.componentInstance.draft;
    const pending = draft.addSessionMention(12);
    await draft.submitPrompt('Send the current draft');
    response.next({ sessionId: 12 } as SessionMention);
    await pending;
    expect(draft.pendingSessionMentions()).toEqual([]);
    expect(draft.loadingSessionMentionId()).toBeNull();
  });

  it('keeps settled plan and empty fork lookup identities stable', () => {
    const fixture = createWorkspace();
    const component = fixture.componentInstance;
    component.runtime.currentProvider.set('codex');
    const item: ClaudeTranscriptItem = {
      id: 'plan-message',
      sourceMessageId: 'plan-source',
      kind: 'assistant',
      content: '<proposed_plan>Implement the feature.</proposed_plan>',
      timestamp: '2026-10-01T12:00:00Z',
    };
    component.runtime.conversation.history.set([item]);
    const firstPlan = component.actions.planReviewForMessage(item);
    expect(firstPlan).not.toBeNull();
    expect(component.actions.planReviewForMessage(item)).toBe(firstPlan);
    expect(component.actions.forksForItem(item)).toBe(component.actions.forksForItem(item));
  });

  it('clears review discussions when switching to a read-only conversation', () => {
    const fixture = createWorkspace();
    fixture.detectChanges();
    const actions = fixture.componentInstance.actions;
    actions.reviewThreads.set([
      {
        id: 7,
        parentSessionId: 42,
        childSessionId: 43,
        provider: 'claude',
        title: 'Review this change',
        mode: 'readonly',
        status: 'open',
        scope: 'worktree',
        filePath: null,
        anchors: [],
        changeHash: null,
        fingerprint: null,
        anchorMessageId: 'assistant-1',
        anchorMessageKind: 'assistant',
        turnKey: 'turn-1',
        promotedForkId: null,
        lastReadAt: null,
        createdAt: '2026-04-24T08:00:00.000Z',
        updatedAt: '2026-04-24T08:00:00.000Z',
      },
    ]);
    actions.unreadReviewThreadIds.set(new Set([7]));
    expect(actions.turnReviews().threads['turn-1']).toHaveLength(1);

    fixture.componentRef.setInput('sessionId', 44);
    fixture.componentRef.setInput('readOnlyTranscript', true);
    fixture.detectChanges();

    expect(actions.turnReviews().threads).toEqual({});
    expect(actions.turnReviews().unreadIds.size).toBe(0);
  });

  it('keeps reconnect monitoring attached after consecutive reconnects', () => {
    const connection = new Subject<'connected' | 'disconnected' | 'connecting'>();
    wsMock.connectionState$.mockReturnValue(connection);
    const fixture = createWorkspace();
    fixture.detectChanges();
    fixture.componentInstance.runtime.hydrated.set(true);
    connection.next('disconnected');
    expect(wsMock.connect).toHaveBeenCalledTimes(2);
    connection.next('connected');
    connection.next('disconnected');
    expect(wsMock.connect).toHaveBeenCalledTimes(3);
  });

  it('ignores a settings response from a previous conversation', async () => {
    const response = new Subject<ClaudeRuntimeState>();
    apiMock.setSelectedModel.mockReturnValue(response);
    const fixture = createWorkspace();
    const component = fixture.componentInstance;
    fixture.componentRef.setInput('sessionId', 7);
    const update = component.runtime.onModelChange('old-model');
    component.runtime.reset();
    response.next({ ...runtimeState(), selectedModel: 'old-model' });
    await update;
    expect(component.runtime.selectedModel()).toBeNull();
  });

  it('reports settings failures without an unhandled rejection', async () => {
    const response = new Subject<ClaudeRuntimeState>();
    apiMock.setSelectedModel.mockReturnValue(response);
    const fixture = createWorkspace();
    const update = fixture.componentInstance.runtime.onModelChange('model');
    response.error(new Error('Unavailable model'));
    await update;
    expect(toast.error).toHaveBeenCalledWith('Unavailable model');
  });

  it('shows model presets as one-click choices in a new empty session', () => {
    const settings = TestBed.inject(AppSettingsService);
    const fixture = createWorkspace();
    (settings as unknown as { settingsState: { set(value: unknown): void } }).settingsState.set({
      ...settings.settings(),
      agentModelPresets: [
        {
          id: 'fast-fixes',
          name: 'Fast fixes',
          provider: 'codex',
          model: 'gpt-5-mini',
          reasoningEffort: 'low',
        },
      ],
    });
    fixture.componentInstance.runtime.loading.set(false);
    fixture.componentInstance.runtime.hydrated.set(true);
    fixture.detectChanges();

    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('Start with a preset');
    expect(text).toContain('Fast fixes');
    expect(text).toContain('Codex · gpt-5-mini · Low');
  });

  it('keeps the transcript skeleton visible until asynchronously loaded history arrives', () => {
    const events$ = new Subject<ClaudeRuntimeEvent>();
    wsMock.connect.mockReturnValue(events$.asObservable());
    const fixture = createWorkspace();
    fixture.componentRef.setInput('activeAgentProvider', 'codex');
    fixture.detectChanges();

    events$.next({ type: 'runtime_snapshot', payload: runtimeState() });
    fixture.detectChanges();

    const element = fixture.nativeElement as HTMLElement;
    expect(element.querySelector('cw-transcript-loading-skeleton')).not.toBeNull();
    expect(element.textContent).not.toContain('Start with a prompt.');

    events$.next({
      type: 'history_snapshot',
      payload: { sessionId: 7, history: [] },
    });
    fixture.detectChanges();

    expect(element.querySelector('cw-transcript-loading-skeleton')).toBeNull();
    expect(element.textContent).toContain('Start with a prompt.');
  });

  it('shows history before a slow runtime snapshot arrives', () => {
    const events$ = new Subject<ClaudeRuntimeEvent>();
    wsMock.connect.mockReturnValue(events$.asObservable());
    const fixture = createWorkspace();
    fixture.detectChanges();
    events$.next({
      type: 'history_snapshot',
      payload: { sessionId: 7, history: [{
        id: 'saved-reply', kind: 'assistant', content: 'Previously saved reply',
        timestamp: '2026-01-01T00:00:00.000Z',
      }] },
    });
    fixture.detectChanges();
    const element = fixture.nativeElement as HTMLElement;
    expect(element.querySelector('cw-transcript-loading-skeleton')).toBeNull();
    expect(element.textContent).toContain('Previously saved reply');
    events$.next({ type: 'runtime_snapshot', payload: runtimeState() });
    fixture.detectChanges();
    expect(element.querySelector('cw-transcript-loading-skeleton')).toBeNull();
    expect(element.textContent).toContain('Previously saved reply');
  });

  it('renders HTTP history while the WebSocket is still connecting', () => {
    const history$ = new Subject<ClaudeTranscriptItem[]>();
    const api = TestBed.inject(AgentRuntimeApiService);
    const getHistory = vi.spyOn(api, 'getHistory').mockReturnValue(history$);
    wsMock.connectionState$.mockReturnValue(of('connecting'));
    const fixture = createWorkspace();
    fixture.detectChanges();
    expect(getHistory).toHaveBeenCalledWith(7, 'claude');
    expect(fixture.nativeElement.querySelector('cw-transcript-loading-skeleton')).not.toBeNull();
    history$.next([{
      id: 'saved', kind: 'assistant', content: 'Loaded without the socket',
      timestamp: '2026-01-01T00:00:00.000Z',
    }]);
    fixture.detectChanges();
    expect(fixture.componentInstance.runtime.wsConnected()).toBe(false);
    expect(fixture.nativeElement.querySelector('cw-transcript-loading-skeleton')).toBeNull();
    expect(fixture.nativeElement.textContent).toContain('Loaded without the socket');
  });

  it('cancels an initial HTTP history read when a socket snapshot wins the race', () => {
    const history$ = new Subject<ClaudeTranscriptItem[]>();
    const events$ = new Subject<ClaudeRuntimeEvent>();
    vi.spyOn(TestBed.inject(AgentRuntimeApiService), 'getHistory').mockReturnValue(history$);
    wsMock.connect.mockReturnValue(events$);
    const fixture = createWorkspace();
    fixture.detectChanges();
    expect(history$.observed).toBe(true);
    events$.next({ type: 'history_snapshot', payload: { sessionId: 7, history: [] } });
    expect(history$.observed).toBe(false);
    expect(fixture.componentInstance.runtime.showLoading()).toBe(false);
  });

  it('cancels initial history when changing sessions or rewinding', () => {
    const old$ = new Subject<ClaudeTranscriptItem[]>();
    const current$ = new Subject<ClaudeTranscriptItem[]>();
    vi.spyOn(TestBed.inject(AgentRuntimeApiService), 'getHistory')
      .mockReturnValueOnce(old$).mockReturnValueOnce(current$);
    const fixture = createWorkspace();
    fixture.detectChanges();
    fixture.componentRef.setInput('sessionId', 8);
    fixture.detectChanges();
    expect(old$.observed).toBe(false);
    expect(current$.observed).toBe(true);
    fixture.componentInstance.runtime.beginConversationRewind();
    expect(current$.observed).toBe(false);
  });

  it('falls back to socket history if the initial HTTP read fails', () => {
    const history$ = new Subject<ClaudeTranscriptItem[]>();
    const events$ = new Subject<ClaudeRuntimeEvent>();
    vi.spyOn(TestBed.inject(AgentRuntimeApiService), 'getHistory').mockReturnValue(history$);
    wsMock.connect.mockReturnValue(events$);
    const fixture = createWorkspace();
    fixture.detectChanges();
    history$.error(new Error('HTTP unavailable'));
    expect(wsMock.send).toHaveBeenLastCalledWith(7, { type: 'hydrate' });
    expect(fixture.componentInstance.runtime.showLoading()).toBe(true);
    events$.next({ type: 'history_snapshot', payload: { sessionId: 7, history: [] } });
    expect(fixture.componentInstance.runtime.showLoading()).toBe(false);
  });

  it('refreshes autocomplete after session metadata arrives', async () => {
    const events$ = new Subject<ClaudeRuntimeEvent>();
    wsMock.connect.mockReturnValue(events$.asObservable());
    apiMock.getAutocompleteItems
      .mockReturnValueOnce(
        of([
          {
            id: 'builtin:/help',
            kind: 'command',
            trigger: '/',
            label: '/help',
            insertText: '/help ',
            description: 'Help',
            source: 'builtin',
          },
        ]),
      )
      .mockReturnValueOnce(
        of([
          {
            id: 'runtime:/myskill',
            kind: 'skill',
            trigger: '/',
            label: '/myskill',
            insertText: '/myskill ',
            description: 'Runtime skill',
            source: 'runtime',
          },
        ]),
      );

    const fixture = createWorkspace();
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
    expect(fixture.componentInstance.runtime.autocompleteItems()).toEqual([
      expect.objectContaining({ label: '/myskill', source: 'runtime' }),
    ]);
  });

  it('renders terminal mirror transcripts without input or mutating actions', async () => {
    const events$ = new Subject<ClaudeRuntimeEvent>();
    terminalTranscriptWsMock.connect.mockReturnValue(events$.asObservable());
    const fixture = createWorkspace();
    fixture.componentRef.setInput('readOnlyTranscript', true);
    fixture.componentRef.setInput('terminalTranscriptMirror', true);
    fixture.detectChanges();

    events$.next({ type: 'runtime_snapshot', payload: runtimeState() });
    events$.next({
      type: 'history_snapshot',
      payload: {
        sessionId: 7,
        history: [
          {
            id: 'user-1',
            kind: 'user',
            content: 'Terminal prompt',
            timestamp: '2026-04-24T08:00:00.000Z',
            sourceMessageId: 'source-user-1',
            transcriptMessageId: 'source-user-1',
          },
          {
            id: 'assistant-1',
            kind: 'assistant',
            content: 'Terminal response',
            timestamp: '2026-04-24T08:00:01.000Z',
            sourceMessageId: 'assistant-source-1',
            transcriptMessageId: 'assistant-source-1',
          },
        ],
      },
    });
    fixture.detectChanges();
    await flushPromises();

    const el = fixture.nativeElement as HTMLElement;
    expect(terminalTranscriptWsMock.send).toHaveBeenCalledWith(7, { type: 'hydrate' });
    expect(wsMock.send).not.toHaveBeenCalled();
    expect(el.querySelector('cw-composer')).toBeNull();
    expect(el.querySelector('cw-status-bar')).toBeNull();
    expect(
      fixture.componentInstance.actions.canEditMessage(
        fixture.componentInstance.runtime.historyItems()[0],
      ),
    ).toBe(false);
    expect(
      fixture.componentInstance.actions.canForkMessage(
        fixture.componentInstance.runtime.historyItems()[1],
      ),
    ).toBe(false);

    await fixture.componentInstance.draft.submitPrompt('should not send');
    expect(terminalTranscriptWsMock.send).toHaveBeenCalledTimes(1);
  });

  it('hydrates and stays connected while its tab is in the background', () => {
    const fixture = createWorkspace();
    fixture.componentRef.setInput('isVisible', false);
    fixture.detectChanges();

    expect(wsMock.connect).toHaveBeenCalledWith(7);
    expect(wsMock.send).toHaveBeenCalledWith(7, { type: 'hydrate', includeHistory: false });
  });

  it('restores saved composer drafts with text, diff mentions, and images', async () => {
    const diffMention = {
      id: 'mention-1',
      version: 1,
      scope: 'branch',
      compareLabel: 'feature vs main',
      baseSha: 'base',
      headSha: 'head',
      filePath: 'src/app.ts',
      oldPath: null,
      status: 'modified',
      changeHash: 'hash',
      oldLineStart: 1,
      oldLineEnd: 1,
      newLineStart: 2,
      newLineEnd: 2,
      selectedText: 'const value = true;',
      context: { before: [], selected: [], after: [] },
      truncated: false,
    } as DiffSelectionMention;
    const attachedImage = image();
    composerDraftsMock.load.mockResolvedValueOnce({
      version: 1,
      sessionId: 7,
      text: 'Saved prompt',
      diffMentions: [diffMention],
      images: [attachedImage],
      updatedAt: '2026-04-24T08:00:00.000Z',
    });

    const fixture = createWorkspace();
    fixture.detectChanges();
    await flushPromises();

    expect(composerDraftsMock.load).toHaveBeenCalledWith(7);
    expect(fixture.componentInstance.draft.prompt()).toBe('Saved prompt');
    expect(fixture.componentInstance.draft.pendingDiffMentions()).toEqual([diffMention]);
    expect(fixture.componentInstance.draft.composerImages()).toEqual([attachedImage]);
  });

  it('clears the saved composer draft after accepting a prompt', async () => {
    const fixture = createWorkspace();
    fixture.detectChanges();
    await flushPromises();

    fixture.componentInstance.draft.prompt.set('Ship this change');
    fixture.componentInstance.draft.composerImages.set([image()]);
    await fixture.componentInstance.draft.submitPrompt('Ship this change');

    expect(fixture.componentInstance.draft.prompt()).toBe('');
    expect(fixture.componentInstance.draft.composerImages()).toEqual([]);
    expect(composerDraftsMock.delete).toHaveBeenCalledWith(7);
  });

  it('gives pending fork drafts priority over saved composer drafts', async () => {
    const forkDrafts = TestBed.inject(ConversationForkDraftService);
    forkDrafts.setDraft(7, 'Fork draft');
    composerDraftsMock.load.mockResolvedValueOnce({
      version: 1,
      sessionId: 7,
      text: 'Saved prompt',
      diffMentions: [],
      images: [image()],
      updatedAt: '2026-04-24T08:00:00.000Z',
    });

    const fixture = createWorkspace();
    fixture.detectChanges();
    await flushPromises();

    expect(composerDraftsMock.load).not.toHaveBeenCalled();
    expect(fixture.componentInstance.draft.prompt()).toBe('Fork draft');
    expect(fixture.componentInstance.draft.composerImages()).toEqual([]);
    expect(composerDraftsMock.save).toHaveBeenCalledWith({
      sessionId: 7,
      text: 'Fork draft',
      diffMentions: [],
      sessionMentions: [],
      images: [],
    });
  });

  it('does not let async draft restore overwrite newly typed input', async () => {
    let resolveDraft: (value: {
      version: 1;
      sessionId: number;
      text: string;
      diffMentions: [];
      images: [];
      updatedAt: string;
    }) => void = () => undefined;
    composerDraftsMock.load.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveDraft = resolve;
      }),
    );

    const fixture = createWorkspace();
    fixture.detectChanges();
    fixture.componentInstance.draft.onPromptChange('Fresh input');

    resolveDraft({
      version: 1,
      sessionId: 7,
      text: 'Older saved draft',
      diffMentions: [],
      images: [],
      updatedAt: '2026-04-24T08:00:00.000Z',
    });
    await flushPromises();

    expect(fixture.componentInstance.draft.prompt()).toBe('Fresh input');
    expect(composerDraftsMock.save).toHaveBeenCalledWith({
      sessionId: 7,
      text: 'Fresh input',
      diffMentions: [],
      sessionMentions: [],
      images: [],
    });
  });

  it('preserves composer input when switching providers', async () => {
    const savedPrompt = 'Typed before switch';
    composerDraftsMock.load.mockResolvedValueOnce(null).mockResolvedValueOnce({
      version: 1,
      sessionId: 7,
      text: savedPrompt,
      diffMentions: [],
      images: [],
      updatedAt: '2026-04-24T08:00:00.000Z',
    });

    const fixture = createWorkspace();
    fixture.componentRef.setInput('hasStartedAgentRuntime', false);
    fixture.detectChanges();
    await flushPromises();

    fixture.componentInstance.draft.onPromptChange(savedPrompt);
    await flushPromises();

    fixture.componentInstance.runtime.onProviderChange('codex');
    await flushPromises();

    expect(fixture.componentInstance.runtime.currentProvider()).toBe('codex');
    expect(fixture.componentInstance.draft.prompt()).toBe(savedPrompt);
    expect(composerDraftsMock.load).toHaveBeenCalledTimes(2);
    expect(composerDraftsMock.load).toHaveBeenLastCalledWith(7);
    expect(fixture.componentInstance.runtime.runtimeStarted()).toBe(false);
  });

  it('preserves composer input when applying a preset for another provider', async () => {
    const savedPrompt = 'Typed before applying preset';
    composerDraftsMock.load.mockResolvedValueOnce(null).mockResolvedValueOnce({
      version: 1,
      sessionId: 7,
      text: savedPrompt,
      diffMentions: [],
      images: [],
      updatedAt: '2026-04-24T08:00:00.000Z',
    });
    const agentApi = TestBed.inject(AgentRuntimeApiService);
    vi.spyOn(agentApi, 'setSelectedModel').mockReturnValue(of(runtimeState()));
    vi.spyOn(agentApi, 'setReasoningEffort').mockReturnValue(of(runtimeState()));

    const fixture = createWorkspace();
    fixture.componentRef.setInput('hasStartedAgentRuntime', false);
    fixture.detectChanges();
    await flushPromises();

    fixture.componentInstance.draft.onPromptChange(savedPrompt);
    await fixture.componentInstance.runtime.applyModelPreset({
      id: 'fast-fixes',
      name: 'Fast fixes',
      provider: 'codex',
      model: 'gpt-5-mini',
      reasoningEffort: 'low',
    });
    await flushPromises();

    expect(fixture.componentInstance.runtime.currentProvider()).toBe('codex');
    expect(fixture.componentInstance.draft.prompt()).toBe(savedPrompt);
    expect(composerDraftsMock.load).toHaveBeenCalledTimes(2);
    expect(composerDraftsMock.load).toHaveBeenLastCalledWith(7);
  });

  it('applies and clears fast mode when switching presets', async () => {
    const agentApi = TestBed.inject(AgentRuntimeApiService);
    const selected = { ...runtimeState(), claudeSessionId: null, selectedModel: 'opus', reasoningEffort: 'high', availableModels: [{ id: 'opus', displayName: 'Opus', description: '', supportsFastMode: true }] };
    vi.spyOn(agentApi, 'setSelectedModel').mockReturnValue(of(selected));
    const effort = vi.spyOn(agentApi, 'setReasoningEffort').mockReturnValue(of(selected));
    const fast = vi.spyOn(agentApi, 'setFastMode').mockReturnValue(of({ ...selected, fastMode: true }));
    const fixture = createWorkspace();
    fixture.componentRef.setInput('hasStartedAgentRuntime', false);
    fixture.detectChanges();
    await flushPromises();
    const preset = { id: 'fast', name: 'Fast', provider: 'claude', model: 'opus', reasoningEffort: 'high', fastMode: true };
    await fixture.componentInstance.runtime.applyModelPreset(preset);
    expect(fast).toHaveBeenCalledWith(7, true, 'claude');
    expect(fixture.componentInstance.runtime.isModelPresetSelected(preset)).toBe(true);
    effort.mockReturnValue(of({ ...selected, fastMode: true }));
    fast.mockReturnValue(of(selected));
    await fixture.componentInstance.runtime.applyModelPreset({ ...preset, fastMode: false });
    expect(fast).toHaveBeenLastCalledWith(7, false, 'claude');
    expect(fixture.componentInstance.runtime.fastMode()).toBe(false);
  });

  it('copies message content to the clipboard', async () => {
    const fixture = createWorkspace();
    fixture.detectChanges();
    fixture.componentInstance.runtime.loading.set(false);

    const writeText = vi.fn().mockResolvedValue(undefined);
    stubClipboard(writeText);

    await fixture.componentInstance.actions.copyMessage({
      id: 'user-1',
      kind: 'user',
      content: 'Copy this',
      timestamp: '2026-04-24T08:00:00.000Z',
      sourceMessageId: 'source-user-1',
    });

    expect(writeText).toHaveBeenCalledWith('Copy this');
  });

  it('copies selected message text when provided', async () => {
    const fixture = createWorkspace();
    fixture.detectChanges();
    fixture.componentInstance.runtime.loading.set(false);

    const writeText = vi.fn().mockResolvedValue(undefined);
    stubClipboard(writeText);

    await fixture.componentInstance.actions.copyMessage(
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
    const fixture = createWorkspace();
    fixture.detectChanges();
    fixture.componentInstance.runtime.loading.set(false);

    const writeText = vi.fn().mockResolvedValue(undefined);
    stubClipboard(writeText);

    await fixture.componentInstance.actions.copyMessage(
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

  it('creates a conversation fork from a persisted transcript anchor', async () => {
    const sessions = TestBed.inject(SessionsService) as unknown as {
      createFork: ReturnType<typeof vi.fn>;
    };
    const fixture = createWorkspace();
    fixture.detectChanges();
    fixture.componentInstance.runtime.loading.set(false);
    fixture.componentInstance.runtime.hydrated.set(true);
    sessions.createFork.mockReturnValueOnce(
      of({
        fork: {
          id: 1,
          parentSessionId: 7,
          childSessionId: 8,
          provider: 'claude',
          anchorMessageId: 'assistant-wrapper-1',
          anchorMessageKind: 'assistant',
          anchorExcerpt: 'Done',
          draft: null,
          createdAt: '2026-04-24T08:00:00.000Z',
          childSession: {
            id: 8,
            repoId: 1,
            projectId: 1,
            branchName: 'main',
            worktreePath: '/tmp/project',
            name: 'Parent (fork)',
            status: 'created',
            activeAgentProvider: 'claude',
            claudeSessionId: 'forked-claude',
            codexSessionId: '-1',
            piSessionPath: '-1',
            hasInjectedWorktreeContext: false,
            hasUnreviewedCompletion: false,
            lastCompletionAt: null,
            lastCompletionKind: null,
            lastStateChangeAt: null,
            createdAt: '2026-04-24T08:00:00.000Z',
            updatedAt: '2026-04-24T08:00:00.000Z',
          },
        },
        session: {
          id: 8,
          repoId: 1,
          projectId: 1,
          branchName: 'main',
          worktreePath: '/tmp/project',
          name: 'Parent (fork)',
          status: 'created',
          activeAgentProvider: 'claude',
          claudeSessionId: 'forked-claude',
          codexSessionId: '-1',
          piSessionPath: '-1',
          hasInjectedWorktreeContext: false,
          hasUnreviewedCompletion: false,
          lastCompletionAt: null,
          lastCompletionKind: null,
          lastStateChangeAt: null,
          createdAt: '2026-04-24T08:00:00.000Z',
          updatedAt: '2026-04-24T08:00:00.000Z',
        },
        draft: null,
      }),
    );
    const emitted: unknown[] = [];
    fixture.componentInstance.conversationForkCreated.subscribe((event) => emitted.push(event));

    await fixture.componentInstance.actions.forkMessage({
      id: 'assistant-1',
      kind: 'assistant',
      content: 'Done',
      transcriptMessageId: 'assistant-wrapper-1',
      timestamp: '2026-04-24T08:00:00.000Z',
    });

    expect(sessions.createFork).toHaveBeenCalledWith(7, {
      anchorMessageId: 'assistant-wrapper-1',
      anchorMessageKind: 'assistant',
      anchorExcerpt: 'Done',
    });
    expect(
      fixture.componentInstance.actions.forksForItem({
        id: 'assistant-1',
        kind: 'assistant',
        content: 'Done',
        transcriptMessageId: 'assistant-wrapper-1',
        timestamp: '2026-04-24T08:00:00.000Z',
      }),
    ).toHaveLength(1);
    expect(emitted).toHaveLength(1);
  });

  it('creates a fork while the runtime is active', async () => {
    const sessions = TestBed.inject(SessionsService) as unknown as {
      createFork: ReturnType<typeof vi.fn>;
    };
    sessions.createFork.mockReturnValueOnce(
      of({
        fork: {
          id: 1,
          parentSessionId: 7,
          childSessionId: 8,
          anchorMessageId: 'assistant-wrapper-1',
          anchorMessageKind: 'assistant',
          anchorExcerpt: 'Done',
          createdAt: '2026-04-24T08:00:00.000Z',
          childSession: null,
        },
        session: {
          id: 8,
          repoId: 1,
          name: 'Parent (fork)',
          branchName: 'main',
          worktreePath: '/tmp/project',
          status: 'created',
          claudeSessionId: 'forked-claude',
          provider: 'claude',
          hasUnreadChanges: false,
          hasUnreviewedCompletion: false,
          lastCompletionAt: null,
          lastCompletionKind: null,
          lastStateChangeAt: null,
          createdAt: '2026-04-24T08:00:00.000Z',
          updatedAt: '2026-04-24T08:00:00.000Z',
        },
        draft: null,
      }),
    );
    const fixture = createWorkspace();
    fixture.detectChanges();
    fixture.componentInstance.runtime.loading.set(false);
    fixture.componentInstance.runtime.hydrated.set(true);
    fixture.componentInstance.runtime.conversation.runPhase.set('running');

    await fixture.componentInstance.actions.forkMessage({
      id: 'assistant-1',
      kind: 'assistant',
      content: 'Done',
      transcriptMessageId: 'assistant-wrapper-1',
      timestamp: '2026-04-24T08:00:00.000Z',
    });

    expect(sessions.createFork).toHaveBeenCalledWith(7, {
      anchorMessageId: 'assistant-wrapper-1',
      anchorMessageKind: 'assistant',
      anchorExcerpt: 'Done',
    });
  });

  it('shows the waiting caret while Claude is still thinking', async () => {
    const fixture = createWorkspace();
    fixture.detectChanges();

    fixture.componentInstance.runtime.loading.set(false);
    fixture.componentInstance.runtime.hydrated.set(true);
    fixture.componentInstance.runtime.conversation.runPhase.set('running');
    fixture.componentInstance.runtime.conversation.live.set([
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
    const fixture = createWorkspace();
    fixture.detectChanges();

    fixture.componentInstance.runtime.loading.set(false);
    fixture.componentInstance.runtime.hydrated.set(true);
    fixture.componentInstance.runtime.conversation.runPhase.set('waiting');
    fixture.componentInstance.runtime.conversation.history.set([
      {
        id: 'thinking-1',
        kind: 'thinking',
        content: 'Planning the next step',
        timestamp: '2026-04-24T08:00:01.000Z',
        receivedAt: '2026-04-24T08:00:01.000Z',
      },
    ]);
    fixture.componentInstance.runtime.conversation.live.set([]);
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.cw-caret--waiting')).not.toBeNull();
  });

  it('keeps transcript auto-scroll pinned while the user is at the bottom', async () => {
    const fixture = createWorkspace();
    fixture.detectChanges();
    fixture.componentInstance.runtime.loading.set(false);
    fixture.componentInstance.runtime.hydrated.set(true);
    fixture.detectChanges();
    await flushPromises();

    const transcript = fixture.nativeElement.querySelector('.cw-transcript') as HTMLElement;
    setScrollMetrics(transcript, { scrollTop: 800, scrollHeight: 1000, clientHeight: 200 });
    transcript.dispatchEvent(new Event('scroll'));

    setScrollMetrics(transcript, { scrollTop: 800, scrollHeight: 1200, clientHeight: 200 });
    fixture.componentInstance.runtime.conversation.history.set([
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
    const fixture = createWorkspace();
    fixture.detectChanges();
    fixture.componentInstance.runtime.loading.set(false);
    fixture.componentInstance.runtime.hydrated.set(true);
    fixture.componentInstance.runtime.conversation.history.set([
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
    fixture.componentInstance.runtime.conversation.history.set([
      ...fixture.componentInstance.runtime.historyItems(),
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
    const fixture = createWorkspace();
    fixture.detectChanges();
    fixture.componentInstance.runtime.loading.set(false);
    fixture.componentInstance.runtime.hydrated.set(true);
    fixture.componentInstance.runtime.conversation.history.set([
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
    fixture.componentInstance.runtime.conversation.history.set([
      ...fixture.componentInstance.runtime.historyItems(),
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

  it('pins the prompt that belongs to the response currently in view', async () => {
    const fixture = createWorkspace();
    fixture.detectChanges();
    fixture.componentInstance.runtime.loading.set(false);
    fixture.componentInstance.runtime.hydrated.set(true);
    fixture.componentInstance.runtime.conversation.history.set([
      {
        id: 'user-1',
        kind: 'user',
        content: 'Keep this prompt in view',
        timestamp: '2026-04-24T08:00:00.000Z',
      },
      {
        id: 'assistant-1',
        kind: 'assistant',
        content: 'The first long response',
        timestamp: '2026-04-24T08:00:01.000Z',
      },
      {
        id: 'user-2',
        kind: 'user',
        content: 'A newer prompt below the viewport',
        timestamp: '2026-04-24T08:00:02.000Z',
      },
      {
        id: 'assistant-2',
        kind: 'assistant',
        content: 'The second response',
        timestamp: '2026-04-24T08:00:03.000Z',
      },
      {
        id: 'task-notification',
        kind: 'user',
        content:
          '<task-notification><task-id>task-1</task-id><status>completed</status><summary>Background work completed</summary></task-notification>',
        timestamp: '2026-04-24T08:00:04.000Z',
      },
    ]);
    fixture.detectChanges();
    await flushPromises();

    const transcript = fixture.nativeElement.querySelector('.cw-transcript') as HTMLElement;
    const [firstPrompt, secondPrompt] = fixture.nativeElement.querySelectorAll(
      '[data-user-prompt-id]',
    ) as NodeListOf<HTMLElement>;
    expect(fixture.nativeElement.querySelectorAll('[data-user-prompt-id]')).toHaveLength(2);
    vi.spyOn(transcript, 'getBoundingClientRect').mockReturnValue({
      top: 100,
    } as DOMRect);
    const firstRect = vi.spyOn(firstPrompt, 'getBoundingClientRect');
    const secondRect = vi.spyOn(secondPrompt, 'getBoundingClientRect');

    firstRect.mockReturnValue({ top: -40, bottom: 80 } as DOMRect);
    secondRect.mockReturnValue({ top: 500, bottom: 540 } as DOMRect);
    transcript.dispatchEvent(new Event('scroll'));
    fixture.detectChanges();

    const pinned = fixture.nativeElement.querySelector('.cw-contextual-prompt') as HTMLElement;
    expect(pinned.textContent).toContain('Keep this prompt in view');
    expect(pinned.textContent).not.toContain('A newer prompt below the viewport');
    expect(pinned.textContent).not.toContain('Latest prompt');
    expect(pinned.textContent).not.toContain('Show in conversation');
    expect(
      pinned.querySelector('[aria-label="Jump to this prompt in the conversation"]'),
    ).not.toBeNull();

    firstRect.mockReturnValue({ top: 110, bottom: 140 } as DOMRect);
    transcript.dispatchEvent(new Event('scroll'));
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.cw-contextual-prompt')).toBeNull();

    firstRect.mockReturnValue({ top: -500, bottom: -460 } as DOMRect);
    secondRect.mockReturnValue({ top: 60, bottom: 80 } as DOMRect);
    transcript.dispatchEvent(new Event('scroll'));
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.cw-contextual-prompt').textContent).toContain(
      'A newer prompt below the viewport',
    );
  });

  it('clamps very long contextual prompts without taking over the transcript', async () => {
    const fixture = createWorkspace();
    fixture.detectChanges();
    fixture.componentInstance.runtime.loading.set(false);
    fixture.componentInstance.runtime.hydrated.set(true);
    fixture.componentInstance.runtime.conversation.history.set([
      {
        id: 'user-long',
        kind: 'user',
        content: linesOf(200),
        timestamp: '2026-04-24T08:00:00.000Z',
      },
    ]);
    fixture.detectChanges();
    await flushPromises();

    const transcript = fixture.nativeElement.querySelector('.cw-transcript') as HTMLElement;
    const source = fixture.nativeElement.querySelector('[data-user-prompt-id]') as HTMLElement;
    vi.spyOn(transcript, 'getBoundingClientRect').mockReturnValue({ top: 100 } as DOMRect);
    vi.spyOn(source, 'getBoundingClientRect').mockReturnValue({
      top: -400,
      bottom: 80,
    } as DOMRect);
    transcript.dispatchEvent(new Event('scroll'));
    fixture.detectChanges();

    const text = fixture.nativeElement.querySelector('.cw-contextual-prompt__text') as HTMLElement;
    expect(text).not.toBeNull();
    expect(getComputedStyle(text).overflow).toBe('hidden');
    expect(getComputedStyle(text).getPropertyValue('-webkit-line-clamp')).toBe('3');
  });

  it('collapses prompt context to a recoverable tab for the rest of the session', async () => {
    const fixture = createWorkspace();
    fixture.detectChanges();
    fixture.componentInstance.runtime.loading.set(false);
    fixture.componentInstance.runtime.hydrated.set(true);
    fixture.componentInstance.runtime.conversation.history.set([
      {
        id: 'user-1',
        kind: 'user',
        content: 'Keep this prompt available',
        timestamp: '2026-04-24T08:00:00.000Z',
      },
      {
        id: 'assistant-1',
        kind: 'assistant',
        content: 'A long response',
        timestamp: '2026-04-24T08:00:01.000Z',
      },
    ]);
    fixture.detectChanges();
    await flushPromises();

    const transcript = fixture.nativeElement.querySelector('.cw-transcript') as HTMLElement;
    const source = fixture.nativeElement.querySelector('[data-user-prompt-id]') as HTMLElement;
    vi.spyOn(transcript, 'getBoundingClientRect').mockReturnValue({ top: 100 } as DOMRect);
    const sourceRect = vi.spyOn(source, 'getBoundingClientRect');
    sourceRect.mockReturnValue({ top: -100, bottom: 80 } as DOMRect);
    transcript.dispatchEvent(new Event('scroll'));
    fixture.detectChanges();

    const collapse = fixture.nativeElement.querySelector(
      '[aria-label="Collapse prompt context"]',
    ) as HTMLButtonElement;
    collapse.click();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.cw-contextual-prompt__surface')).toBeNull();
    const restore = fixture.nativeElement.querySelector(
      '[aria-label="Show prompt context"]',
    ) as HTMLButtonElement;
    expect(restore).not.toBeNull();
    expect(fixture.nativeElement.querySelector('.cw-contextual-prompt')?.textContent).not.toContain(
      'Keep this prompt available',
    );

    // Temporarily seeing the source prompt must not discard the user's choice.
    sourceRect.mockReturnValue({ top: 110, bottom: 150 } as DOMRect);
    transcript.dispatchEvent(new Event('scroll'));
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.cw-contextual-prompt')).toBeNull();

    sourceRect.mockReturnValue({ top: -100, bottom: 80 } as DOMRect);
    transcript.dispatchEvent(new Event('scroll'));
    fixture.detectChanges();
    expect(
      fixture.nativeElement.querySelector('[aria-label="Show prompt context"]'),
    ).not.toBeNull();

    (
      fixture.nativeElement.querySelector('[aria-label="Show prompt context"]') as HTMLButtonElement
    ).click();
    fixture.detectChanges();
    expect(
      fixture.nativeElement.querySelector('.cw-contextual-prompt__text')?.textContent,
    ).toContain('Keep this prompt available');
  });

  it('rewinds conversation and restores the prompt into the composer state', async () => {
    const fixture = createWorkspace();
    fixture.detectChanges();
    fixture.componentInstance.runtime.loading.set(false);
    fixture.componentInstance.runtime.hydrated.set(true);

    await fixture.componentInstance.actions.confirmEditMessage({
      id: 'user-1',
      kind: 'user',
      content: 'Edited prompt source',
      timestamp: '2026-04-24T08:00:00.000Z',
      authoredAt: '2026-04-24T08:00:00.000Z',
      sourceMessageId: 'source-user-1',
    });

    expect(apiMock.rewindConversation).toHaveBeenCalledWith(7, 'source-user-1');
    expect(fixture.componentInstance.draft.prompt()).toBe('Edited prompt source');
    expect(fixture.componentInstance.runtime.historyItems()).toEqual([
      expect.objectContaining({
        content: 'Edited prompt source',
        sourceMessageId: 'source-user-1',
      }),
    ]);
    expect(fixture.componentInstance.actions.armedEditMessageId()).toBeNull();
  });

  it.each(['light', 'dark'])('reads runtime state after the rewind and ignores its completion refresh in %s mode', async (theme) => {
    document.documentElement.classList.toggle('dark', theme === 'dark');
    const fixture = createWorkspace();
    fixture.detectChanges();
    fixture.componentInstance.runtime.loading.set(false);
    fixture.componentInstance.runtime.hydrated.set(true);
    const rewind = new Subject<any[]>();
    apiMock.rewindConversation.mockReturnValueOnce(rewind);
    apiMock.getRuntimeState.mockClear();
    apiMock.getHistory.mockClear();
    const editing = fixture.componentInstance.actions.confirmEditMessage({
      id: 'user-2', kind: 'user', content: 'Edit second', sourceMessageId: 'source-user-2',
      timestamp: '2026-04-24T08:00:01.000Z',
    });
    expect(apiMock.getRuntimeState).not.toHaveBeenCalled();
    (fixture.componentInstance.runtime as any).handleRuntimeEvent({ type: 'complete', payload: { sessionId: 7 } });
    expect(apiMock.getHistory).not.toHaveBeenCalled();
    rewind.next([{ id: 'user-1', kind: 'user', content: 'Keep first', timestamp: '2026-04-24T08:00:00.000Z' }]);
    rewind.complete();
    await editing;
    expect(apiMock.getRuntimeState).toHaveBeenCalledWith(7);
    expect(fixture.componentInstance.runtime.conversation.history().map(item => item.content)).toEqual(['Keep first']);
    expect(fixture.componentInstance.draft.prompt()).toBe('Edit second');
    document.documentElement.classList.remove('dark');
  });

  it('discards an old completion history response after an edit', async () => {
    const fixture = createWorkspace();
    fixture.detectChanges();
    fixture.componentInstance.runtime.loading.set(false);
    fixture.componentInstance.runtime.hydrated.set(true);
    const staleHistory = new Subject<any[]>();
    apiMock.getHistory.mockReturnValueOnce(staleHistory);
    const syncing = (fixture.componentInstance.runtime as any).syncHistoryAfterCompletion();
    await fixture.componentInstance.actions.confirmEditMessage({
      id: 'user-2', kind: 'user', content: 'Edit second', sourceMessageId: 'source-user-2',
      timestamp: '2026-04-24T08:00:01.000Z',
    });
    const retained = fixture.componentInstance.runtime.conversation.history();
    staleHistory.next([]);
    staleHistory.complete();
    await syncing;
    expect(fixture.componentInstance.runtime.conversation.history()).toEqual(retained);
    expect(retained.length).toBeGreaterThan(0);
  });

  it('preserves the displayed history when a rewind fails', async () => {
    const fixture = createWorkspace();
    fixture.detectChanges();
    fixture.componentInstance.runtime.loading.set(false);
    fixture.componentInstance.runtime.hydrated.set(true);
    const history = [{ id: 'user-1', kind: 'user' as const, content: 'Keep first', timestamp: '2026-04-24T08:00:00.000Z' }];
    fixture.componentInstance.runtime.conversation.history.set(history);
    const rewind = new Subject<any[]>();
    apiMock.rewindConversation.mockReturnValueOnce(rewind);
    const editing = fixture.componentInstance.actions.confirmEditMessage({
      id: 'user-2', kind: 'user', content: 'Edit second', sourceMessageId: 'source-user-2',
      timestamp: '2026-04-24T08:00:01.000Z',
    });
    rewind.error(new Error('History not ready'));
    await editing;
    expect(fixture.componentInstance.runtime.conversation.history()).toEqual(history);
    expect(fixture.componentInstance.actions.rewindingMessageId()).toBeNull();
    expect(toast.error).toHaveBeenCalledWith('History not ready');
    vi.mocked(toast.error).mockClear();
  });

  it('leaves the stopped prompt in history when an interrupted run only produced thinking', async () => {
    const fixture = createWorkspace();
    fixture.detectChanges();
    fixture.componentInstance.runtime.loading.set(false);
    fixture.componentInstance.runtime.hydrated.set(true);
    const stoppedHistory = [
      {
        id: 'user-1',
        kind: 'user' as const,
        content: 'Change the stopped prompt',
        timestamp: '2026-04-24T08:00:00.000Z',
        authoredAt: '2026-04-24T08:00:00.000Z',
        sourceMessageId: 'source-user-1',
      },
      {
        id: 'thinking-1',
        kind: 'thinking' as const,
        content: 'Internal planning',
        timestamp: '2026-04-24T08:00:01.000Z',
        receivedAt: '2026-04-24T08:00:01.000Z',
      },
    ];
    apiMock.getHistory.mockReturnValueOnce(of(stoppedHistory));

    fixture.componentInstance.runtime.interrupt();
    (fixture.componentInstance as any).runtime.handleRuntimeEvent({
      type: 'complete',
      payload: { sessionId: 7 },
    });
    await flushPromises();

    expect(apiMock.rewindConversation).not.toHaveBeenCalled();
    expect(fixture.componentInstance.draft.prompt()).toBe('');
    expect(fixture.componentInstance.runtime.historyItems()).toEqual(stoppedHistory);
  });

  it('keeps the stopped prompt editable when Claude already responded', async () => {
    const fixture = createWorkspace();
    fixture.detectChanges();
    fixture.componentInstance.runtime.loading.set(false);
    fixture.componentInstance.runtime.hydrated.set(true);
    const userItem = {
      id: 'user-1',
      kind: 'user' as const,
      content: 'Prompt with partial response',
      timestamp: '2026-04-24T08:00:00.000Z',
      authoredAt: '2026-04-24T08:00:00.000Z',
      sourceMessageId: 'source-user-1',
    };
    apiMock.getHistory.mockReturnValueOnce(
      of([
        userItem,
        {
          id: 'assistant-1',
          kind: 'assistant',
          content: 'Started answering',
          timestamp: '2026-04-24T08:00:01.000Z',
          receivedAt: '2026-04-24T08:00:01.000Z',
        },
      ]),
    );

    fixture.componentInstance.runtime.interrupt();
    (fixture.componentInstance as any).runtime.handleRuntimeEvent({
      type: 'complete',
      payload: { sessionId: 7 },
    });
    await flushPromises();

    expect(apiMock.rewindConversation).not.toHaveBeenCalled();
    expect(fixture.componentInstance.actions.canShowMessageActions(userItem)).toBe(true);
    expect(fixture.componentInstance.actions.messageActionsDisabled()).toBe(false);
  });

  it('opens agent inspector from a collapsed turn and lazy-loads subagent history once', async () => {
    const events$ = new Subject<ClaudeRuntimeEvent>();
    wsMock.connect.mockReturnValue(events$.asObservable());

    const fixture = createWorkspace();
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
    fixture.componentInstance.runtime.loading.set(false);
    fixture.detectChanges();

    const inspect = Array.from(
      fixture.nativeElement.querySelectorAll('.cw-turn-gap__inspect'),
    ) as HTMLButtonElement[];
    inspect[0]?.click();

    await Promise.resolve();
    fixture.detectChanges();

    expect(apiMock.getSubagentHistory).toHaveBeenCalledWith(7, 'agent-1');
    expect(fixture.componentInstance.actions.selectedAgentInspectorTurn()?.agents).toHaveLength(1);

    fixture.componentInstance.actions.selectAgentInspectorAgent('agent-1');
    await Promise.resolve();
    expect(apiMock.getSubagentHistory).toHaveBeenCalledTimes(1);
  });

  it('renders completed turn change stats from edit tool calls', async () => {
    const events$ = new Subject<ClaudeRuntimeEvent>();
    wsMock.connect.mockReturnValue(events$.asObservable());
    apiMock.getHistory.mockReturnValue(
      of(
        editTurnHistory('1', '2026-04-24T08:00:00.000Z', [
          {
            tool: 'Edit',
            file: 'a.ts',
            oldString: linesOf(4).replace(/line/g, 'old'),
            newString: linesOf(14),
          },
          {
            tool: 'Edit',
            file: 'b.ts',
            oldString: linesOf(4).replace(/line/g, 'old'),
            newString: linesOf(14),
          },
          { tool: 'Write', file: 'c.ts', content: linesOf(14) },
        ]),
      ),
    );

    const fixture = createWorkspace();
    fixture.componentRef.setInput('worktreePath', '/tmp/project');
    fixture.detectChanges();
    fixture.componentInstance.runtime.loading.set(false);
    fixture.componentInstance.runtime.hydrated.set(true);

    events$.next({ type: 'complete', payload: { sessionId: 7 } });
    await flushPromises();
    fixture.detectChanges();

    const changes = fixture.nativeElement.querySelector(
      '.cw-turn-gap__changes',
    ) as HTMLElement | null;
    expect(changes?.textContent).toContain('3 files');
    expect(changes?.textContent).toContain('+42');
    expect(changes?.textContent).toContain('-8');
  });

  it('opens a file-by-file diff view for turn changes', async () => {
    const events$ = new Subject<ClaudeRuntimeEvent>();
    wsMock.connect.mockReturnValue(events$.asObservable());
    apiMock.getHistory.mockReturnValue(
      of(
        editTurnHistory('1', '2026-04-24T08:00:00.000Z', [
          {
            tool: 'MultiEdit',
            file: 'src/app.ts',
            edits: [
              {
                old_string: 'const a = 1;\nconst b = 2;',
                new_string: 'const a = 1;\nconst b = 3;',
              },
              {
                old_string: 'export const name = "old";',
                new_string: 'export const name = "new";',
              },
            ],
          },
          { tool: 'Write', file: 'src/new.ts', content: 'export const created = true;' },
        ]),
      ),
    );

    const fixture = createWorkspace();
    fixture.componentRef.setInput('worktreePath', '/tmp/project');
    fixture.detectChanges();
    fixture.componentInstance.runtime.loading.set(false);
    fixture.componentInstance.runtime.hydrated.set(true);

    events$.next({ type: 'complete', payload: { sessionId: 7 } });
    await flushPromises();
    fixture.detectChanges();

    const button = fixture.nativeElement.querySelector(
      '.cw-turn-gap__changes-button',
    ) as HTMLButtonElement | null;
    expect(button?.textContent).toContain('View changes');
    button?.click();
    fixture.detectChanges();

    const panel = fixture.nativeElement.querySelector('cw-turn-changes') as HTMLElement | null;
    expect(panel?.textContent).toContain('Changes in this turn');
    expect(panel?.textContent).toContain('app.ts');
    expect(panel?.textContent).toContain('new.ts');
    expect(panel?.querySelectorAll('.cw-turn-changes__file')).toHaveLength(2);
    expect(panel?.querySelector('.cw-inline-diff__body')?.innerHTML).toContain('cw-diff-line');
  });

  it('opens turn changes from an already hydrated historical session', async () => {
    const events$ = new Subject<ClaudeRuntimeEvent>();
    wsMock.connect.mockReturnValue(events$.asObservable());

    const fixture = createWorkspace();
    fixture.componentRef.setInput('worktreePath', '/tmp/project');
    fixture.detectChanges();
    await Promise.resolve();

    events$.next({
      type: 'session_snapshot',
      payload: {
        ...runtimeState(),
        sessionId: 7,
        history: editTurnHistory('yesterday', '2026-04-23T18:00:00.000Z', [
          {
            tool: 'Edit',
            file: 'src/yesterday.ts',
            oldString: 'export const value = 1;',
            newString: 'export const value = 2;',
          },
        ]),
      },
    });
    await flushPromises();
    fixture.detectChanges();

    const button = fixture.nativeElement.querySelector(
      '.cw-turn-gap__changes-button',
    ) as HTMLButtonElement | null;
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

    const fixture = createWorkspace();
    fixture.componentRef.setInput('worktreePath', '/tmp/project');
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

    const changes = fixture.nativeElement.querySelector(
      '.cw-turn-gap__changes',
    ) as HTMLElement | null;
    expect(changes?.textContent).toContain('1 file');

    const button = fixture.nativeElement.querySelector(
      '.cw-turn-gap__changes-button',
    ) as HTMLButtonElement | null;
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
    apiMock.getHistory.mockReturnValue(
      of(
        editTurnHistory('1', '2026-04-24T08:00:00.000Z', [
          {
            tool: 'Edit',
            file: 'a.ts',
            oldString: linesOf(2).replace(/line/g, 'old'),
            newString: linesOf(5),
          },
          {
            tool: 'Edit',
            file: 'a.ts',
            oldString: linesOf(2).replace(/line/g, 'old'),
            newString: linesOf(5),
          },
          {
            tool: 'Edit',
            file: 'a.ts',
            oldString: linesOf(1).replace(/line/g, 'old'),
            newString: linesOf(3),
          },
        ]),
      ),
    );

    const fixture = createWorkspace();
    fixture.componentRef.setInput('worktreePath', '/tmp/project');
    fixture.detectChanges();
    fixture.componentInstance.runtime.loading.set(false);
    fixture.componentInstance.runtime.hydrated.set(true);

    events$.next({ type: 'complete', payload: { sessionId: 7 } });
    await flushPromises();
    fixture.detectChanges();

    const changes = fixture.nativeElement.querySelector(
      '.cw-turn-gap__changes',
    ) as HTMLElement | null;
    expect(changes?.textContent).toContain('1 file');
    expect(changes?.textContent).toContain('+8');
    expect(changes?.textContent).toContain('-3');
  });

  it('omits completed turn change stats when no edit tools ran', async () => {
    const events$ = new Subject<ClaudeRuntimeEvent>();
    wsMock.connect.mockReturnValue(events$.asObservable());
    apiMock.getHistory.mockReturnValue(of(collapsibleTurnHistory()));

    const fixture = createWorkspace();
    fixture.componentRef.setInput('worktreePath', '/tmp/project');
    fixture.detectChanges();
    fixture.componentInstance.runtime.loading.set(false);
    fixture.componentInstance.runtime.hydrated.set(true);

    events$.next({ type: 'complete', payload: { sessionId: 7 } });
    await flushPromises();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.cw-turn-gap__changes')).toBeNull();
  });

  it('skips failed edit tool calls when computing change stats', async () => {
    const events$ = new Subject<ClaudeRuntimeEvent>();
    wsMock.connect.mockReturnValue(events$.asObservable());
    apiMock.getHistory.mockReturnValue(
      of(
        editTurnHistory('1', '2026-04-24T08:00:00.000Z', [
          {
            tool: 'Edit',
            file: 'a.ts',
            oldString: linesOf(3).replace(/line/g, 'old'),
            newString: linesOf(5),
            isError: true,
          },
        ]),
      ),
    );

    const fixture = createWorkspace();
    fixture.componentRef.setInput('worktreePath', '/tmp/project');
    fixture.detectChanges();
    fixture.componentInstance.runtime.loading.set(false);
    fixture.componentInstance.runtime.hydrated.set(true);

    events$.next({ type: 'complete', payload: { sessionId: 7 } });
    await flushPromises();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.cw-turn-gap__changes')).toBeNull();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('attaches change stats to every collapsed turn rendered from history', async () => {
    const events$ = new Subject<ClaudeRuntimeEvent>();
    wsMock.connect.mockReturnValue(events$.asObservable());
    apiMock.getHistory.mockReturnValue(
      of([
        ...editTurnHistory('1', '2026-04-24T08:00:00.000Z', [
          {
            tool: 'Edit',
            file: 'a.ts',
            oldString: linesOf(2).replace(/line/g, 'old'),
            newString: linesOf(2),
          },
        ]),
        ...editTurnHistory('2', '2026-04-24T08:01:00.000Z', [
          {
            tool: 'Edit',
            file: 'a.ts',
            oldString: linesOf(1).replace(/line/g, 'old'),
            newString: linesOf(5),
          },
          { tool: 'Write', file: 'b.ts', content: linesOf(4) },
        ]),
      ]),
    );

    const fixture = createWorkspace();
    fixture.componentRef.setInput('worktreePath', '/tmp/project');
    fixture.detectChanges();
    fixture.componentInstance.runtime.loading.set(false);
    fixture.componentInstance.runtime.hydrated.set(true);

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
    const fixture = createWorkspace();
    fixture.componentRef.setInput('repoId', 1);
    fixture.componentRef.setInput('worktreePath', '/tmp/project');
    fixture.detectChanges();
    await Promise.resolve();

    fixture.componentInstance.draft.worktreeContext.set(readyWorktreeContext());
    worktreeContextServiceMock.consume.mockReturnValue(
      of({
        shouldInject: true,
        contextSentence: 'This branch updates first-message context handling.',
      }),
    );

    await fixture.componentInstance.draft.submitPrompt('Ship this change');

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
    expect(fixture.componentInstance.draft.hasInjectedContext()).toBe(true);
  });

  it('does not offer first-prompt context after TUI already consumed it', async () => {
    const fixture = createWorkspace();
    fixture.componentRef.setInput('hasInjectedWorktreeContext', true);
    fixture.detectChanges();
    await Promise.resolve();

    fixture.componentInstance.draft.worktreeContext.set(readyWorktreeContext());
    fixture.componentInstance.draft.prompt.set('Ship this change');

    expect(fixture.componentInstance.draft.hasInjectedContext()).toBe(true);
    expect(fixture.componentInstance.draft.canAppendContext()).toBe(false);
    await fixture.componentInstance.draft.submitPrompt('Ship this change');

    expect(worktreeContextServiceMock.consume).not.toHaveBeenCalled();
    expect(wsMock.send).toHaveBeenLastCalledWith(7, {
      type: 'submit_prompt',
      prompt: 'Ship this change',
      titlePrompt: 'Ship this change',
    });
  });

  it('does not call consume when local context is not ready', async () => {
    const fixture = createWorkspace();
    fixture.detectChanges();
    await Promise.resolve();

    fixture.componentInstance.draft.worktreeContext.set({
      ...readyWorktreeContext(),
      contextSentence: null,
      generationStatus: 'generating',
    });

    await fixture.componentInstance.draft.submitPrompt('Ship this change');

    expect(worktreeContextServiceMock.consume).not.toHaveBeenCalled();
    expect(wsMock.send).toHaveBeenLastCalledWith(7, {
      type: 'submit_prompt',
      prompt: 'Ship this change',
      titlePrompt: 'Ship this change',
    });
  });

  it('does not call consume when first-message context is disabled', async () => {
    const fixture = createWorkspace();
    fixture.detectChanges();
    await Promise.resolve();

    fixture.componentInstance.draft.worktreeContext.set(readyWorktreeContext());
    fixture.componentInstance.draft.firstPromptContextEnabled.set(false);

    await fixture.componentInstance.draft.submitPrompt('Ship this change');

    expect(worktreeContextServiceMock.consume).not.toHaveBeenCalled();
    expect(wsMock.send).toHaveBeenLastCalledWith(7, {
      type: 'submit_prompt',
      prompt: 'Ship this change',
      titlePrompt: 'Ship this change',
    });
  });

  it('does not call consume for slash commands', async () => {
    const fixture = createWorkspace();
    fixture.detectChanges();
    await Promise.resolve();

    fixture.componentInstance.draft.worktreeContext.set(readyWorktreeContext());

    await fixture.componentInstance.draft.submitPrompt('/status');

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

    const fixture = createWorkspace();
    fixture.detectChanges();
    await Promise.resolve();

    fixture.componentInstance.draft.worktreeContext.set(readyWorktreeContext());

    const submitPromise = fixture.componentInstance.draft.submitPrompt('Ship this change');
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
    expect(fixture.componentInstance.draft.hasInjectedContext()).toBe(true);

    consume$.next({ shouldInject: false, contextSentence: null });
    consume$.complete();
  });

  it('clears the composer immediately without waiting for worktree context consume', async () => {
    const consume$ = new Subject<{ shouldInject: boolean; contextSentence: string | null }>();
    worktreeContextServiceMock.consume.mockReturnValue(consume$.asObservable());

    const fixture = createWorkspace();
    fixture.detectChanges();
    await Promise.resolve();

    fixture.componentInstance.draft.worktreeContext.set(readyWorktreeContext());
    fixture.componentInstance.draft.prompt.set('Ship this change');
    const submitPromise = fixture.componentInstance.draft.submitPrompt('Ship this change');

    expect(fixture.componentInstance.draft.prompt()).toBe('');
    expect(fixture.componentInstance.runtime.submitting()).toBe(true);
    expect(fixture.componentInstance.runtime.optimisticUserItems()).toEqual([
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

  it('coalesces repeated context refreshes while a cached read is pending', async () => {
    const response = new Subject<ReturnType<typeof readyWorktreeContext>>();
    worktreeContextServiceMock.get.mockReturnValue(response);
    const fixture = createWorkspace();
    fixture.detectChanges();
    const { runtime, draft } = fixture.componentInstance;

    runtime.notify({ type: 'load-context' });
    runtime.notify({ type: 'load-context' });
    expect(worktreeContextServiceMock.get).toHaveBeenCalledTimes(1);
    expect(draft.worktreeContextLoading()).toBe(true);

    response.next(readyWorktreeContext());
    await flushPromises();
    expect(draft.worktreeContext()).toEqual(readyWorktreeContext());
    expect(draft.worktreeContextLoading()).toBe(false);
  });

  it('ignores an older cached response while recomputing context', async () => {
    const cached = new Subject<ReturnType<typeof readyWorktreeContext>>();
    const generated = new Subject<ReturnType<typeof readyWorktreeContext>>();
    worktreeContextServiceMock.get.mockReturnValue(cached);
    worktreeContextServiceMock.generate.mockReturnValue(generated);
    const fixture = createWorkspace();
    fixture.detectChanges();
    const { runtime, draft } = fixture.componentInstance;
    const recompute = draft.recomputeWorktreeContext();

    cached.next(readyWorktreeContext());
    await flushPromises();
    expect(draft.worktreeContext()).toBeNull();
    expect(draft.worktreeContextBusy()).toBe(true);
    runtime.notify({ type: 'load-context' });
    expect(worktreeContextServiceMock.get).toHaveBeenCalledTimes(1);

    const latest = { ...readyWorktreeContext(), contextSentence: 'Recomputed context' };
    generated.next(latest);
    await recompute;
    expect(draft.worktreeContext()).toEqual(latest);
    expect(draft.worktreeContextBusy()).toBe(false);
  });

  it('preserves the edited root and busy state when a superseded refresh fails', async () => {
    const cached = new Subject<ReturnType<typeof readyWorktreeContext>>();
    const generated = new Subject<ReturnType<typeof readyWorktreeContext>>();
    worktreeContextServiceMock.get.mockReturnValue(cached);
    worktreeContextServiceMock.generate.mockReturnValue(generated);
    const fixture = createWorkspace();
    fixture.detectChanges();
    const { draft } = fixture.componentInstance;
    draft.openRootRefEditor();
    draft.onRootRefInput('new-root');
    const save = draft.saveRootRef();
    await flushPromises();

    cached.error(new Error('Old refresh failed'));
    await flushPromises();
    expect(draft.draftRootRef()).toBe('new-root');
    expect(draft.worktreeContextBusy()).toBe(true);
    expect(vi.mocked(toast.error)).not.toHaveBeenCalled();
    generated.next({ ...readyWorktreeContext(), rootRef: 'new-root' });
    await save;
    expect(draft.worktreeContext()?.rootRef).toBe('new-root');
    expect(draft.worktreeContextBusy()).toBe(false);
  });

  it('does not overwrite an unsaved comparison root when refreshing context', async () => {
    const cached = new Subject<ReturnType<typeof readyWorktreeContext>>();
    worktreeContextServiceMock.get.mockReturnValue(cached);
    const fixture = createWorkspace();
    fixture.detectChanges();
    const { draft } = fixture.componentInstance;
    draft.openRootRefEditor();
    draft.onRootRefInput('my-unsaved-root');
    cached.next(readyWorktreeContext());
    await flushPromises();
    expect(draft.draftRootRef()).toBe('my-unsaved-root');
  });

  it('uses cached-only worktree context loading before a new Codex session starts', async () => {
    const fixture = createWorkspace();
    fixture.componentRef.setInput('repoId', 1);
    fixture.componentRef.setInput('worktreePath', '/tmp/project');
    fixture.componentRef.setInput('activeAgentProvider', 'codex');
    fixture.componentRef.setInput('hasStartedAgentRuntime', false);

    fixture.detectChanges();
    await Promise.resolve();

    expect(worktreeContextServiceMock.get).toHaveBeenCalledWith(1, '/tmp/project', {
      cachedOnly: true,
    });
    expect(worktreeContextServiceMock.generate).not.toHaveBeenCalled();
  });

  it('approves a Codex plan by disabling plan mode while preserving permission style', async () => {
    const fixture = createWorkspace();
    fixture.componentRef.setInput('repoId', 1);
    fixture.componentRef.setInput('worktreePath', '/tmp/project');
    fixture.componentRef.setInput('activeAgentProvider', 'codex');
    fixture.detectChanges();
    await Promise.resolve();

    fixture.componentInstance.runtime._planMode.set(true);
    fixture.componentInstance.runtime._permissionMode.set('bypassPermissions');
    apiMock.setPlanMode.mockReturnValueOnce(
      of({
        ...runtimeState(),
        permissionMode: 'bypassPermissions',
        planMode: false,
      }),
    );

    await fixture.componentInstance.approvePlanReview({
      provider: 'codex',
      source: 'transcript-plan',
      sessionId: 7,
      reviewId: 'review-1',
      planMarkdown: 'Plan',
      createdAt: '2026-04-24T08:00:00.000Z',
    });

    expect(apiMock.setPermissionMode).toHaveBeenCalledWith(7, 'bypassPermissions');
    expect(apiMock.setPlanMode).toHaveBeenCalledWith(7, false);
    expect(fixture.componentInstance.runtime.permissionMode()).toBe('bypassPermissions');
    expect(fixture.componentInstance.runtime.planMode()).toBe(false);
    expect(wsMock.send).toHaveBeenCalledWith(7, {
      type: 'submit_prompt',
      prompt: 'implement plan',
      titlePrompt: 'implement plan',
    });
  });

  it('updates the live tool card when permission resolution arrives', async () => {
    const events$ = new Subject<ClaudeRuntimeEvent>();
    wsMock.connect.mockReturnValue(events$.asObservable());

    const fixture = createWorkspace();
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

    expect(fixture.componentInstance.runtime.liveItems()).toEqual([
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

    const fixture = createWorkspace();
    fixture.detectChanges();
    wsMock.send.mockClear();
    wsMock.disconnect.mockClear();
    wsMock.connect.mockClear();
    wsMock.isConnected.mockReturnValue(false);

    fixture.componentInstance.runtime.conversation.pendingUserInputRequest.set({
      requestId: 'input-1',
      serverName: 'github',
      message: 'Authorize GitHub?',
      createdAt: '2026-04-24T08:00:00.000Z',
    });

    fixture.componentInstance.runtime.answerUserInput({
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

    const fixture = createWorkspace();
    fixture.detectChanges();

    fixture.componentInstance.runtime.conversation.pendingPermissionRequest.set({
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
        planMode: false,
        availableModels: [],
        contextUsage: null,
        pendingPermissionRequest: null,
        pendingUserInputRequest: null,
        pendingPrompts: [],
        queuePaused: false,
      },
    });

    expect(fixture.componentInstance.runtime.pendingPermissionRequest()).toBeNull();
  });

  it('deduplicates matching history and live tool items after hydrate snapshot reload', async () => {
    const events$ = new Subject<ClaudeRuntimeEvent>();
    wsMock.connect.mockReturnValue(events$.asObservable());

    const fixture = createWorkspace();
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

    const toolUnits = fixture.componentInstance.runtime
      .pairedTranscript()
      .filter((unit) => unit.kind === 'tool');
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
    const fixture = createWorkspace();
    fixture.detectChanges();

    fixture.componentInstance.runtime.loading.set(false);
    fixture.componentInstance.runtime.hydrated.set(true);
    fixture.componentInstance.draft.prompt.set('Can you continue?');
    fixture.componentInstance.runtime.conversation.pendingPermissionRequest.set({
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
    const fixture = createWorkspace();
    fixture.detectChanges();

    fixture.componentInstance.runtime.loading.set(false);
    fixture.componentInstance.runtime.hydrated.set(true);
    fixture.componentInstance.runtime.conversation.history.set([
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
    fixture.componentInstance.runtime.conversation.pendingPermissionRequest.set({
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
