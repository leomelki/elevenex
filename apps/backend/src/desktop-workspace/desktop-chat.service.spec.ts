import { SettingsService } from '../settings/settings.service.js';
import { Test, type TestingModule } from '@nestjs/testing';
import { EventEmitter } from 'node:events';
import { AgentRuntimeRegistryService } from '../agent-runtime/agent-runtime-registry.service.js';
import { SessionsService } from '../sessions/sessions.service.js';
import type { AgentTranscriptItem } from '../agent-runtime/agent-runtime.types.js';
import { DesktopChatService } from './desktop-chat.service.js';
import { chatState, display } from './desktop-chat-projection.js';

const item = (id: string, text = id): AgentTranscriptItem => ({
  id,
  kind: 'assistant',
  content: text,
  timestamp: '2026-10-28T12:00:00Z',
});
const settle = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};
describe('selected session chat', () => {
  let module: TestingModule, chat: DesktopChatService;
  let history: AgentTranscriptItem[],
    live: AgentTranscriptItem[],
    status: string;
  const runtime = Object.assign(new EventEmitter(), {
    info: { id: 'codex', displayName: 'Codex', permissionModes: ['default'] },
    getRuntimeState: jest.fn(),
    getHistory: jest.fn(),
    onClientAttached: jest.fn(),
    onClientDetached: jest.fn(),
    submitPrompt: jest.fn(),
    interrupt: jest.fn(),
    approvePermission: jest.fn(),
    answerUserInput: jest.fn(),
    setReasoningEffort: jest.fn(),
    setFastMode: jest.fn(),
  });
  const session = jest.fn();
  const started = jest.fn();
  const updateProvider = jest.fn();
  const advertised = jest.fn();
  beforeEach(async () => {
    history = [];
    live = [];
    status = 'active';
    jest.clearAllMocks();
    started.mockReturnValue(true);
    advertised.mockReturnValue([
      runtime.info,
      { id: 'claude', displayName: 'Claude Code' },
      { id: 'pi', displayName: 'Pi' },
      { id: 'opencode', displayName: 'OpenCode' },
    ]);
    runtime.removeAllListeners();
    runtime.getHistory.mockImplementation(async () => history);
    runtime.getRuntimeState.mockImplementation(async () => ({
      sessionId: 2,
      runPhase: 'running',
      canInterrupt: true,
      liveItems: live,
    }));
    session.mockImplementation(async () => ({
      workspaceId: 1,
      surface: 'session',
      status,
      activeAgentProvider: 'codex',
      workspaceArchivedAt: null,
    }));
    module = await Test.createTestingModule({
      providers: [
        DesktopChatService,
        {
          provide: SettingsService,
          useValue: { getAgentModelPresets: () => [], getAgentPresetDefault: () => ({ id: null, provider: 'codex', defaultIds: [], revision: 'a'.repeat(64) }) },
        },
        {
          provide: SessionsService,
          useValue: {
            findOne: session,
            hasStartedAgentRuntime: started,
            updateActiveAgentProvider: updateProvider,
            assertSessionWorkspaceLinked: jest.fn(),
            reactivateRuntime: jest.fn(),
          },
        },
        {
          provide: AgentRuntimeRegistryService,
          useValue: {
            listProviders: advertised,
            getProvider: (id: string) => {
              if (
                !advertised().some(
                  (provider: { id: string }) => provider.id === id,
                )
              )
                throw new Error('Unknown harness');
              return runtime;
            },
            getProviderFeature: () => runtime,
          },
        },
      ],
    }).compile();
    chat = module.get(DesktopChatService);
  });
  afterEach(async () => module.close());

  it('coalesces prepared reply reads until transcript invalidation', async () => {
    history = [{ ...item('u'), kind: 'user' }];
    await Promise.all([chat.changes(1, 2, 'u', 0), chat.changes(1, 2, 'u', 0)]);
    expect(runtime.getHistory).toHaveBeenCalledTimes(1);
    await chat.changes(1, 2, 'u', 0);
    expect(runtime.getHistory).toHaveBeenCalledTimes(1);
    emit('history_snapshot');
    await chat.changes(1, 2, 'u', 0);
    expect(runtime.getHistory).toHaveBeenCalledTimes(2);
  });

  it('reads archived reply diffs without attaching a runtime and validates task ownership', async () => {
    status = 'archived';
    history = [{ ...item('u'), kind: 'user' }, { ...item('s'), kind: 'system', turnChanges: { files: 0, additions: 0, deletions: 0, filesChanged: [] } }];
    expect((await chat.changes(1, 2, 'u', 0)).total).toBe(0);
    expect(runtime.getRuntimeState).not.toHaveBeenCalled();
    expect(runtime.onClientAttached).not.toHaveBeenCalled();
    await expect(chat.changes(99, 2, 'u', 0)).rejects.toThrow('does not belong');
    await expect(chat.changes(1, 2, 'u', -1)).rejects.toThrow('Invalid changes');
  });
  const read = (
    after?: string,
    before?: string,
    signal = new AbortController().signal,
  ) => chat.read(1, 2, after, before, signal);
  const emit = (type = 'message_delta') =>
    runtime.emit('event', {
      type,
      payload: { sessionId: 2, runPhase: 'idle' },
    });
  it('updates subscription allowance through the existing feed without reloading history', async () => {
    const plan = {
      provider: 'codex',
      planName: 'Plus',
      status: 'warning',
      windows: [
        {
          id: 'primary',
          label: '5-hour limit',
          remainingPercentage: 12,
          resetsAt: null,
        },
      ],
      updatedAt: '2026-10-30T10:00:00Z',
    };
    runtime.getRuntimeState.mockImplementation(async () => ({
      authStatus: { authMethod: 'oauth' },
      planUsage: plan,
    }));
    const first = (await read())!;
    expect(first.state.planUsage).toEqual(plan);
    const pending = read(first.cursor);
    await settle();
    plan.windows[0].remainingPercentage = 0;
    plan.status = 'exhausted';
    emit('plan_usage');
    const next = (await pending)!;
    expect(next.state.planUsage?.windows[0].remainingPercentage).toBe(0);
    expect(next.reset).toBe(false);
    expect(runtime.getHistory).toHaveBeenCalledTimes(1);
  });
  it('exposes bounded model capabilities and validates thinking/fast against the selected model', async () => {
    runtime.getRuntimeState.mockResolvedValue({
      selectedModel: 'gpt',
      fastMode: true,
      availableModels: [
        {
          id: 'gpt',
          displayName: 'GPT',
          reasoningEfforts: ['low', 'high'],
          supportsFastMode: true,
        },
      ],
    });
    const page = (await read())!;
    expect(page.state.controls).toEqual({
      plan: false,
      reasoning: true,
      fast: true,
    });
    expect(page.state.fast).toBe(true);
    expect(page.state.models[0]).toMatchObject({
      reasoningEfforts: ['low', 'high'],
      supportsFastMode: true,
    });
    await chat.command(1, 2, { type: 'reasoning', effort: 'low' });
    expect(runtime.setReasoningEffort).toHaveBeenCalledWith(2, 'low');
    await chat.command(1, 2, { type: 'reasoning', effort: null });
    expect(runtime.setReasoningEffort).toHaveBeenLastCalledWith(2, null);
    await chat.command(1, 2, { type: 'fast', enabled: true });
    expect(runtime.setFastMode).toHaveBeenCalledWith(2, true);
    await expect(
      chat.command(1, 2, { type: 'reasoning', effort: 'invented' }),
    ).rejects.toThrow('Unsupported thinking');
    runtime.getRuntimeState.mockResolvedValue({
      selectedModel: 'basic',
      availableModels: [{ id: 'basic' }],
    });
    await expect(
      chat.command(1, 2, { type: 'fast', enabled: true }),
    ).rejects.toThrow('unavailable');
    await expect(
      chat.command(1, 2, { type: 'fast', enabled: 'true' }),
    ).rejects.toThrow('Invalid fast');
    expect(runtime.setFastMode).toHaveBeenCalledTimes(1);
    await expect(
      chat.command(1, 2, { type: 'reasoning', effort: 'low' }),
    ).rejects.toThrow('Unsupported thinking');
  });
  it('pages history by stable identity and bounds payloads without hydrating other sessions', async () => {
    history = Array.from({ length: 240 }, (_, index) => item(String(index)));
    const latest = (await read())!;
    expect(latest.items).toHaveLength(80);
    expect(latest.items[0].id).toBe('160');
    expect(latest.before).toBe('160');
    const older = (await read(undefined, latest.before!))!;
    expect(older.items[0].id).toBe('80');
    expect(older.items.at(-1)?.id).toBe('159');
    expect(runtime.getRuntimeState).toHaveBeenCalledWith(2, undefined);
    await expect(
      chat.read(9, 2, undefined, undefined, new AbortController().signal),
    ).rejects.toThrow('does not belong');
  });
  it('streams idempotent item replacements and never rereads persisted history per token', async () => {
    live = [item('reply', 'Hello')];
    const initial = (await read())!;
    live = [item('reply', 'Hello there')];
    emit();
    const update = (await read(initial.cursor))!;
    expect(update.reset).toBe(false);
    expect(update.events).toEqual([
      {
        type: 'item',
        item: expect.objectContaining({ id: 'reply', text: 'Hello there' }),
      },
    ]);
    emit('tool_progress');
    const unchanged = (await read(update.cursor))!;
    expect(unchanged.events).toEqual([]);
    expect(runtime.getHistory).toHaveBeenCalledTimes(1);
    emit('run_state');
    expect((await read(unchanged.cursor))!.reset).toBe(true);
  });
  it('keeps a pre-read cursor so events during hydration are reconciled without losing or duplicating text', async () => {
    runtime.getRuntimeState.mockImplementationOnce(async () => {
      emit();
      return { runPhase: 'running', liveItems: [item('reply', 'one')] };
    });
    const initial = (await read())!;
    live = [item('reply', 'one two')];
    const next = (await read(initial.cursor))!;
    expect(next.events).toEqual([
      { type: 'item', item: expect.objectContaining({ text: 'one two' }) },
    ]);
  });
  it('releases cancelled waits, provider attachments and module timers', async () => {
    const initial = (await read())!,
      abort = new AbortController();
    const pending = read(initial.cursor, undefined, abort.signal);
    await settle();
    abort.abort();
    expect(await pending).toBeUndefined();
    await module.close();
    expect(runtime.listenerCount('event')).toBe(0);
    expect(runtime.onClientDetached).toHaveBeenCalledTimes(1);
  });
  it('removes its event observer when a harness attachment fails', async () => {
    runtime.onClientAttached.mockImplementationOnce(() => {
      throw new Error('Attachment failed');
    });
    await expect(read()).rejects.toThrow('Attachment failed');
    expect(runtime.listenerCount('event')).toBe(0);
  });
  it('does not attach or start a runtime when viewing archived history', async () => {
    status = 'archived';
    history = [item('old')];
    expect((await read())!.items[0].id).toBe('old');
    expect(runtime.getRuntimeState).not.toHaveBeenCalled();
    expect(runtime.onClientAttached).not.toHaveBeenCalled();
    await expect(
      chat.command(1, 2, { type: 'send', text: 'no', queue: false }),
    ).rejects.toThrow('read-only');
    await chat.command(1, 2, { type: 'stop' });
    expect(runtime.interrupt).toHaveBeenCalledWith(2);
  });
  it('checks pending request identity and never invents unsupported permanent permissions', async () => {
    runtime.getRuntimeState.mockResolvedValue({
      pendingPermissionRequest: {
        requestId: 'current',
        suppressAlwaysAllowRule: true,
      },
    });
    await expect(
      chat.command(1, 2, {
        type: 'permission',
        id: 'old',
        decision: 'approved',
      }),
    ).rejects.toThrow('no longer pending');
    await expect(
      chat.command(1, 2, {
        type: 'permission',
        id: 'current',
        decision: 'always',
      }),
    ).rejects.toThrow('Unsupported');
    await chat.command(1, 2, {
      type: 'permission',
      id: 'current',
      decision: 'approved',
    });
    expect(runtime.approvePermission).toHaveBeenCalledWith(2, 'current', false);
  });
  it('rejects a catalog read for a conversation belonging to another task before probing a harness', async () => {
    await expect(chat.catalog(9, 2, 'claude')).rejects.toThrow('does not belong');
  });
  it('advertises registered harnesses and reads an unstarted session without initializing a conversation', async () => {
    started.mockReturnValue(false);
    runtime.getRuntimeState.mockResolvedValueOnce({
      runPhase: 'idle',
      canInterrupt: false,
      liveItems: [],
    });
    const page = (await read())!;
    expect(page.state.providers.map((provider) => provider.label)).toEqual([
      'Codex',
      'Claude Code',
      'Pi',
      'OpenCode',
    ]);
    expect(page.state.providerLocked).toBe(false);
    expect(runtime.onClientAttached).not.toHaveBeenCalled();
    expect(runtime.getRuntimeState).toHaveBeenCalledWith(2, {
      initialize: false,
    });
  });
  it('persists a pre-start choice, releases the old observation and rejects stale or started choices', async () => {
    started.mockReturnValue(false);
    runtime.getRuntimeState.mockResolvedValue({
      runPhase: 'idle',
      liveItems: [],
    });
    await read();
    await chat.command(1, 2, {
      type: 'provider',
      provider: 'claude',
      expectedProvider: 'codex',
    });
    expect(updateProvider).toHaveBeenCalledWith(2, 'claude');
    expect(runtime.listenerCount('event')).toBe(0);
    expect(runtime.onClientAttached).not.toHaveBeenCalled();
    await expect(
      chat.command(1, 2, {
        type: 'provider',
        provider: 'pi',
        expectedProvider: 'claude',
      }),
    ).rejects.toThrow('changed');
    started.mockReturnValue(true);
    await expect(
      chat.command(1, 2, {
        type: 'provider',
        provider: 'pi',
        expectedProvider: 'codex',
      }),
    ).rejects.toThrow('already started');
    expect(updateProvider).toHaveBeenCalledTimes(1);
    await expect(
      chat.command(1, 2, {
        type: 'provider',
        provider: 'invented',
        expectedProvider: 'codex',
      }),
    ).rejects.toThrow('Unknown harness');
  });
  it('routes the next prompt through the persisted harness selection', async () => {
    started.mockReturnValue(false);
    runtime.getRuntimeState.mockResolvedValue({
      runPhase: 'idle',
      liveItems: [],
    });
    const claude = Object.assign(new EventEmitter(), {
      ...runtime,
      info: { id: 'claude', displayName: 'Claude Code' },
      submitPrompt: jest.fn(),
    });
    const registry = module.get(AgentRuntimeRegistryService);
    const resolve = jest
      .spyOn(registry, 'getProvider')
      .mockImplementation((id) => (id === 'claude' ? claude : runtime));
    updateProvider.mockImplementationOnce(async () => {
      session.mockResolvedValue({
        workspaceId: 1,
        surface: 'session',
        status: 'active',
        activeAgentProvider: 'claude',
        workspaceArchivedAt: null,
      });
    });
    await chat.command(1, 2, {
      type: 'provider',
      provider: 'claude',
      expectedProvider: 'codex',
    });
    await chat.command(1, 2, {
      type: 'send',
      text: 'Use the selected harness',
      queue: false,
    });
    expect(resolve).toHaveBeenLastCalledWith('claude');
    expect(claude.submitPrompt).toHaveBeenCalledWith(
      2,
      'Use the selected harness',
      undefined,
      undefined,
      { human: true, queue: false },
    );
    expect(runtime.submitPrompt).not.toHaveBeenCalled();
  });
  it('does not move queued prompts or a starting turn to another harness', async () => {
    started.mockReturnValue(false);
    runtime.getRuntimeState.mockResolvedValueOnce({
      runPhase: 'idle',
      pendingPrompts: [{ id: 'queued' }],
    });
    await expect(
      chat.command(1, 2, {
        type: 'provider',
        provider: 'pi',
        expectedProvider: 'codex',
      }),
    ).rejects.toThrow('current operation');
    expect(updateProvider).not.toHaveBeenCalled();
  });
  it('shortens huge outputs explicitly and rejects expired history cursors', async () => {
    history = [item('large', 'x'.repeat(100000))];
    const response = (await read())!;
    expect(response.items[0].truncated).toBe(true);
    expect(response.items[0].text.length).toBeLessThan(16100);
    await expect(read(undefined, 'missing')).rejects.toThrow('cursor expired');
  });
  it('pages original content without splitting surrogate pairs or starting archived runtimes', async () => {
    status = 'archived';
    history = [item('long', 'x'.repeat(15999) + '😀' + 'tail')];
    const first = await chat.content(1, 2, 'long', 'text', 0);
    expect(first.text).toHaveLength(15999);
    expect(first.nextOffset).toBe(15999);
    const last = await chat.content(1, 2, 'long', 'text', first.nextOffset!);
    expect(last.text).toBe('😀tail');
    expect(last.nextOffset).toBeNull();
    expect(runtime.getRuntimeState).not.toHaveBeenCalled();
  });
  it('preserves native multi-select arrays and routes Claude question permissions to their actual request', async () => {
    runtime.getRuntimeState.mockResolvedValueOnce({
      pendingUserInputRequest: { requestId: 'native' },
    });
    await chat.command(1, 2, {
      type: 'answer',
      id: 'native',
      answers: { target: ['A, B', 'C'] },
    });
    expect(runtime.answerUserInput).toHaveBeenCalledWith(
      2,
      'native',
      'accept',
      { target: ['A, B', 'C'] },
    );
    runtime.getRuntimeState.mockResolvedValueOnce({
      pendingPermissionRequest: {
        requestId: 'claude',
        toolKind: 'ask_user_question',
      },
    });
    await chat.command(1, 2, {
      type: 'answer',
      id: 'claude',
      answers: { 'Which target?': ['A'] },
    });
    expect(runtime.approvePermission).toHaveBeenCalledWith(2, 'claude', false, {
      answers: { 'Which target?': 'A' },
    });
  });
});

describe('chat content projection', () => {
  it('includes the shortening marker inside the declared field limit', () => {
    expect(display('x'.repeat(5000), 1000)).toHaveLength(1000);
    expect(display('x'.repeat(5000), 1000)).toContain('[display shortened]');
  });
  it('retains Claude permission-backed questions and provider-native multi-select choices', () => {
    const state = chatState(
      {
        pendingPermissionRequest: {
          requestId: 'ask',
          toolKind: 'ask_user_question',
          input: {
            questions: [
              {
                question: 'Which targets?',
                multiSelect: true,
                options: [{ label: 'A, B' }, { label: 'C' }],
              },
            ],
          },
        },
      },
      'claude',
      [],
    );
    expect(state.permission).toBeNull();
    expect(state.question?.questions[0]).toMatchObject({
      id: 'Which targets?',
      multiple: true,
      options: [
        { label: 'A, B', detail: '' },
        { label: 'C', detail: '' },
      ],
    });
  });
});
