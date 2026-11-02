import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import type { BackendClientState, BackendResult, SessionChatCommandReply, SessionChatPage } from '@elevenex/shared';
import { BackendClientService } from '../backend/backend-client.service';
import { SessionChatClient } from '../backend/session-chat-client.service';
import { SessionChatOutbox } from './session-chat-outbox';
import { previewChatState } from '../../../preview/session-chat-fixture';

const target = { scopeId: 'old', taskId: 1, sessionId: 2 };
const ok = <T>(value: T): BackendResult<T> => ({ ok: true, value });
const page = (): SessionChatPage => ({ taskId: 1, sessionId: 2, cursor: 'cursor', before: null, reset: true, items: [], events: [], state: previewChatState() });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
async function settle() { for (let index = 0; index < 40; index++) await Promise.resolve(); }
function setup() {
  const state = signal<BackendClientState>({ revision: 1, scope: null });
  const client = { read: vi.fn(async () => ok(page())), command: vi.fn(async (): Promise<BackendResult<SessionChatCommandReply>> => ok({ accepted: true })), cancel: vi.fn() };
  TestBed.configureTestingModule({ providers: [SessionChatOutbox, { provide: BackendClientService, useValue: { state } }, { provide: SessionChatClient, useValue: client }] });
  const outbox = TestBed.inject(SessionChatOutbox);
  const connect = async (scope = 'new') => { state.set({ revision: state().revision + 1, scope: { id: scope, environment: { kind: 'local' } } }); outbox.connect(scope); TestBed.tick(); await settle(); };
  return { outbox, client, state, connect };
}
afterEach(() => TestBed.resetTestingModule());

describe('Local waiting chat actions', () => {
  it('sends only never-dispatched writing after validating the conversation in the new scope', async () => {
    const { outbox, client, connect } = setup();
    outbox.enqueue(target, { type: 'send', text: 'hello', queue: false }, 'hello', null);
    TestBed.tick(); await settle(); expect(client.command).not.toHaveBeenCalled();
    await connect();
    expect(client.read).toHaveBeenCalledWith('new', expect.objectContaining({ taskId: 1, sessionId: 2 }));
    expect(client.command).toHaveBeenCalledExactlyOnceWith('new', expect.objectContaining({ action: { type: 'send', text: 'hello', queue: false } }));
    expect(outbox.items()).toEqual([]);
  });
  it('honors edits and removal while the recovery read is pending', async () => {
    const { outbox, client, connect } = setup();
    const read = deferred<BackendResult<SessionChatPage>>(); client.read.mockReturnValueOnce(read.promise);
    outbox.enqueue(target, { type: 'send', text: 'first', queue: false }, 'first', null);
    await connect(); const id = outbox.items()[0]!.id; outbox.edit(id, 'changed'); read.resolve(ok(page())); await settle();
    expect(client.command).toHaveBeenCalledWith('new', expect.objectContaining({ action: expect.objectContaining({ text: 'changed' }) }));
    const later = deferred<BackendResult<SessionChatPage>>(); client.read.mockReturnValueOnce(later.promise);
    outbox.enqueue(target, { type: 'send', text: 'remove me', queue: false }, 'remove me', null); TestBed.tick(); await settle();
    outbox.remove(outbox.items()[0]!.id); later.resolve(ok(page())); await settle(); expect(client.command).toHaveBeenCalledTimes(1);
  });
  it('retains an unknown result and blocks following writing in that conversation without replay', async () => {
    const { outbox, client, state, connect } = setup();
    const command = deferred<BackendResult<SessionChatCommandReply>>(); client.command.mockReturnValueOnce(command.promise);
    outbox.enqueue(target, { type: 'send', text: 'one', queue: false }, 'one', null);
    outbox.enqueue(target, { type: 'send', text: 'two', queue: false }, 'two', null);
    await connect(); state.set({ revision: 3, scope: null }); TestBed.tick();
    command.resolve({ ok: false, error: { code: 'stale-scope', message: 'Changed' } }); await settle();
    await connect('third'); expect(client.command).toHaveBeenCalledTimes(1);
    expect(outbox.items().map(item => item.status)).toEqual(['unknown', 'waiting']);
  });
  it('rejects expired approvals and stop requests for a different turn', async () => {
    const { outbox, client, connect } = setup();
    outbox.enqueue(target, { type: 'permission', id: 'old-approval', decision: 'approved' }, 'Approval', null);
    outbox.enqueue(target, { type: 'stop' }, 'Stop', 'previous-turn');
    await connect(); expect(client.command).not.toHaveBeenCalled(); expect(outbox.items().every(item => item.status === 'failed')).toBe(true);
  });
  it('bounds memory and never dispatches to a scope that disappears during the read', async () => {
    const { outbox, client, state, connect } = setup();
    for (let i = 0; i < 20; i++) expect(outbox.enqueue(target, { type: 'send', text: String(i), queue: false }, String(i), null)).toBe(true);
    expect(outbox.enqueue(target, { type: 'send', text: 'full', queue: false }, 'full', null)).toBe(false);
    const read = deferred<BackendResult<SessionChatPage>>(); client.read.mockReturnValueOnce(read.promise); await connect();
    state.set({ revision: 9, scope: null }); TestBed.tick(); read.resolve(ok(page())); await settle(); expect(client.command).not.toHaveBeenCalled();
  });
});

it('waits for the durable claim before sending and never sends after a journal failure', async () => {
  const claim = deferred<boolean>(), journalState = signal({ identity: 'machine', chat: [], tasks: [] });
  const connection = signal<BackendClientState>({ revision: 1, scope: null });
  const client = { read: vi.fn(async () => ok(page())), command: vi.fn(async () => ok({ accepted: true })), cancel: vi.fn() };
  const { WorkspaceWritingJournal } = await import('../workspace/workspace-writing-journal');
  const journal = { restored: journalState, saveChat: vi.fn((items: readonly { readonly status: string }[]) => items.some(item => item.status === 'sending') ? claim.promise : Promise.resolve(true)) };
  TestBed.configureTestingModule({ providers: [SessionChatOutbox, { provide: WorkspaceWritingJournal, useValue: journal }, { provide: BackendClientService, useValue: { state: connection } }, { provide: SessionChatClient, useValue: client }] });
  const box = TestBed.inject(SessionChatOutbox); TestBed.tick();
  box.enqueue(target, { type: 'send', text: 'keep', queue: false }, 'keep', null);
  connection.set({ revision: 2, scope: { id: 'new', environment: { kind: 'local' } } });
  box.connect('new'); TestBed.tick(); await settle(); expect(client.command).not.toHaveBeenCalled();
  claim.resolve(false); await settle(); expect(client.command).not.toHaveBeenCalled(); expect(box.items()[0]?.status).toBe('failed');
});


it('holds reconnect dispatch while a message is being edited, then sends the saved text', async () => {
  const { outbox, client, connect } = setup();
  const read = deferred<BackendResult<SessionChatPage>>(); client.read.mockReturnValueOnce(read.promise);
  outbox.enqueue(target, { type: 'send', text: 'original', queue: false }, 'original', null); await connect();
  const id = outbox.items()[0]!.id; outbox.setEditing(id); TestBed.tick(); read.resolve(ok(page())); await settle();
  expect(client.command).not.toHaveBeenCalled();
  outbox.edit(id, 'saved edit'); outbox.setEditing(null); TestBed.tick(); await settle();
  expect(client.command).toHaveBeenCalledExactlyOnceWith('new', expect.objectContaining({ action: expect.objectContaining({ text: 'saved edit' }) }));
});


it('respects a paused backend queue when delivering waiting writing after reconnect', async () => {
  const { outbox, client, connect } = setup();
  client.read.mockResolvedValueOnce(ok({ ...page(), state: { ...previewChatState(), queuePaused: true } }));
  outbox.enqueue(target, { type: 'send', text: 'wait for resume', queue: false }, 'wait for resume', null); await connect();
  expect(client.command).toHaveBeenCalledExactlyOnceWith('new', expect.objectContaining({ action: expect.objectContaining({ text: 'wait for resume', queue: true }) }));
});
