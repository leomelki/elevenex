import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OnboardingConnectionService } from './onboarding-connection.service';
import { SavedServer } from '../models/onboarding.model';

describe('OnboardingConnectionService SSH attempt lifecycle', () => {
  const server = { id: 17, sshHost: 'example.com', sshPort: 22, authMode: 'agent' } as SavedServer;
  const api = { ensureReady: vi.fn(), cancel: vi.fn().mockResolvedValue(true), onPhaseUpdate: vi.fn(() => () => {}) };
  let service: OnboardingConnectionService;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    window.__ELEVENEX_ELECTRON__ = {
      sshForwarding: { isSupported: vi.fn().mockResolvedValue(true) }, remoteServer: api,
    } as never;
    service = new OnboardingConnectionService({ ensureReady: vi.fn() } as never, {} as never);
  });

  afterEach(() => {
    service.ngOnDestroy();
    window.__ELEVENEX_ELECTRON__ = undefined;
    vi.useRealTimers();
  });

  it('coalesces concurrent reconnects for the same server', async () => {
    api.ensureReady.mockResolvedValue({ status: 'ready', localPort: 4400 });
    const results = await Promise.all([
      service.reconnect(server, { interactive: false }),
      service.reconnect(server, { interactive: false }),
    ]);
    expect(api.ensureReady).toHaveBeenCalledOnce();
    expect(results[0]).toEqual(results[1]);
    expect(results[0].kind).toBe('success');
  });

  it('settles cancellation immediately and ignores a late successful IPC response', async () => {
    let finish!: (value: unknown) => void;
    api.ensureReady.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    const pending = service.reconnect(server, { interactive: false });
    await vi.advanceTimersByTimeAsync(0);
    service.cancelCurrentConnection();
    expect(await pending).toMatchObject({ kind: 'error', message: expect.stringContaining('canceled') });
    expect(api.cancel).toHaveBeenCalledWith({ id: 17, requestId: expect.any(String) });
    finish({ status: 'ready', localPort: 4400 });
    await vi.advanceTimersByTimeAsync(0);
    expect(service.currentPhase()).toBeNull();
  });

  it('times out a hung IPC bridge and cancels its main-process subscription', async () => {
    api.ensureReady.mockReturnValue(new Promise(() => {}));
    const pending = service.reconnect(server, { interactive: false });
    await vi.advanceTimersByTimeAsync(190001);
    expect(await pending).toMatchObject({ kind: 'error', message: expect.stringContaining('timed out') });
    expect(api.cancel).toHaveBeenCalled();
    expect(service.currentPhase()).toBeNull();
  });

  it('does not treat readiness without a valid local port as success', async () => {
    api.ensureReady.mockResolvedValue({ status: 'ready', localPort: null });
    expect((await service.reconnect(server, { interactive: false })).kind).toBe('error');
  });
  it('marks authentication errors as requiring an action', async () => {
    api.ensureReady.mockResolvedValue({ status: 'error', message: 'Permission denied (publickey).' });
    expect(await service.reconnect(server, { interactive: false })).toMatchObject({ kind: 'error', retryable: false });
  });

  it('preserves whitespace in SSH secrets', async () => {
    api.ensureReady.mockResolvedValue({ status: 'ready', localPort: 4400 });
    await service.reconnect({ ...server, authMode: 'password' }, { interactive: false, password: ' secret ' });
    expect(api.ensureReady).toHaveBeenCalledWith(expect.objectContaining({ password: ' secret ' }));
  });

});
