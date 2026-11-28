import { TestBed } from '@angular/core/testing';
import type { SavedWaitingChat, WaitingWritingSnapshot } from '@elevenex/shared';
import { ELEVENEX_BRIDGE } from '../backend/backend-client.service';
import { WorkspaceWritingJournal } from './workspace-writing-journal';
const item: SavedWaitingChat = { id: 'writing', taskId: 1, sessionId: 2, action: { type: 'send', text: 'Waiting', queue: false }, label: 'Waiting', turnId: null, status: 'waiting' };
afterEach(() => TestBed.resetTestingModule());
describe('Durable waiting writing', () => {
  it('restores undispatched writing and turns interrupted claims into uncertainty without replay', async () => {
    const bridge = { workspaceWaitingRead: vi.fn(async (): Promise<WaitingWritingSnapshot> => ({ identity: 'machine', chat: [item, { ...item, id: 'interrupted', status: 'sending' }], tasks: [] })), workspaceWaitingSave: vi.fn(async () => undefined) };
    TestBed.configureTestingModule({ providers: [WorkspaceWritingJournal, { provide: ELEVENEX_BRIDGE, useValue: bridge }] });
    const journal = TestBed.inject(WorkspaceWritingJournal); await journal.open({ kind: 'local' });
    expect(journal.restored()?.chat.map(item => item.status)).toEqual(['waiting', 'unknown']);
    expect(bridge.workspaceWaitingSave).not.toHaveBeenCalled();
    await journal.saveChat([]); expect(bridge.workspaceWaitingSave).toHaveBeenCalledWith({ kind: 'local' }, 'machine', { chat: [], tasks: [] });
  });
  it('dispatches saves immediately and reports failures rather than claiming durability', async () => {
    const bridge = { workspaceWaitingRead: vi.fn(async () => ({ identity: 'machine', chat: [], tasks: [] })), workspaceWaitingSave: vi.fn(async () => { throw new Error('Disk unavailable'); }) };
    TestBed.configureTestingModule({ providers: [WorkspaceWritingJournal, { provide: ELEVENEX_BRIDGE, useValue: bridge }] });
    const journal = TestBed.inject(WorkspaceWritingJournal); await journal.open({ kind: 'local' });
    const saved = journal.saveChat([item]); expect(bridge.workspaceWaitingSave).toHaveBeenCalledOnce();
    expect(await saved).toBe(false); expect(journal.error()).toContain('could not be saved');
  });
});
