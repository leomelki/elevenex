import type { BackendResult, SessionChatRecord, SessionChatToolDetailsReply, SessionChatToolDetailsRead } from '@elevenex/shared';
import { describe, expect, it, vi } from 'vitest';
import { SessionChatToolCache, SessionChatToolDetails } from './session-chat-tool-details';

const target = { taskId: 12, sessionId: 101, scopeId: 'machine' };
const item = { id: 'call', revision: 'a'.repeat(64) };
const source = { item } as const;

function success(input: SessionChatToolDetailsRead): BackendResult<SessionChatToolDetailsReply> {
  return { ok: true, value: {
    taskId: input.taskId, sessionId: input.sessionId,
    item: { ...input.item, record: {
      id: input.item.id, kind: 'tool_use', text: '', timestamp: '', toolId: 'call',
      toolName: 'Command', toolKind: 'bash', input: '{"command":"pnpm test"}', error: false, truncated: false,
    } },
  } };
}

function setup() {
  const client = {
    cancel: vi.fn<(scope: string, requestId: string) => void>(),
    toolDetails: vi.fn(async (_scope: string, input: SessionChatToolDetailsRead) => success(input)),
  };
  const refresh = vi.fn();
  const tools = new SessionChatToolDetails(client, new SessionChatToolCache(), refresh);
  tools.select(target);
  tools.setAvailable(true);
  return { tools, client, refresh };
}

describe('on-demand tool evidence', () => {
  it('stages the remembered open tool and shares its evidence with the mounted observer', async () => {
    const { tools, client } = setup();
    const row: SessionChatRecord = {
      id: item.id, kind: 'tool_use', text: '', timestamp: '', toolId: 'operation', toolName: 'Command',
      toolKind: 'bash', input: '', error: false, truncated: false, toolDetails: { revision: item.revision },
    };
    const staged = new AbortController();
    await tools.prepare([row, { ...row, id: 'other' }], [item.id], staged.signal);
    expect(client.toolDetails).toHaveBeenCalledOnce();
    const mounted = new AbortController();
    const view = tools.provider()!(source, mounted.signal);
    staged.abort();
    expect(view.state().status).toBe('ready');
    expect(client.toolDetails).toHaveBeenCalledOnce();
    expect(client.cancel).not.toHaveBeenCalled();
    mounted.abort();
  });

  it('warms one closed tool at a time and lets an open join the warmed read', async () => {
    const { tools, client } = setup();
    const replies: ((value: BackendResult<SessionChatToolDetailsReply>) => void)[] = [];
    client.toolDetails.mockImplementation(() => new Promise(resolve => { replies.push(resolve); }));
    const inspect = tools.provider()!;
    const other = { item: { id: 'other', revision: item.revision } };
    inspect.prefetch!(other);
    inspect.prefetch!(other);
    expect(client.toolDetails).toHaveBeenCalledOnce();
    const superseded = client.toolDetails.mock.calls[0]![1];
    inspect.prefetch!(source);
    expect(client.cancel).toHaveBeenCalledWith(target.scopeId, superseded.requestId);
    expect(client.toolDetails).toHaveBeenCalledTimes(2);

    const opened = new AbortController();
    const view = inspect(source, opened.signal);
    expect(view.state().status).toBe('loading');
    // The adopted read is no longer speculative, so a newer intent keeps it.
    inspect.prefetch!(other);
    expect(client.cancel).toHaveBeenCalledOnce();
    expect(client.toolDetails).toHaveBeenCalledTimes(3);
    replies[1]!(success(client.toolDetails.mock.calls[1]![1]));
    replies[2]!(success(client.toolDetails.mock.calls[2]![1]));
    await Promise.resolve();
    expect(view.state().status).toBe('ready');
    opened.abort();

    // A completed warm-up opens from the cache without another request.
    const warmed = inspect(other, new AbortController().signal);
    expect(warmed.state().status).toBe('ready');
    expect(client.toolDetails).toHaveBeenCalledTimes(3);
    tools.select(null);
  });

  it('keeps failed warm-ups uncached and drops unobserved reads while unavailable', async () => {
    const { tools, client } = setup();
    client.toolDetails.mockResolvedValueOnce({ ok: false, error: { code: 'transport', message: 'Temporary failure' } });
    const inspect = tools.provider()!;
    inspect.prefetch!(source);
    await Promise.resolve();
    const view = inspect(source, new AbortController().signal);
    expect(client.toolDetails).toHaveBeenCalledTimes(2);
    await Promise.resolve();
    expect(view.state().status).toBe('ready');

    let hold!: (value: BackendResult<SessionChatToolDetailsReply>) => void;
    client.toolDetails.mockImplementationOnce(() => new Promise(resolve => { hold = resolve; }));
    const other = { item: { id: 'other', revision: item.revision } };
    inspect.prefetch!(other);
    const request = client.toolDetails.mock.calls[2]![1];
    tools.setAvailable(false);
    expect(client.cancel).toHaveBeenCalledWith(target.scopeId, request.requestId);
    inspect.prefetch!(other);
    tools.setAvailable(true);
    expect(client.toolDetails).toHaveBeenCalledTimes(3);
    hold(success(request));
    await Promise.resolve();
    inspect(other, new AbortController().signal);
    expect(client.toolDetails).toHaveBeenCalledTimes(4);
    tools.select(null);
  });

  it('coalesces open observers and reopens cached evidence without a request', async () => {
    const { tools, client } = setup();
    const inspect = tools.provider()!;
    expect(client.toolDetails).not.toHaveBeenCalled();
    const first = new AbortController();
    const second = new AbortController();
    const a = inspect(source, first.signal);
    const b = inspect(source, second.signal);
    expect(client.toolDetails).toHaveBeenCalledOnce();
    expect(a.state().status).toBe('loading');
    first.abort();
    expect(client.cancel).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(b.state()).toMatchObject({ status: 'ready', evidence: { presentation: { summary: 'pnpm test' } } });
    second.abort();
    const cached = inspect(source, new AbortController().signal);
    expect(cached.state()).toEqual(b.state());
    expect(client.toolDetails).toHaveBeenCalledOnce();
    tools.select(null);
  });

  it('cancels an interrupted open, drops late results, and gets the new revision after a scope change', async () => {
    const { tools, client } = setup();
    let reply!: (value: BackendResult<SessionChatToolDetailsReply>) => void;
    client.toolDetails.mockImplementationOnce(() => new Promise(resolve => { reply = resolve; }));
    const abort = new AbortController();
    tools.provider()!(source, abort.signal);
    const request = client.toolDetails.mock.calls[0]![1];
    abort.abort();
    expect(client.cancel).toHaveBeenCalledWith(target.scopeId, request.requestId);
    reply(success(request));
    await Promise.resolve();
    tools.provider()!(source, new AbortController().signal);
    expect(client.toolDetails).toHaveBeenCalledTimes(2);
    tools.select({ ...target, scopeId: 'reconnected' });
    const newSource = { item: { ...item, revision: 'b'.repeat(64) } };
    const next = tools.provider()!(newSource, new AbortController().signal);
    expect(client.toolDetails).toHaveBeenLastCalledWith('reconnected', expect.objectContaining(newSource));
    await Promise.resolve();
    expect(next.state().status).toBe('ready');
    tools.select(null);
  });

  it('can retry a failed read, resumes a paused open, and refreshes a changed reference', async () => {
    const { tools, client, refresh } = setup();
    client.toolDetails.mockResolvedValueOnce({ ok: false, error: { code: 'transport', message: 'Temporary failure' } });
    const view = tools.provider()!(source, new AbortController().signal);
    await Promise.resolve();
    expect(view.state()).toEqual({ status: 'error', reason: 'failed' });

    client.toolDetails.mockImplementationOnce(() => new Promise(() => undefined));
    view.retry();
    expect(view.state().status).toBe('loading');
    tools.setAvailable(false);
    expect(view.state()).toEqual({ status: 'error', reason: 'unavailable' });
    client.toolDetails.mockResolvedValueOnce({ ok: false, error: { code: 'http', status: 409, message: 'Changed' } });
    tools.setAvailable(true);
    await Promise.resolve();
    expect(view.state()).toEqual({ status: 'error', reason: 'changed' });
    view.retry();
    expect(refresh).toHaveBeenCalledOnce();
    expect(client.toolDetails).toHaveBeenCalledTimes(3);
    tools.select(null);
  });
});
