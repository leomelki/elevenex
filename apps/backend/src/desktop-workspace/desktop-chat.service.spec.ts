import { SESSION_CHAT_TURN_WORK_MAX_LIMIT, serializeBrowserElements, type SessionChatStreamPage } from '@elevenex/shared';
import { DesktopChatAttachments } from './desktop-chat-attachments.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SettingsService } from '../settings/settings.service.js';
import { Test, type TestingModule } from '@nestjs/testing';
import { EventEmitter } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { AgentRuntimeRegistryService } from '../agent-runtime/agent-runtime-registry.service.js';
import { SessionsService } from '../sessions/sessions.service.js';
import type { AgentTranscriptItem } from '../agent-runtime/agent-runtime.types.js';
import { DesktopChatService } from './desktop-chat.service.js';
import { DesktopChatController } from './desktop-chat.controller.js';
import { createEdgeProxyServer } from '../proxy/edge-proxy.server.js';
import { ConversationExportService } from '../agent-runtime/conversation-export.service.js';
import { chatState, display } from './desktop-chat-projection.js';

jest.mock('../sessions/sessions.service.js', () => ({
  SessionsService: class SessionsService {},
}));

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
    info: { id: 'codex', displayName: 'Codex', permissionModes: ['default'], capabilities: { multimodalPrompts: true, rewindConversation: true } },
    getRuntimeState: jest.fn(),
    getHistory: jest.fn(),
    onClientAttached: jest.fn(),
    onClientDetached: jest.fn(),
    submitPrompt: jest.fn(),
    rewindConversation: jest.fn(),
    interrupt: jest.fn(),
    approvePermission: jest.fn(),
    answerUserInput: jest.fn(),
    setReasoningEffort: jest.fn(),
    setFastMode: jest.fn(),
    setSelectedModel: jest.fn(),
    stopBackgroundTask: jest.fn(),
    stopSubagent: jest.fn(),
  });
  const session = jest.fn();
  const started = jest.fn();
  const updateProvider = jest.fn();
  const advertised = jest.fn();
  const rememberAgentConfig = jest.fn();

  it('resends one saved prompt at its native anchor, retaining earlier history and attachment context', async () => {
    const original = { ...item('bubble', 'Original wording'), kind: 'user' as const, sourceMessageId: 'provider-anchor',
      images: [{ mediaType: 'image/png' as const, data: 'aW1hZ2U=' }] };
    const mention = '<elevenex_session_mention>\nSession: Triage\nSession ID: 5\n\nSaved context\n</elevenex_session_mention>';
    const initial = { ...item('first'), kind: 'user' as const, sourceMessageId: 'first-anchor' };
    history = [initial, item('answer'), { ...original, content: original.content + '\n\n' + mention },
      item('removed'), { ...item('later'), kind: 'user' }, item('later-answer')];
    runtime.getRuntimeState.mockResolvedValue({ runPhase: 'idle', liveItems: [] });
    runtime.rewindConversation.mockImplementationOnce(async () => { history = history.slice(0, 2); return history; });
    runtime.submitPrompt.mockImplementationOnce(async () => {
      history.push({ ...original, id: 'revised', content: 'Revised wording' });
    });
    const signal = new AbortController().signal;
    const before = (await chat.read(1, 2, undefined, undefined, signal))!;
    expect(before.items[2]).toMatchObject({ id: 'bubble', editable: true });
    expect(before.items[3].editable).toBeUndefined();
    const preview = (await chat.promptEdit(1, 2, 'bubble', signal))!;
    expect(preview).toMatchObject({ taskId: 1, sessionId: 2, itemId: 'bubble', text: 'Original wording', laterPrompts: 1, keepsContext: true });
    expect(JSON.stringify(preview)).not.toContain('Saved context');
    const action = { type: 'edit-prompt', itemId: 'bubble', text: 'Revised wording', revision: preview.revision };
    expect(await chat.command(1, 2, action)).toEqual({ accepted: true });
    expect(runtime.rewindConversation.mock.calls).toEqual([[2, 'provider-anchor']]);
    expect(runtime.submitPrompt.mock.calls).toEqual([[2, 'Revised wording\n\n' + mention, 'Revised wording',
      original.images, { human: true, queue: false, waitForCompletion: false }]]);
    const after = (await chat.read(1, 2, before.cursor, undefined, signal))!;
    expect(after.reset).toBe(true);
    expect(after.state.historyRewrite).toBeDefined();
    expect(after.items.map(item => item.id)).toEqual(['first', 'answer', 'revised']);
    await expect(chat.command(1, 2, action)).rejects.toThrow('no longer available');
    expect(runtime.submitPrompt).toHaveBeenCalledTimes(1);
  });

  it('rejects stale history, queued or running work, synthetic anchors, and archived sessions before mutation', async () => {
    const prompt = { ...item('prompt'), kind: 'user' as const, sourceMessageId: 'anchor' };
    history = [prompt, item('answer'), { ...prompt, id: 'synthetic', isSynthetic: true }];
    runtime.getRuntimeState.mockResolvedValue({ runPhase: 'idle' });
    const signal = new AbortController().signal;
    await expect(chat.promptEdit(1, 2, 'synthetic', signal)).rejects.toThrow('no longer available');
    const edit = (await chat.promptEdit(1, 2, 'prompt', signal))!;
    const action = { type: 'edit-prompt', itemId: edit.itemId, revision: edit.revision, text: 'Try again' };
    await expect(chat.command(1, 2, { ...action, text: edit.text })).rejects.toThrow('Change the message');
    history.push(item('A new reply'));
    await expect(chat.command(1, 2, action)).rejects.toThrow('conversation changed');
    history.pop();
    runtime.getRuntimeState.mockResolvedValueOnce({ runPhase: 'idle', pendingPrompts: [{ id: 'queued' }] });
    await expect(chat.command(1, 2, action)).rejects.toThrow('Resolve queued messages');
    runtime.getRuntimeState.mockResolvedValueOnce({ runPhase: 'waiting' });
    await expect(chat.command(1, 2, action)).rejects.toThrow('current turn');
    status = 'archived';
    await expect(chat.command(1, 2, action)).rejects.toThrow('read-only');
    await expect(chat.promptEdit(3, 2, 'prompt', signal)).rejects.toThrow('does not belong');
    expect(runtime.rewindConversation).not.toHaveBeenCalled();
    expect(runtime.submitPrompt).not.toHaveBeenCalled();
  });

  it('excludes concurrent writes and publishes a reset if the new send cannot be confirmed', async () => {
    history = [{ ...item('prompt'), kind: 'user', sourceMessageId: 'anchor' }, item('answer')];
    runtime.getRuntimeState.mockResolvedValue({ runPhase: 'idle', liveItems: [] });
    const signal = new AbortController().signal;
    const before = (await chat.read(1, 2, undefined, undefined, signal))!;
    const edit = (await chat.promptEdit(1, 2, 'prompt', signal))!;
    let started!: () => void, finish!: () => void;
    const rewinding = new Promise<void>(resolve => { started = resolve; });
    const hold = new Promise<void>(resolve => { finish = resolve; });
    runtime.rewindConversation.mockImplementationOnce(async () => { started(); await hold; history = []; return history; });
    runtime.submitPrompt.mockRejectedValueOnce(new Error('Transport interrupted'));
    const command = chat.command(1, 2, { type: 'edit-prompt', itemId: edit.itemId, revision: edit.revision, text: 'Revised' });
    await rewinding;
    await expect(chat.command(1, 2, { type: 'send', text: 'Concurrent', queue: false })).rejects.toThrow('action is in progress');
    const result = expect(command).rejects.toThrow('Could not confirm the edited message');
    finish();
    await result;
    expect(await chat.read(1, 2, before.cursor, undefined, signal)).toMatchObject({ reset: true, items: [] });
    expect(runtime.submitPrompt).toHaveBeenCalledTimes(1);
  });
  it('keeps legacy pages unchanged and validates opt-in bounded windows', async () => {
    history = Array.from({ length: 1000 }, (_, i) => ({ ...item(String(i)), content: `Message ${i}` }));
    const signal = new AbortController().signal;
    expect((await chat.read(1, 2, undefined, undefined, signal))!.items).toHaveLength(80);
    expect((await chat.read(1, 2, undefined, undefined, signal, undefined, 'window'))!.items).toHaveLength(320);
    expect((await chat.read(1, 2, undefined, undefined, signal, undefined, 'progressive'))!.items).toHaveLength(80);
    await expect(chat.read(1, 2, undefined, undefined, signal, undefined, 'all')).rejects.toThrow('Invalid conversation loading mode');
    await expect(chat.read(1, 2, undefined, undefined, signal, undefined, 'window', '1')).rejects.toThrow('Invalid completed turn view');
    await expect(chat.read(1, 2, undefined, undefined, signal, undefined, 'progressive', undefined, '1', '1')).rejects.toThrow('Invalid recent turn view');
  });

  it('sends only tool headings in opted-in history and resolves the exact paired evidence', async () => {
    const command = 'pnpm test\n' + 'private command body'.repeat(100);
    const output = 'private output'.repeat(1400);
    history = [
      { ...item('prompt'), kind: 'user' },
      { ...item('call', ''), kind: 'tool_use', toolUseId: 'operation', toolKind: 'bash', toolInput: { command, cwd: '/workspace' } },
      { ...item('result', output), kind: 'tool_result', toolUseId: 'operation', providerToolResult: { exitCode: 2 } },
      item('reply'),
    ];
    const signal = new AbortController().signal;
    const inline = (await chat.read(1, 2, undefined, undefined, signal, undefined, 'window'))!;
    expect(inline.items[1].input).toContain('private command body');
    expect(inline.items[2].text).toContain('private output');
    const detail = (await chat.read(1, 2, undefined, undefined, signal, undefined, 'window', undefined, '1'))!;
    expect(JSON.stringify(detail.items)).not.toMatch(/private (command|output)|\/workspace/);
    const [, call, result] = detail.items;
    expect(call).toMatchObject({ id: 'call', text: '', input: '', toolDetails: { summary: 'pnpm test' } });
    expect(result).toMatchObject({ id: 'result', text: '', input: '', error: true, toolDetails: { meta: 'Exit 2' } });
    const source = { item: { id: call.id, revision: call.toolDetails!.revision },
      result: { id: result.id, revision: result.toolDetails!.revision } };
    expect(await chat.readToolDetails(1, 2, source, signal)).toMatchObject({
      taskId: 1, sessionId: 2,
      item: { ...source.item, record: { input: inline.items[1].input } },
      result: { ...source.result, record: { text: inline.items[2].text, truncated: true, error: true } },
    });
    expect(runtime.getHistory).toHaveBeenCalledTimes(2);
    await expect(chat.readToolDetails(9, 2, source, signal)).rejects.toThrow('does not belong');
    await expect(chat.readToolDetails(1, 2, { item: source.result, result: source.item }, signal)).rejects.toThrow('has changed');
    await expect(chat.readToolDetails(1, 2, { item: { id: 'call', revision: 'invalid' } }, signal)).rejects.toThrow('Invalid tool details');
    expect(await chat.readToolDetails(1, 2, source, AbortSignal.abort())).toBeUndefined();
  });

  it('keeps the latest tool evidence available without rereading history after a large window', async () => {
    history = [
      { ...item('prompt'), kind: 'user' },
      ...Array.from({ length: 125 }, (_, index): AgentTranscriptItem[] => [
        { ...item(`call-${index}`, ''), kind: 'tool_use', toolKind: 'read', toolUseId: `read-${index}`, toolInput: { path: `file-${index}.txt` } },
        { ...item(`result-${index}`, `output ${index}\n`.repeat(2000)), kind: 'tool_result', toolUseId: `read-${index}` },
      ]).flat(),
      item('answer'),
    ];
    const signal = new AbortController().signal;
    const page = (await chat.read(1, 2, undefined, undefined, signal, undefined, 'window', undefined, '1'))!;
    const [call, result] = page.items.slice(-3, -1);
    expect(await chat.readToolDetails(1, 2, {
      item: { id: call.id, revision: call.toolDetails!.revision },
      result: { id: result.id, revision: result.toolDetails!.revision },
    }, signal)).toMatchObject({ result: { record: { text: expect.stringContaining('output 124') } } });
    expect(runtime.getHistory).toHaveBeenCalledTimes(1);
  });

  it('summarizes small recent turns for the new reader while preserving the legacy inline option', async () => {
    status = 'archived';
    history = [
      { ...item('prompt'), kind: 'user' },
      { ...item('call', ''), kind: 'tool_use', toolKind: 'read', toolUseId: 'operation', toolInput: { path: 'file.txt' } },
      { ...item('result', 'large hidden output\n'.repeat(2000)), kind: 'tool_result', toolUseId: 'operation' },
      item('answer'),
    ];
    const signal = new AbortController().signal;
    const legacy = (await chat.read(1, 2, undefined, undefined, signal, undefined, 'progressive', '1'))!;
    expect(legacy.items[0].completedTurn?.total).toBe(2);
    const compact = (await chat.read(1, 2, undefined, undefined, signal, undefined, 'progressive', '1', '1'))!;
    expect(compact.items.map(item => item.id)).toEqual(['prompt', 'call', 'result', 'answer']);
    expect(compact.items[2]).toMatchObject({ text: '', toolDetails: { revision: expect.any(String) } });
    const summarized = (await chat.read(1, 2, undefined, undefined, signal, undefined, 'progressive', '1', '1', '1'))!;
    expect(summarized.items.map(item => item.id)).toEqual(['prompt']);
    expect(summarized.items[0].completedTurn).toMatchObject({
      total: 2, beforeReply: 2, counts: { read: 1 }, reply: [{ id: 'answer' }],
    });
    expect(JSON.stringify(summarized.items)).not.toMatch(/file\.txt|large hidden output/);
  });

  it('uses the matching command context when a receipt was cached on its own page', async () => {
    status = 'archived';
    history = [
      { ...item('prompt'), kind: 'user' },
      { ...item('call', ''), kind: 'tool_use', toolKind: 'bash', toolUseId: 'operation', toolInput: { command: 'pnpm test', cwd: '/workspace' } },
      ...Array.from({ length: 650 }, (_, index) => item(`note-${index}`)),
      { ...item('result', 'Test failed'), kind: 'tool_result', toolUseId: 'operation', providerToolResult: { exitCode: 1 } },
      item('answer'),
    ];
    const signal = new AbortController().signal;
    const latest = (await chat.read(1, 2, undefined, undefined, signal, undefined, 'window', undefined, '1'))!;
    const result = latest.items.find(row => row.id === 'result')!;
    expect(latest.items.some(row => row.id === 'call')).toBe(false);
    expect(result).toMatchObject({
      error: true,
      toolDetails: { meta: 'Exit 1' },
      invocation: { id: 'call', toolKind: 'bash', toolDetails: { summary: 'pnpm test' } },
    });
    const older = (await chat.read(1, 2, undefined, 'note-0', signal, undefined, 'progressive', undefined, '1'))!;
    const call = older.items.find(row => row.id === 'call')!;
    expect(call.receipt).toEqual({ id: result.id, error: true, toolDetails: result.toolDetails });
    expect(result.invocation?.toolDetails).toEqual(call.toolDetails);
    expect(older.items.some(row => row.id === result.id)).toBe(false);
    expect(await chat.readToolDetails(1, 2, {
      item: { id: call.id, revision: call.toolDetails!.revision },
      result: { id: result.id, revision: result.toolDetails!.revision },
    }, signal)).toMatchObject({ result: { record: { error: true, execution: { exitCode: 1, cwd: '/workspace' } } } });
  });

  it('resolves a result beyond the first activity page and rejects rewritten evidence after cache invalidation', async () => {
    status = 'archived';
    history = [
      { ...item('prompt'), kind: 'user' },
      { ...item('call', ''), kind: 'tool_use', toolKind: 'read', toolUseId: 'operation', toolInput: { file_path: 'important.ts' } },
      ...Array.from({ length: 103 }, (_, index): AgentTranscriptItem => ({ ...item(`thought-${index}`), kind: 'thinking' })),
      { ...item('result', 'Partial file contents'), kind: 'tool_result', toolUseId: 'operation' },
      { ...item('result', 'Important file contents'), kind: 'tool_result', toolUseId: 'operation' },
      item('answer'),
    ];
    const signal = new AbortController().signal;
    const initial = (await chat.read(1, 2, undefined, undefined, signal, undefined, 'progressive', '1', '1'))!;
    const version = initial.items[0].completedTurn!.revision;
    const complete = (await chat.turnWork(1, 2, 'prompt', version, 0, signal, '1', SESSION_CHAT_TURN_WORK_MAX_LIMIT))!;
    expect(complete).toMatchObject({ total: 105, offset: 0, nextOffset: null });
    expect(complete.items.map(row => row.id)).toEqual([...new Set(history.slice(1, -1).map(row => row.id))]);
    expect(JSON.stringify(complete.items)).not.toContain('Important file contents');
    await expect(chat.turnWork(1, 2, 'prompt', version, 0, signal, undefined, 512)).rejects.toThrow('Invalid turn activity limit');
    await expect(chat.turnWork(1, 2, 'prompt', version, 0, signal, '1', SESSION_CHAT_TURN_WORK_MAX_LIMIT + 1)).rejects.toThrow('Invalid turn activity limit');

    const page = (await chat.turnWork(1, 2, 'prompt', version, 0, signal, '1'))!;
    const call = page.items[0];
    const receipt = call.receipt!;
    expect(call).toMatchObject({ id: 'call', input: '', toolDetails: { summary: 'important.ts' }, receipt: { id: 'result' } });
    expect(page.items.some(row => row.id === receipt.id)).toBe(false);
    expect(page.nextOffset).toBe(40);
    const last = (await chat.turnWork(1, 2, 'prompt', version, 80, signal, '1'))!;
    expect(last.items.find(row => row.id === receipt.id)?.invocation)
      .toEqual({ id: call.id, toolKind: 'read', toolDetails: call.toolDetails });
    const source = { item: { id: call.id, revision: call.toolDetails!.revision },
      result: { id: receipt.id, revision: receipt.toolDetails!.revision } };
    expect(await chat.readToolDetails(1, 2, source, signal)).toMatchObject({
      result: { record: { text: 'Important file contents' } },
    });
    runtime.emit('event', { type: 'history_snapshot', payload: { sessionId: 2 } });
    // The same addresses work after the hot window has been invalidated.
    expect(await chat.readToolDetails(1, 2, source, signal)).toMatchObject({ result: { record: { text: 'Important file contents' } } });
    history[history.length - 2] = { ...history[history.length - 2], content: 'Rewritten file contents' };
    runtime.emit('event', { type: 'history_snapshot', payload: { sessionId: 2 } });
    await expect(chat.readToolDetails(1, 2, source, signal)).rejects.toThrow('has changed');
    expect(runtime.getRuntimeState).not.toHaveBeenCalled();
  });

  it('publishes fresh detail references when a compact live result changes', async () => {
    live = [
      { ...item('call', ''), kind: 'tool_use', toolKind: 'bash', toolUseId: 'operation', toolInput: { command: 'pnpm test' } },
      { ...item('result', 'Partial result'), kind: 'tool_result', toolUseId: 'operation' },
    ];
    const signal = new AbortController().signal;
    const page = (await chat.read(1, 2, undefined, undefined, signal, undefined, 'window', undefined, '1'))!;
    live = [live[0], { ...live[1], content: 'Complete result' }];
    runtime.emit('event', { type: 'transcript_item', payload: { sessionId: 2 } });
    const update = (await chat.read(1, 2, page.cursor, undefined, signal, undefined, 'window', undefined, '1'))!;
    expect(update.events).toHaveLength(2);
    const result = update.events.find(event => event.item.id === 'result')!.item;
    expect(result).toMatchObject({ id: 'result', text: '', input: '' });
    expect(result.toolDetails!.revision).not.toBe(page.items[1].toolDetails!.revision);
    expect(update.events.find(event => event.item.id === 'call')?.item.receipt?.toolDetails).toEqual(result.toolDetails);
    expect(await chat.readToolDetails(1, 2, { item: { id: 'result', revision: result.toolDetails!.revision } }, signal))
      .toMatchObject({ item: { record: { text: 'Complete result' } } });
    live = [live[0], { ...live[1], providerToolResult: { exitCode: 1 } }];
    runtime.emit('event', { type: 'transcript_item', payload: { sessionId: 2 } });
    const changed = (await chat.read(1, 2, update.cursor, undefined, signal, undefined, 'window', undefined, '1'))!;
    const failed = changed.events.find(event => event.item.id === 'result')!.item;
    expect(failed).toMatchObject({ error: true, toolDetails: { meta: 'Exit 1' } });
    expect(failed.toolDetails!.revision).not.toBe(result.toolDetails!.revision);
  });

  it('keeps a live receipt actionable when the call has left the progressive window', async () => {
    live = [
      { ...item('call', ''), kind: 'tool_use', toolKind: 'bash', toolInput: { command: 'pnpm test' } },
      ...Array.from({ length: 190 }, (_, index) => item(`progress-${index}`)),
    ];
    const signal = new AbortController().signal;
    const initial = (await chat.read(1, 2, undefined, undefined, signal, undefined, 'progressive', '1', '1'))!;
    expect(initial.items.some(row => row.id === 'call')).toBe(false);
    live = [...live, { ...item('result', 'Completed tests'), kind: 'tool_result', toolUseId: 'call' }];
    runtime.emit('event', { type: 'transcript_item', payload: { sessionId: 2 } });
    const update = (await chat.read(1, 2, initial.cursor, undefined, signal, undefined, 'progressive', '1', '1'))!;
    expect(update.events.map(event => event.item.id)).toEqual(['result']);
    const { invocation, toolDetails } = update.events[0].item;
    expect(invocation).toMatchObject({ id: 'call', toolDetails: { summary: 'pnpm test' } });
    expect(await chat.readToolDetails(1, 2, {
      item: { id: invocation!.id, revision: invocation!.toolDetails.revision },
      result: { id: 'result', revision: toolDetails!.revision },
    }, signal)).toMatchObject({ result: { record: { text: 'Completed tests' } } });
    expect(runtime.getHistory).toHaveBeenCalledTimes(1);
  });

  it('reads exact saved activity for a task-owned version, including archived sessions and cancelled reads', async () => {
    status = 'archived';
    history = [
      { ...item('prompt'), kind: 'user' },
      { ...item('thought-0', ''), kind: 'thinking' },
      ...Array.from({ length: 60 }, (_, index): AgentTranscriptItem => ({ ...item(`thought-${index}`), kind: 'thinking' })),
      item('answer'),
    ];
    const signal = new AbortController().signal;
    const open = (await chat.read(1, 2, undefined, undefined, signal, undefined, 'progressive', '1'))!;
    const saved = open.items[0].completedTurn!;
    expect(saved.total).toBe(60);
    expect((await chat.read(1, 2, undefined, undefined, signal))!.items.some(item => item.completedTurn)).toBe(false);
    const page = (await chat.turnWork(1, 2, 'prompt', saved.revision, 40, signal))!;
    expect(page).toMatchObject({ taskId: 1, sessionId: 2, turnId: 'prompt', offset: 40, total: 60, nextOffset: null });
    expect(page.items[0].id).toBe('thought-40');
    await expect(chat.turnWork(5, 2, 'prompt', saved.revision, 0, signal)).rejects.toThrow('does not belong');
    await expect(chat.turnWork(1, 2, 'answer', saved.revision, 0, signal)).rejects.toThrow('activity has changed');
    await expect(chat.turnWork(1, 2, 'prompt', saved.revision, NaN, signal)).rejects.toThrow('Invalid turn activity');
    expect(await chat.turnWork(1, 2, 'prompt', saved.revision, 0, AbortSignal.abort())).toBeUndefined();
    history[2] = { ...history[2], content: 'Rewritten evidence' };
    await expect(chat.turnWork(1, 2, 'prompt', saved.revision, 0, signal)).rejects.toThrow('activity has changed');
    expect(runtime.getRuntimeState).not.toHaveBeenCalled();
  });

  it('retains the streamed timeline at completion and compacts independent fresh openings', async () => {
    const prompt: AgentTranscriptItem = { ...item('prompt'), kind: 'user' };
    live = [prompt, ...Array.from({ length: 60 }, (_, index): AgentTranscriptItem => ({
      ...item(`tool-${index}`), kind: 'tool_use', toolKind: 'read',
    }))];
    const signal = new AbortController().signal;
    const initial = (await chat.read(1, 2, undefined, undefined, signal, undefined, 'progressive', '1'))!;
    expect(initial.items[0].id).toBe(prompt.id);
    history = [...live, item('answer')];
    live = [];
    runtime.getRuntimeState.mockResolvedValue({ runPhase: 'idle', liveItems: [] });
    runtime.emit('event', { type: 'run_state', payload: { sessionId: 2, runPhase: 'idle' } });
    const completion = (await chat.read(1, 2, initial.cursor, undefined, signal, undefined, 'progressive', '1'))!;
    expect(completion.items.map(item => item.id)).toEqual(history.map(item => item.id));
    const fresh = (await chat.read(1, 2, undefined, undefined, signal, undefined, 'progressive', '1'))!;
    expect(fresh.items[0].completedTurn?.reply[0].id).toBe('answer');
  });

  it('resolves compact saved tool evidence within the exact turn and revision', async () => {
    status = 'archived';
    const call = { ...item('command', ''), kind: 'tool_use' as const, toolKind: 'bash', toolInput: { command: 'pnpm test' } };
    const result = { ...item('receipt', 'full output'), kind: 'tool_result' as const, toolUseId: call.id };
    const prompt = { ...item('prompt'), kind: 'user' as const };
    history = [prompt, call, item('answer'), result, { ...prompt, id: 'other' }, { ...result, id: 'other-result' }];
    const signal = new AbortController().signal;
    const first = (await chat.read(1, 2, undefined, undefined, signal, undefined, 'progressive', '1', '1', '1'))!;
    const revision = first.items.find(row => row.id === prompt.id)!.completedTurn!.revision;
    const compact = await chat.turnWork(1, 2, prompt.id, revision, 0, signal, '1', 512, '1');
    expect(compact).toMatchObject({ timeline: [{ kind: 'call', id: call.id, resultId: result.id, label: 'pnpm test' }, null] });
    const source = { turnId: prompt.id, item: { id: call.id, revision }, result: { id: result.id, revision } };
    expect(await chat.readToolDetails(1, 2, source, signal)).toMatchObject({ turnId: prompt.id,
      item: { id: call.id, revision, record: { input: expect.stringContaining('pnpm test') } },
      result: { id: result.id, revision, record: { text: 'full output' } },
    });
    await expect(chat.readToolDetails(1, 2, { ...source, turnId: 'other' }, signal)).rejects.toThrow('changed');
    await expect(chat.readToolDetails(1, 2, { ...source, result: { id: 'other-result', revision } }, signal)).rejects.toThrow('changed');
    await expect(chat.turnWork(1, 2, prompt.id, revision, 0, signal, undefined, 40, '1')).rejects.toThrow('format');
    history[3] = { ...result, content: 'different output' };
    runtime.emit('event', { type: 'history_snapshot', payload: { sessionId: 2 } });
    await expect(chat.readToolDetails(1, 2, source, signal)).rejects.toThrow('changed');
    expect(runtime.getRuntimeState).not.toHaveBeenCalled();
  });

  it('shares hydration across a slow-open replacement and discards the cancelled response', async () => {
    let release!: (items: AgentTranscriptItem[]) => void;
    runtime.getHistory.mockImplementationOnce(() => new Promise<AgentTranscriptItem[]>(resolve => { release = resolve; }));
    const original = new AbortController();
    const first = chat.read(1, 2, undefined, undefined, original.signal, undefined, 'window');
    await settle(); original.abort();
    const replacement = chat.read(1, 2, undefined, undefined, new AbortController().signal, undefined, 'progressive');
    await settle();
    expect(runtime.getHistory).toHaveBeenCalledTimes(1);
    release([item('latest')]);
    expect(await first).toBeUndefined();
    expect((await replacement)!.items.at(-1)!.id).toBe('latest');
  });

  it('also discards cancelled archived-session hydration without attaching its runtime', async () => {
    status = 'archived';
    let release!: (items: AgentTranscriptItem[]) => void;
    runtime.getHistory.mockImplementationOnce(() => new Promise<AgentTranscriptItem[]>(resolve => { release = resolve; }));
    const controller = new AbortController();
    const pending = chat.read(1, 2, undefined, undefined, controller.signal, undefined, 'window');
    await settle(); controller.abort(); release([item('latest')]);
    expect(await pending).toBeUndefined();
    expect(runtime.getRuntimeState).not.toHaveBeenCalled();
    expect(runtime.onClientAttached).not.toHaveBeenCalled();
  });

  it('pages a long archived session with bounded cursor and prompt lookups', async () => {
    status = 'archived';
    let reads = 0;
    history = new Proxy(Array.from({ length: 10_000 }, (_, i) => item(String(i))), {
      get(target, property, receiver) {
        if (typeof property === 'string' && /^\d+$/.test(property)) reads++;
        return Reflect.get(target, property, receiver);
      },
    });
    history[0] = { ...history[0], kind: 'user' };
    const latest = (await chat.read(1, 2, undefined, undefined, new AbortController().signal))!;
    expect(latest.items[0]?.id).toBe('9920');
    reads = 0;
    const older = (await chat.read(1, 2, undefined, latest.before!, new AbortController().signal))!;
    expect(older.items[0]?.id).toBe('9840');
    expect(older.leadingPrompt?.id).toBe('0');
    expect(reads).toBeLessThan(320);
    expect(runtime.getRuntimeState).not.toHaveBeenCalled();
    expect(runtime.onClientAttached).not.toHaveBeenCalled();
  });

  it('serves a held poll from saved history if the session is archived while waiting', async () => {
    history = [item('saved')];
    const latest = (await read())!;
    const waiting = read(latest.cursor);
    await settle();
    status = 'archived';
    expect((await read())!.items.map(row => row.id)).toEqual(['saved']);
    expect((await waiting)!.items.map(row => row.id)).toEqual(['saved']);
    expect(runtime.getRuntimeState).toHaveBeenCalledTimes(1);
    expect(runtime.onClientDetached).toHaveBeenCalledWith(2);
  });
  it('does not pair a new completion marker with an older in-flight history read', async () => {
    let finish!: (items: AgentTranscriptItem[]) => void;
    runtime.getHistory.mockImplementationOnce(() => new Promise<AgentTranscriptItem[]>(resolve => { finish = resolve; }));
    const old = chat.read(1, 2, undefined, undefined, new AbortController().signal);
    await settle();
    const at = '2026-11-14T12:00:00.000Z';
    session.mockResolvedValue({ workspaceId: 1, surface: 'session', status: 'active', activeAgentProvider: 'codex', hasUnreviewedCompletion: true, lastCompletionAt: at });
    module.get(SessionsService).emit('session-completion-changed', { sessionId: 2, hasUnreviewedCompletion: true });
    history = [item('new-final', 'New final reply')];
    const current = await chat.read(1, 2, undefined, undefined, new AbortController().signal);
    expect(current!.state.unseenCompletionAt).toBe(at);
    expect(current!.items.some(item => item.text === 'New final reply')).toBe(true);
    finish([]); await old;
  });
  it('confines seen acknowledgments to the task and completion, without starting a runtime', async () => {
    const sessions = module.get(SessionsService);
    const at = '2026-11-14T12:00:00.000Z';
    await expect(chat.command(9, 2, { type: 'mark-seen', completionAt: at })).rejects.toThrow('does not belong');
    for (const completionAt of [undefined, null, '', 'yesterday', 'x'.repeat(100)])
      await expect(chat.command(1, 2, { type: 'mark-seen', completionAt })).rejects.toThrow('Invalid completion');
    await expect(chat.command(1, 2, { type: 'mark-seen', completionAt: at })).resolves.toEqual({ accepted: true });
    expect(sessions.markCompletionReviewed).toHaveBeenCalledWith(2, at);
    expect(runtime.getRuntimeState).not.toHaveBeenCalled();
    expect(runtime.submitPrompt).not.toHaveBeenCalled();
  });
  it('wakes a selected feed on completion changes and releases its listener', async () => {
    const sessions = module.get(SessionsService);
    const at = '2026-11-14T12:00:00.000Z';
    const first = await chat.read(1, 2, undefined, undefined, new AbortController().signal);
    expect(sessions.listenerCount('session-completion-changed')).toBe(1);
    const pending = chat.read(1, 2, first!.cursor, undefined, new AbortController().signal);
    await settle();
    session.mockResolvedValue({ workspaceId: 1, surface: 'session', status: 'active', activeAgentProvider: 'codex', hasUnreviewedCompletion: true, lastCompletionAt: at });
    sessions.emit('session-completion-changed', { sessionId: 2, hasUnreviewedCompletion: true });
    expect((await pending)!.state.unseenCompletionAt).toBe(at);
    expect(runtime.getHistory).toHaveBeenCalledTimes(2);
    chat.onModuleDestroy();
    expect(sessions.listenerCount('session-completion-changed')).toBe(0);
  });
  it('only serves image references belonging to the requested task and transcript item', async () => {
    history = [{ ...item('image'), providerToolResult: [{ type: 'output_image', image_url: 'data:image/png;base64,iVBORw0KGgo=' }] }];
    await expect(chat.media(1, 2, 'image', '0')).resolves.toMatchObject({ itemId: 'image', mediaId: '0' });
    await expect(chat.media(9, 2, 'image', '0')).rejects.toThrow('does not belong');
    await expect(chat.media(1, 2, 'missing', '0')).rejects.toThrow('no longer available');
    await expect(chat.media(1, 2, 'image', '1')).rejects.toThrow('no longer available');
    await expect(chat.media(1, 2, 'image', '../secret')).rejects.toThrow('Invalid image');
  });
  beforeEach(async () => {
    history = [];
    live = [];
    status = 'active';
    jest.clearAllMocks();
    rememberAgentConfig.mockReset().mockResolvedValue(undefined);
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
      worktreePath: '/workspace',
      surface: 'session',
      status,
      activeAgentProvider: 'codex',
      workspaceArchivedAt: null,
    }));
    module = await Test.createTestingModule({
      controllers: [DesktopChatController],
      providers: [
        DesktopChatService,
        { provide: DesktopChatAttachments, useValue: {} },
        { provide: ConversationExportService, useValue: { buildMention: jest.fn() } },
        {
          provide: SettingsService,
          useValue: { rememberAgentConfig, getAgentModelPresets: () => [], getAgentPresetDefault: () => ({ id: null, provider: 'codex', defaultIds: [], revision: 'a'.repeat(64) }) },
        },
        {
          provide: SessionsService,
          useValue: Object.assign(new EventEmitter(), {
            findOne: session,
            markCompletionReviewed: jest.fn(),
            hasStartedAgentRuntime: started,
            updateActiveAgentProvider: updateProvider,
            assertSessionWorkspaceLinked: jest.fn(),
            reactivateRuntime: jest.fn(),
          }),
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
  it('serves exclusive forward pages without changing legacy tails or feed projections', async () => {
    history = Array.from({ length: 1000 }, (_, i) => item(String(i)));
    const signal = new AbortController().signal;
    const forward = await chat.read(1, 2, undefined, undefined, signal, '39');
    expect(forward).toMatchObject({ reset: false, next: '119', events: [] });
    expect(forward!.items[0]!.id).toBe('40'); expect(forward!.items).toHaveLength(80);
    const tail = await chat.read(1, 2, undefined, undefined, signal);
    expect(tail!.next).toBeNull(); expect(tail!.items.at(-1)!.id).toBe('999');
    await expect(chat.read(1, 2, undefined, '20', signal, '39')).rejects.toThrow('Invalid conversation cursor');
    await expect(chat.read(1, 2, undefined, undefined, signal, 'missing')).rejects.toThrow('History cursor expired');
    status = 'archived';
    const archived = await chat.read(1, 2, undefined, undefined, signal, '39');
    expect(archived!.items[0]!.id).toBe('40'); expect(archived!.next).toBe('119');
  });


  it('stops only background work the runtime still reports as live and projects it for the bar', async () => {
    runtime.getRuntimeState.mockImplementation(async () => ({
      sessionId: 2,
      runPhase: 'idle',
      liveItems: [],
      backgroundWork: [
        { id: 'task:shell', kind: 'task', label: 'pnpm test --watch', startedAt: '2026-11-10T10:00:00Z' },
        { id: 'subagent:child', kind: 'subagent', label: 'reviewer', startedAt: '2026-11-10T10:01:00Z' },
      ],
      tasks: [{ taskId: 'shell', status: 'running', canStop: true }],
      subagents: [{ agentId: 'child', agentType: 'reviewer', status: 'started', canStop: false }],
      hooks: [{ hookId: 'h1', hookName: 'PreToolUse:Bash', hookEvent: 'PreToolUse', status: 'success', updatedAt: '2026-11-10T10:02:00Z' }],
    }));
    const page = await chat.read(1, 2, undefined, undefined, new AbortController().signal);
    expect(page?.state.work).toEqual({
      totalRunning: 2,
      running: [
        expect.objectContaining({ id: 'task:shell', kind: 'task', stoppable: true }),
        expect.objectContaining({ id: 'subagent:child', kind: 'agent', stoppable: false }),
      ],
      recent: [],
    });
    expect(page?.state.activity.map((entry) => entry.id)).toEqual(['task:shell', 'subagent:child']);

    await chat.command(1, 2, { type: 'stop-background', id: 'task:shell' });
    expect(runtime.stopBackgroundTask).toHaveBeenCalledWith(2, 'shell');
    await chat.command(1, 2, { type: 'stop-background', id: 'subagent:child' });
    expect(runtime.stopSubagent).toHaveBeenCalledWith(2, 'child');
    await expect(chat.command(1, 2, { type: 'stop-background', id: 'task:gone' })).rejects.toThrow('already finished');
    expect(runtime.stopBackgroundTask).toHaveBeenCalledTimes(1);
    expect(runtime.interrupt).not.toHaveBeenCalled();
  });

  it('delivers uploaded image bytes in the native image slot and retains file references in the prompt', async () => {
    const root = await mkdtemp(join(tmpdir(), 'chat-native-image-'));
    const previous = process.env.ELEVENEX_DATA_ROOT;
    process.env.ELEVENEX_DATA_ROOT = root;
    const attachments = new DesktopChatAttachments();
    try {
      const data = 'iVBORw0KGgo=';
      const upload = await attachments.chunk(2, { id: '11111111-1111-4111-8111-111111111111', name: 'reference.png', size: 8, offset: 0, data });
      const text = `Review this image.\n\n[reference.png](<${upload.path}>)`;
      await chat.command(1, 2, { type: 'send', text, queue: false });
      expect(runtime.submitPrompt).toHaveBeenCalledWith(2, text, undefined, [{ mediaType: 'image/png', data }], { human: true, queue: false, waitForCompletion: false });
    } finally {
      await attachments.onModuleDestroy();
      if (previous === undefined) delete process.env.ELEVENEX_DATA_ROOT; else process.env.ELEVENEX_DATA_ROOT = previous;
      await rm(root, { recursive: true, force: true });
    }
  });

  it('delivers element text and native image with their exact association through queued sending', async () => {
    const root = await mkdtemp(join(tmpdir(), 'chat-element-image-'));
    const previous = process.env.ELEVENEX_DATA_ROOT; process.env.ELEVENEX_DATA_ROOT = root;
    const attachments = new DesktopChatAttachments();
    const reference = { version: 1 as const, id: '11111111-1111-4111-8111-111111111111', label: 'button · Save', tag: 'button', selector: 'button', frames: [], page: 'https://example.com/checkout', tabId: 'tab-1', documentId: 'document-1', capturedAt: '2026-11-09T10:00:00Z', target: { x: 20, y: 30, width: 80, height: 30 }, crop: { x: 0, y: 0, width: 148, height: 108 }, image: { width: 148, height: 108, scale: 1 } };
    try {
      const data = 'iVBORw0KGgo=';
      const upload = await attachments.chunk(2, { id: reference.id, name: 'element.jpg', size: 8, offset: 0, data });
      const envelope = serializeBrowserElements([{ reference, marker: 1, attachment: 'element.jpg', imageIndex: 1 }]);
      const text = `Align ❶.\n\n${envelope}\n\n[element.jpg](<${upload.path}>)`;
      await chat.command(1, 2, { type: 'send', text, queue: true });
      expect(runtime.submitPrompt).toHaveBeenCalledWith(2, text, undefined, [{ mediaType: 'image/png', data }], { human: true, queue: true, waitForCompletion: false });
      runtime.submitPrompt.mockClear();
      await expect(chat.command(1, 2, { type: 'send', text: envelope, queue: false })).rejects.toThrow('missing');
      expect(runtime.submitPrompt).not.toHaveBeenCalled();
    } finally {
      await attachments.onModuleDestroy();
      if (previous === undefined) delete process.env.ELEVENEX_DATA_ROOT; else process.env.ELEVENEX_DATA_ROOT = previous;
      await rm(root, { recursive: true, force: true });
    }
  });

  it('remembers successful config changes and sends, but never rejected commands or passive reads', async () => {
    runtime.getRuntimeState.mockResolvedValue({ selectedModel: 'gpt', reasoningEffort: 'high', fastMode: true });
    await read();
    expect(rememberAgentConfig).not.toHaveBeenCalled();
    await chat.command(1, 2, { type: 'fast', enabled: false });
    expect(rememberAgentConfig).toHaveBeenCalledWith({ provider: 'codex', model: 'gpt', reasoningEffort: 'high', fastMode: true });
    rememberAgentConfig.mockClear();
    await chat.command(1, 2, { type: 'send', text: 'Hello', queue: false });
    expect(rememberAgentConfig).toHaveBeenCalledTimes(1);
    rememberAgentConfig.mockClear();
    await expect(chat.command(1, 2, { type: 'reasoning', effort: 'invalid' })).rejects.toThrow('Unsupported thinking');
    expect(rememberAgentConfig).not.toHaveBeenCalled();
  });

  it('resolves session context for queued sends and never submits a prompt if a reference cannot be resolved', async () => {
    const buildMention = jest.spyOn(module.get(ConversationExportService), 'buildMention');
    buildMention.mockResolvedValue({ sessionId: 12, title: 'Other work', provider: 'codex', providerSessionId: null,
      branch: 'main', status: 'done', transcriptExportPath: '/tmp/export.md', contextMarkdown: 'Context from other work', omittedTurns: 0, generatedAt: '' });
    await chat.command(1, 2, { type: 'send', text: 'Compare @Other work', queue: true, sessionIds: [12] });
    expect(runtime.submitPrompt).toHaveBeenCalledWith(2, expect.stringContaining('Context from other work'), undefined, undefined,
      { human: true, queue: true, waitForCompletion: false });
    runtime.submitPrompt.mockClear();
    buildMention.mockRejectedValueOnce(new Error('Session was removed'));
    await expect(chat.command(1, 2, { type: 'send', text: 'Compare', queue: false, sessionIds: [12] })).rejects.toThrow('Session was removed');
    expect(runtime.submitPrompt).not.toHaveBeenCalled();
  });

  it('does not report an accepted prompt as failed if remembering the fallback fails', async () => {
    rememberAgentConfig.mockRejectedValueOnce(new Error('Database unavailable'));
    await expect(chat.command(1, 2, { type: 'send', text: 'Hello', queue: false })).resolves.toEqual({ accepted: true });
    expect(runtime.submitPrompt).toHaveBeenCalledTimes(1);
    expect(runtime.submitPrompt).toHaveBeenCalledWith(2, 'Hello', undefined, undefined,
      { human: true, queue: false, waitForCompletion: false });
  });

  it('remembers a fully applied preset and leaves the fallback alone on partial failure', async () => {
    jest.spyOn(module.get(SettingsService), 'getAgentModelPresets').mockReturnValue([
      { id: 'deep', name: 'Deep', provider: 'codex', model: 'gpt', reasoningEffort: 'high', fastMode: true },
    ]);
    started.mockReturnValue(false);
    runtime.getRuntimeState.mockResolvedValue({
      selectedModel: 'gpt', reasoningEffort: 'high', fastMode: true,
      availableModels: [{ id: 'gpt', reasoningEfforts: ['high'], supportsFastMode: true }],
    });
    const action = { type: 'preset', id: 'deep', expectedProvider: 'codex' };
    await chat.command(1, 2, action);
    expect(rememberAgentConfig).toHaveBeenCalledWith({ provider: 'codex', model: 'gpt', reasoningEffort: 'high', fastMode: true });
    rememberAgentConfig.mockClear();
    runtime.setReasoningEffort.mockRejectedValueOnce(new Error('Disconnected'));
    await expect(chat.command(1, 2, action)).rejects.toThrow('could not be fully applied');
    expect(rememberAgentConfig).not.toHaveBeenCalled();
  });

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
    history[0] = { ...history[0], kind: 'user' };
    const latest = (await read())!;
    expect(latest.items).toHaveLength(80);
    expect(latest.items[0].id).toBe('160');
    expect(latest.before).toBe('160');
    expect(latest.leadingPrompt?.id).toBe('0');
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

  it('serves one HTTP stream through the edge, resumes missed text and activity, and closes archived sessions', async () => {
    const app = module.createNestApplication();
    app.setGlobalPrefix('api');
    await app.listen(0, '127.0.0.1');
    const proxy = createEdgeProxyServer({ repoRoot: join(__dirname, '../../../..'), upstreamOrigin: await app.getUrl() });
    await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve));
    const address = proxy.address();
    if (!address || typeof address === 'string') throw new Error('Missing loopback test address.');
    const base = `http://127.0.0.1:${address.port}/api/desktop-workspace/tasks`;
    const path = `${base}/1/sessions/2/chat/events?loadingMode=progressive`;
    const requests: AbortController[] = [];
    const connect = async (after?: string) => {
      const abort = new AbortController();
      requests.push(abort);
      const response = await fetch(path, {
        signal: AbortSignal.any([abort.signal, AbortSignal.timeout(3000)]),
        headers: after ? { 'Last-Event-ID': after } : {},
      });
      expect(response.headers.get('content-type')).toMatch(/^text\/event-stream/);
      expect(response.headers.get('cache-control')).toContain('no-transform');
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      return {
        abort, reader,
        next: async (): Promise<SessionChatStreamPage> => {
          for (;;) {
            const end = buffer.indexOf('\n\n');
            if (end < 0) {
              const part = await reader.read();
              if (part.done) throw new Error('Unexpected conversation stream EOF.');
              buffer += decoder.decode(part.value, { stream: true });
              continue;
            }
            const frame = buffer.slice(0, end);
            buffer = buffer.slice(end + 2);
            if (frame.startsWith(':')) continue;
            const [id, event, data] = frame.split('\n');
            const packet = JSON.parse(data.slice(6)) as SessionChatStreamPage;
            expect(event).toBe('event: chat');
            expect(id).toBe('id: ' + packet.page.cursor);
            return packet;
          }
        },
      };
    };
    try {
      expect((await fetch(`${base}/9/sessions/2/chat/events?loadingMode=window`)).status).toBe(400);
      expect((await fetch(path, { headers: { 'Last-Event-ID': 'bad cursor' } })).status).toBe(400);
      live = [{ ...item('prompt'), kind: 'user' }, item('answer', 'Checking')];
      const first = await connect();
      const initial = await first.next();
      expect(initial.after).toBeNull();
      expect(initial.page.items.map(row => row.id)).toEqual(['prompt', 'answer']);
      const reads = runtime.getRuntimeState.mock.calls.length;
      runtime.emit('event', { type: 'message_delta', payload: { sessionId: 99 } });
      await delay(65);
      expect(runtime.getRuntimeState).toHaveBeenCalledTimes(reads);
      live = [live[0], item('answer', 'Checking files')];
      emit();
      const incremental = await first.next();
      expect(incremental).toMatchObject({ after: initial.page.cursor, page: {
        reset: false, items: [], events: [{ type: 'delta', id: 'answer', text: ' files' }],
      } });
      first.abort.abort();
      live = [live[0], item('answer', 'Checking files and tests'), item('check', 'Tests passed')];
      emit();
      const second = await connect(incremental.page.cursor);
      const catchUp = await second.next();
      expect(catchUp).toMatchObject({ after: incremental.page.cursor, page: {
        reset: false, events: [
          { type: 'delta', id: 'answer', text: ' and tests' },
          { type: 'item', item: { id: 'check', text: 'Tests passed' } },
        ],
      } });
      expect(runtime.getHistory).toHaveBeenCalledTimes(1);
      history = live;
      live = [];
      emit('history_snapshot');
      const saved = await second.next();
      expect(saved.page.reset).toBe(true);
      expect(saved.page.items.map(row => row.id)).toEqual(['prompt', 'answer', 'check']);
      status = 'archived';
      module.get(SessionsService).emit('session-status-changed', { sessionId: 2, status });
      expect(await second.reader.read()).toEqual({ value: undefined, done: true });
      expect((await fetch(path)).status).toBe(410);
    } finally {
      for (const signal of requests) signal.abort();
      await new Promise<void>(resolve => { proxy.close(() => resolve()); proxy.closeAllConnections(); });
      await app.close();
    }
  });

  it('keeps saved tool calls in a long live turn and continues replaying new activity', async () => {
    const prompt = { ...item('prompt'), kind: 'user' as const };
    const exchanges = Array.from({ length: 55 }, (_, i): AgentTranscriptItem[] => [
      { ...item(`msg_${i}:0`, 'Checking the file'), kind: 'thinking' },
      { ...item(`call-${i}`, ''), kind: 'tool_use', toolUseId: `tool-${i}`, toolKind: 'read' },
      { ...item(`result-${i}`, 'File contents'), kind: 'tool_result', toolUseId: `tool-${i}` },
    ]).flat();
    live = [prompt, ...exchanges];
    // Include a legacy split thought with a different durable ID near the
    // tail, along with older live rows outside the bounded history slice.
    history = live.map(row => row.id === 'msg_54:0' ? { ...row, id: 'msg_54:thinking:0' } : row);
    const abort = new AbortController();
    const stream = await chat.openStream(1, 2, 'progressive', undefined, abort.signal);
    try {
      const initial = (await stream.next()).value as SessionChatStreamPage;
      expect(initial.page.items).toHaveLength(80);
      expect(initial.page.items.slice(-4).map(row => row.id)).toEqual([
        'msg_54:0', 'msg_54:thinking:0', 'call-54', 'result-54',
      ]);
      expect(initial.page.items.filter(row => row.kind === 'tool_use').length).toBeGreaterThan(20);

      const call = { ...item('next-call', ''), kind: 'tool_use' as const, toolKind: 'bash', toolUseId: 'next-tool' };
      live = [...live, call];
      emit('tool_use');
      const started = (await stream.next()).value as SessionChatStreamPage;
      expect(started.page).toMatchObject({ reset: false, events: [{ type: 'item', item: { id: call.id } }] });

      live = [...live, { ...item('next-result', 'Checks passed'), kind: 'tool_result', toolUseId: 'next-tool' }];
      emit('tool_result');
      const finished = (await stream.next()).value as SessionChatStreamPage;
      expect(finished.page).toMatchObject({ reset: false, events: [
        { type: 'item', item: { id: call.id, receipt: { id: 'next-result', error: false } } },
        { type: 'item', item: { id: 'next-result' } },
      ] });
      expect(runtime.getHistory).toHaveBeenCalledTimes(1);
    } finally {
      abort.abort();
      await stream.return(undefined);
    }
  });

  it('resets a live window when a burst crosses its bound or changes source order', async () => {
    const abort = new AbortController();
    const source = await chat.openStream(1, 2, 'progressive', undefined, abort.signal);
    try {
      live = [item('one'), item('three')];
      const first = (await source.next()).value as SessionChatStreamPage;
      live = [live[0], item('two'), live[1]];
      emit();
      const reordered = (await source.next()).value as SessionChatStreamPage;
      expect(reordered.after).toBe(first.page.cursor);
      expect(reordered.page).toMatchObject({ reset: true, items: [
        { id: 'one' }, { id: 'two' }, { id: 'three' },
      ] });
      live = [...live, ...Array.from({ length: 100 }, (_, i) => item(`work-${i}`))];
      emit();
      const burst = (await source.next()).value as SessionChatStreamPage;
      expect(burst.page).toMatchObject({ reset: true, before: 'work-20', events: [] });
      expect(burst.page.items).toHaveLength(80);
    } finally {
      abort.abort();
      await source.return(undefined);
    }
  });

  it('keeps an observed patch and its commentary while the stopped runtime waits for durable receipts', async () => {
    const prompt = { ...item('prompt'), kind: 'user' as const };
    const patch = { ...item('patch', ''), kind: 'tool_use' as const, toolUseId: 'patch', toolKind: 'file_changes' };
    const progress = { ...item('progress'), assistantPhase: 'commentary' as const };
    const receipt = { ...item('receipt'), kind: 'tool_result' as const, toolUseId: patch.id };
    live = [prompt, patch, progress, receipt];
    const abort = new AbortController();
    const stream = await chat.openStream(1, 2, 'progressive', undefined, abort.signal);
    try {
      const initial = (await stream.next()).value as SessionChatStreamPage;
      expect(initial.page.items.map(row => row.id)).toEqual(['prompt', 'patch', 'progress', 'receipt']);

      live = [];
      history = [prompt, progress];
      runtime.getRuntimeState.mockResolvedValue({ runPhase: 'idle', liveItems: [] });
      emit('history_snapshot');
      const settling = (await stream.next()).value as SessionChatStreamPage;
      expect(settling.page.items.map(row => row.id)).toEqual(['prompt', 'patch', 'progress', 'receipt']);
      expect(settling.page.items[1].receipt?.id).toBe(receipt.id);
      const following = (await chat.read(1, 2, undefined, undefined, abort.signal, patch.id))!;
      expect(following.items.map(row => row.id)).toEqual(['progress', 'receipt']);
      expect(following.leadingPrompt?.id).toBe(prompt.id);

      history = [prompt, patch, progress, receipt, { ...item('answer'), assistantPhase: 'final' }];
      emit('history_snapshot');
      const completed = (await stream.next()).value as SessionChatStreamPage;
      expect(completed.page.items.map(row => row.id)).toEqual(['prompt', 'patch', 'progress', 'receipt', 'answer']);
      expect((await chat.read(1, 2, undefined, undefined, abort.signal, undefined, 'progressive', '1', '1', '1'))!
        .items[0].completedTurn?.reply[0].id).toBe('answer');
    } finally {
      abort.abort();
      await stream.return(undefined);
    }
  });

  it.each(['stream', 'poll'] as const)('does not append new live records after a saved-ahead row on %s', async transport => {
    const prompt = { ...item('prompt'), kind: 'user' as const };
    const progress = item('progress');
    const answer = item('answer');
    history = [prompt, progress, answer];
    live = [prompt, progress];
    const controller = new AbortController();
    const stream = transport === 'stream' ? await chat.openStream(1, 2, 'progressive', undefined, controller.signal) : null;
    const next = async (after?: string) => stream
      ? ((await stream.next()).value as SessionChatStreamPage).page : (await read(after))!;
    try {
      const first = await next();
      expect(first.items.map(row => row.id)).toEqual(['prompt', 'progress', 'answer']);
      live = [prompt, progress, item('running-patch'), answer];
      emit();
      const caughtUp = await next(first.cursor);
      expect(caughtUp.reset).toBe(true);
      expect(caughtUp.items.map(row => row.id)).toEqual(['prompt', 'progress', 'running-patch', 'answer']);
    } finally {
      controller.abort();
      await stream?.return(undefined);
    }
  });

  it('releases a closed stream while provider hydration is still pending', async () => {
    let start!: () => void;
    const started = new Promise<void>(resolve => { start = resolve; });
    let finish!: (value: { liveItems: AgentTranscriptItem[] }) => void;
    const hydration = new Promise<{ liveItems: AgentTranscriptItem[] }>(resolve => { finish = resolve; });
    runtime.getRuntimeState.mockImplementationOnce(() => {
      start();
      return hydration;
    });
    const abort = new AbortController();
    const stream = await chat.openStream(1, 2, 'progressive', undefined, abort.signal);
    const pending = stream.next();
    try {
      await started;
      abort.abort();
      expect(await pending).toEqual({ done: true, value: undefined });
    } finally {
      finish({ liveItems: [] });
      abort.abort();
    }
  });

  it('refreshes runtime state on an unchanged heartbeat without visiting transcript rows', async () => {
    let reads = 0;
    live = Array.from({ length: 360 }, (_, i) => ({
      ...item(String(i)),
      get content() { reads++; return `Live record ${i}`; },
    }));
    const readWindow = (after?: string) =>
      chat.read(1, 2, after, undefined, new AbortController().signal, undefined, 'window');
    const initial = (await readWindow())!;
    expect(initial.items).toHaveLength(320);
    reads = 0;
    jest.useFakeTimers();
    try {
      runtime.getRuntimeState.mockResolvedValueOnce({ liveItems: live, selectedModel: 'updated' });
      const waiting = readWindow(initial.cursor);
      await jest.advanceTimersByTimeAsync(8000);
      expect(await waiting).toMatchObject({
        cursor: initial.cursor, reset: false, items: [], events: [],
        before: initial.before, state: { model: 'updated' },
      });
      expect(reads).toBe(0);
      expect(runtime.getHistory).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });
  it('streams dequeued user receipts once and retains their identity through saved history', async () => {
    history = [{ ...item('initial'), kind: 'user' }, item('initial-answer')];
    const initial = (await read())!;
    const receipt: AgentTranscriptItem = { ...item('native-user', 'Queued follow-up'), kind: 'user' };
    runtime.getRuntimeState.mockResolvedValueOnce({
      runPhase: 'running', liveItems: live, pendingPrompts: [],
      dispatchingPrompts: [{ id: 'queue-id', prompt: receipt.content, timestamp: receipt.timestamp }],
    });
    emit('message_start');
    const dispatch = (await read(initial.cursor))!;
    expect(dispatch.reset).toBe(false);
    expect(dispatch.events).toEqual([]);
    expect(dispatch.state.dispatchingPrompts).toEqual([{ id: 'queue-id', text: receipt.content, timestamp: receipt.timestamp }]);
    live = [receipt, item('follow-up-answer')];
    emit('message_start');
    const update = (await read(dispatch.cursor))!;
    expect(update.reset).toBe(false);
    expect(update.state.activePromptId).toBe(receipt.id);
    expect(update.events.map(event => event.type === 'item' && event.item.id)).toEqual(['native-user', 'follow-up-answer']);
    expect(runtime.getHistory).toHaveBeenCalledTimes(1);
    history = [...history, ...live];
    emit('history_snapshot');
    const saved = (await read(update.cursor))!;
    expect(saved.items.map(item => item.id)).toEqual(['initial', 'initial-answer', 'native-user', 'follow-up-answer']);
    expect(saved.items.filter(item => item.kind === 'user')).toHaveLength(2);

    const older = (await read(undefined, receipt.id))!;
    expect(older.items.map(item => item.id)).toEqual(['initial', 'initial-answer']);
    expect(older.state.activePromptId).toBe(receipt.id);

    runtime.getRuntimeState.mockResolvedValueOnce({ runPhase: 'idle', liveItems: live });
    expect((await read())!.state.activePromptId).toBeUndefined();
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
      { human: true, queue: false, waitForCompletion: false },
    );
    expect(runtime.submitPrompt).not.toHaveBeenCalled();
  });
  it('allows choosing Claude after Codex fails before creating a native conversation', async () => {
    started.mockReturnValue(false);
    runtime.getRuntimeState.mockResolvedValue({
      runPhase: 'error',
      canInterrupt: false,
      lastError: 'spawn codex ENOENT',
      pendingPrompts: [],
    });
    await chat.command(1, 2, {
      type: 'provider',
      provider: 'claude',
      expectedProvider: 'codex',
    });
    expect(updateProvider).toHaveBeenCalledWith(2, 'claude');
    expect(runtime.getRuntimeState).toHaveBeenCalledWith(2, {
      initialize: false,
    });
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
