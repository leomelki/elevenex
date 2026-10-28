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
    info: { id: 'codex', permissionModes: ['default'] },
    getRuntimeState: jest.fn(),
    getHistory: jest.fn(),
    onClientAttached: jest.fn(),
    onClientDetached: jest.fn(),
    submitPrompt: jest.fn(),
    interrupt: jest.fn(),
    approvePermission: jest.fn(),
    answerUserInput: jest.fn(),
  });
  const session = jest.fn();
  beforeEach(async () => {
    history = [];
    live = [];
    status = 'active';
    jest.clearAllMocks();
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
          provide: SessionsService,
          useValue: {
            findOne: session,
            assertSessionWorkspaceLinked: jest.fn(),
            reactivateRuntime: jest.fn(),
          },
        },
        {
          provide: AgentRuntimeRegistryService,
          useValue: {
            getProvider: () => runtime,
            getProviderFeature: () => runtime,
          },
        },
      ],
    }).compile();
    chat = module.get(DesktopChatService);
  });
  afterEach(async () => module.close());
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
  it('pages history by stable identity and bounds payloads without hydrating other sessions', async () => {
    history = Array.from({ length: 240 }, (_, index) => item(String(index)));
    const latest = (await read())!;
    expect(latest.items).toHaveLength(80);
    expect(latest.items[0].id).toBe('160');
    expect(latest.before).toBe('160');
    const older = (await read(undefined, latest.before!))!;
    expect(older.items[0].id).toBe('80');
    expect(older.items.at(-1)?.id).toBe('159');
    expect(runtime.getRuntimeState).toHaveBeenCalledWith(2);
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
    runtime.onClientAttached.mockImplementationOnce(() => { throw new Error('Attachment failed'); });
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
