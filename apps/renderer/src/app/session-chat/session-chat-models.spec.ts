import { describe, expect, it, vi } from 'vitest';
import type { BackendResult, SessionChatCatalog } from '@elevenex/shared';
import { SessionChatModels } from './session-chat-models';

const selection = { scopeId: 'remote-scope', taskId: 1, sessionId: 2 };
function catalog(provider = 'codex'): BackendResult<SessionChatCatalog> {
  return { ok: true, value: { provider, label: provider, models: [{ id: 'native', label: 'Native' }],
    model: 'native', reasoning: null, fast: false, reasoningAvailable: false, fastAvailable: false, error: null } };
}

describe('selected harness model discovery', () => {
  it('loads without starting a session, coalesces reads and uses an explicit refresh for retry', async () => {
    let finish!: (value: BackendResult<SessionChatCatalog>) => void;
    const client = { catalog: vi.fn(() => new Promise<BackendResult<SessionChatCatalog>>(resolve => { finish = resolve; })), cancel: vi.fn() };
    const models = new SessionChatModels(client);
    const first = models.load(selection, 'codex');
    await models.load(selection, 'codex');
    expect(models.loading()).toBe(true);
    expect(client.catalog).toHaveBeenCalledTimes(1);
    expect(client.catalog).toHaveBeenLastCalledWith('remote-scope', expect.objectContaining({ taskId: 1, sessionId: 2, provider: 'codex' }));
    finish({ ok: false, error: { code: 'transport', message: 'Could not connect' } });
    await first;
    expect(models.error()).toBe('Could not connect');
    expect(models.loading()).toBe(false);
    const retry = models.load(selection, 'codex', true);
    expect(client.catalog).toHaveBeenLastCalledWith('remote-scope', expect.objectContaining({ refresh: true }));
    finish(catalog());
    await retry;
    expect(models.value()?.models[0]?.id).toBe('native');
    expect(models.error()).toBe('');
  });

  it('cancels on selection/scope change and rejects late results, even for the same provider', async () => {
    const replies: ((value: BackendResult<SessionChatCatalog>) => void)[] = [];
    const client = { catalog: vi.fn(() => new Promise<BackendResult<SessionChatCatalog>>(resolve => replies.push(resolve))), cancel: vi.fn() };
    const models = new SessionChatModels(client);
    const old = models.load(selection, 'codex');
    models.reset();
    expect(client.cancel).toHaveBeenCalledWith('remote-scope', expect.any(String));
    const current = models.load({ ...selection, scopeId: 'new-scope' }, 'codex');
    replies[0]!(catalog());
    await old;
    expect(models.value()).toBeNull();
    expect(models.loading()).toBe(true);
    replies[1]!(catalog());
    await current;
    expect(models.value()?.provider).toBe('codex');
    models.reset();
    expect(models.value()).toBeNull();
  });

  it('surfaces empty catalogs and provider errors without inventing model choices', async () => {
    const result = catalog();
    if (!result.ok) throw new Error('Expected catalog');
    const client = { catalog: vi.fn(async () => ({ ...result, value: { ...result.value, models: [], error: 'Sign in and try again' } })), cancel: vi.fn() };
    const models = new SessionChatModels(client);
    await models.load(selection, 'codex');
    expect(models.value()?.models).toEqual([]);
    expect(models.error()).toBe('Sign in and try again');
  });
});
