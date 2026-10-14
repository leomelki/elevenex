import '@angular/compiler';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  readOnboardingStateSnapshot,
  writeOnboardingStateSnapshot,
} from './onboarding-state.service';
import type { ElectronRemoteLinkApi } from '../runtime/electron-remote-link';
import type { ElectronSshForwardRuntimeState } from '../runtime/electron-ssh-forwarding';
import { firstValueFrom } from 'rxjs';
import { SshForwardsService } from './ssh-forwards.service';

describe('SshForwardsService', () => {
  const FORWARDS_KEY = 'elevenex-ssh-forwards@local';
  const UPGRADE_KEY = 'elevenex-ssh-forwards-loopback-upgraded@local';

  const makeStored = (overrides: Record<string, unknown> = {}) => ({
    id: 1,
    projectId: 5,
    name: 'Vite',
    sshHost: 'workstation',
    sshPort: 22,
    sshUser: 'bits',
    bindAddress: '127.0.0.1',
    localPort: 5178,
    remoteHost: '127.0.0.1',
    remotePort: 5178,
    createdAt: '2024-01-01',
    updatedAt: '2024-01-01',
    ...overrides,
  });

  const readStoredForwards = () => JSON.parse(localStorage.getItem(FORWARDS_KEY) ?? '{}');

  let service: SshForwardsService;
  const originalBridge = window.__ELEVENEX_ELECTRON__;
  const runtime = {
    id: 1,
    status: 'active' as const,
    pid: null,
    startedAt: null,
    stoppedAt: null,
    lastError: null,
    debugDetails: null,
  };
  const remoteApi = {
    startForward: vi.fn(async () => runtime),
    stopForward: vi.fn(async () => ({ ...runtime, status: 'inactive' as const })),
    getForwardState: vi.fn(async (): Promise<ElectronSshForwardRuntimeState | null> => null),
  };
  const payload = {
    name: 'Preview',
    sshHost: '',
    sshPort: 22,
    bindAddress: '127.0.0.1',
    localPort: 5173,
    remoteHost: 'localhost',
    remotePort: 5173,
    startImmediately: true,
  };
  function selectPaired(id = 3) {
    writeOnboardingStateSnapshot({
      ...readOnboardingStateSnapshot(),
      mode: 'paired',
      paired: { id, name: 'Studio', localPort: 51234 },
    });
    window.__ELEVENEX_ELECTRON__ = { remoteLink: remoteApi as unknown as ElectronRemoteLinkApi };
  }
  afterEach(() => {
    window.__ELEVENEX_ELECTRON__ = originalBridge;
  });

  beforeEach(() => {
    localStorage.clear();
    window.__ELEVENEX_ELECTRON__ = undefined;
    vi.clearAllMocks();
    remoteApi.startForward.mockResolvedValue(runtime);
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({ providers: [SshForwardsService] });
    service = TestBed.inject(SshForwardsService);
  });

  it('rewrites loopback IP literals in stored forwards to localhost', async () => {
    localStorage.setItem(
      FORWARDS_KEY,
      JSON.stringify({
        5: [makeStored(), makeStored({ id: 2, remoteHost: '::1' })],
      }),
    );

    const forwards = await service.getAllOnce();

    expect(forwards.map((forward) => forward.remoteHost)).toEqual(['localhost', 'localhost']);
    expect(
      readStoredForwards()[5].map((entry: { remoteHost: string }) => entry.remoteHost),
    ).toEqual(['localhost', 'localhost']);
  });

  it('coalesces simultaneous retries into one saved paired definition', async () => {
    selectPaired();
    const [first, second] = await Promise.all([
      service.ensure(5, payload),
      service.ensure(5, { ...payload, name: 'Another label' }),
    ]);
    expect(second.forward.id).toBe(first.forward.id);
    expect([first.reused, second.reused]).toEqual([false, true]);
    expect(await service.getAllOnce()).toHaveLength(1);
  });

  it('keeps an errored definition retryable without creating duplicates', async () => {
    selectPaired();
    remoteApi.startForward.mockRejectedValue(new Error('Local port already in use'));
    const first = await service.ensure(5, payload);
    const second = await service.ensure(5, payload);
    expect(second.forward).toMatchObject({
      id: first.forward.id,
      status: 'error',
      lastError: 'Local port already in use',
    });
    expect(await service.getAllOnce()).toHaveLength(1);
  });

  it('checks cancellation before a queued mutation', async () => {
    selectPaired();
    const controller = new AbortController();
    controller.abort();
    await expect(service.ensure(5, payload, controller.signal)).rejects.toThrow();
    expect(remoteApi.startForward).not.toHaveBeenCalled();
    expect(await service.getAllOnce()).toEqual([]);
  });

  it('shares the mutation lock across separate window service instances', async () => {
    selectPaired();
    const previous = Object.getOwnPropertyDescriptor(navigator, 'locks');
    const queues = new Map<string, Promise<unknown>>();
    const request = vi.fn((name: string, _options: unknown, callback: () => Promise<unknown>) => {
      const result = (queues.get(name) ?? Promise.resolve()).then(callback);
      queues.set(name, result);
      return result;
    });
    Object.defineProperty(navigator, 'locks', { configurable: true, value: { request } });
    try {
      const anotherWindow = new SshForwardsService();
      const [first, second] = await Promise.all([
        service.ensure(5, payload),
        anotherWindow.ensure(5, payload),
      ]);
      expect(second.forward.id).toBe(first.forward.id);
      expect(second.reused).toBe(true);
      expect(request).toHaveBeenCalledTimes(2);
      expect(await service.getAllOnce()).toHaveLength(1);
      anotherWindow.ngOnDestroy();
    } finally {
      if (previous) Object.defineProperty(navigator, 'locks', previous);
      else Reflect.deleteProperty(navigator, 'locks');
    }
  });

  it('cancels work waiting behind a start without creating a second definition', async () => {
    selectPaired();
    let started!: () => void;
    const didStart = new Promise<void>((resolve) => {
      started = resolve;
    });
    let release!: () => void;
    remoteApi.startForward.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve(runtime);
          started();
        }),
    );
    const first = service.ensure(5, payload);
    await didStart;
    const controller = new AbortController();
    const queued = service.ensure(5, { ...payload, localPort: 5174 }, controller.signal);
    const rejected = expect(queued).rejects.toThrow();
    controller.abort();
    release();
    await first;
    await rejected;
    expect(remoteApi.startForward).toHaveBeenCalledTimes(1);
    expect(await service.getAllOnce()).toHaveLength(1);
  });

  it('uses the active connection’s configured private key without storing credentials in a forward', async () => {
    const ssh = {
      isSupported: vi.fn(async () => true),
      start: vi.fn(async () => runtime),
      getState: vi.fn(async () => null),
      stop: vi.fn(async () => runtime),
    };
    window.__ELEVENEX_ELECTRON__ = { sshForwarding: ssh };
    const server = {
      id: 7,
      name: 'Dev',
      sshHost: 'devhost',
      sshUser: 'alice',
      sshPort: 2222,
      localPort: 51234,
      remotePort: 11111,
      authMode: 'key' as const,
      identityFilePath: '/desktop/private-key',
      installStatus: 'available' as const,
      createdAt: '',
      updatedAt: '',
      lastConnectedAt: '',
    };
    writeOnboardingStateSnapshot({
      ...readOnboardingStateSnapshot(),
      mode: 'ssh',
      activeServerId: 7,
      servers: [server],
      remoteConnectionReady: true,
    });
    await service.ensure(5, {
      ...payload,
      sshHost: server.sshHost,
      sshUser: server.sshUser,
      sshPort: server.sshPort,
    });
    expect(ssh.start).toHaveBeenCalledWith(
      expect.objectContaining({ authMode: 'key', identityFilePath: '/desktop/private-key' }),
    );
    expect(localStorage.getItem('elevenex-ssh-forwards@server-7')).not.toContain('private-key');
  });

  it('persists the creating agent and preserves it when another agent reuses the forward', async () => {
    selectPaired();
    const creator = { sessionId: 42, sessionName: 'Preview agent' };
    const first = await service.ensure(5, payload, undefined, creator);
    const reused = await service.ensure(5, payload, undefined, {
      sessionId: 43,
      sessionName: 'Other agent',
    });
    expect(reused.forward.createdBySession).toEqual(creator);
    expect((await service.findByProject(5, first.forward.id))?.createdBySession).toEqual(creator);
  });

  it('emits a refresh after mutation completion and on shared storage updates', async () => {
    selectPaired();
    const changed = vi.fn();
    const subscription = service.changes.subscribe(changed);
    await service.ensure(5, payload);
    expect(changed).toHaveBeenCalledTimes(1);
    window.dispatchEvent(new StorageEvent('storage', { key: 'elevenex-ssh-forwards@paired-3' }));
    expect(changed).toHaveBeenCalledTimes(2);
    window.dispatchEvent(new StorageEvent('storage', { key: 'elevenex-ssh-forwards@paired-4' }));
    expect(changed).toHaveBeenCalledTimes(2);
    subscription.unsubscribe();
  });

  it('leaves non-loopback remote hosts untouched', async () => {
    localStorage.setItem(
      FORWARDS_KEY,
      JSON.stringify({
        5: [makeStored({ remoteHost: '10.0.0.4' })],
      }),
    );

    const forwards = await service.getAllOnce();

    expect(forwards[0].remoteHost).toBe('10.0.0.4');
  });

  it('only rewrites once, so a hand-typed loopback host survives', async () => {
    localStorage.setItem(UPGRADE_KEY, 'done');
    localStorage.setItem(FORWARDS_KEY, JSON.stringify({ 5: [makeStored()] }));

    const forwards = await service.getAllOnce();

    expect(forwards[0].remoteHost).toBe('127.0.0.1');
  });

  it('defaults a created forward to the remote host it was given', async () => {
    const created = await service
      .create(5, {
        name: 'Vite',
        sshHost: 'workstation',
        sshUser: 'bits',
        sshPort: 22,
        bindAddress: '127.0.0.1',
        localPort: 5178,
        remoteHost: 'localhost',
        remotePort: 5178,
        startImmediately: false,
      })
      .toPromise();

    expect(created?.remoteHost).toBe('localhost');
    expect(created?.destinationLabel).toBe('127.0.0.1:5178 -> localhost:5178');
  });
  it('creates paired forwards without SSH configuration and routes runtime calls to the saved device', async () => {
    selectPaired();
    const created = await firstValueFrom(service.create(5, payload));
    expect(created.pairedDeviceId).toBe(3);
    expect(created.connectionLabel).toBe('Studio');
    expect(created.status).toBe('active');
    expect(remoteApi.startForward).toHaveBeenCalledWith(
      expect.objectContaining({ deviceId: 3, remoteHost: 'localhost', localPort: 5173 }),
    );
    await service.getAllOnce();
    expect(remoteApi.getForwardState).toHaveBeenCalledWith(3, created.id);
    await firstValueFrom(service.stop(created.id));
    expect(remoteApi.stopForward).toHaveBeenCalledWith(3, created.id);
    await firstValueFrom(service.remove(created.id));
    expect(await service.getAllOnce()).toEqual([]);
    expect(localStorage.getItem('elevenex-ssh-forward-defaults')).toBeNull();
  });

  it('isolates forwards by paired desktop even when project ids overlap', async () => {
    selectPaired(3);
    const created = await firstValueFrom(
      service.create(5, { ...payload, startImmediately: false }),
    );
    selectPaired(4);
    expect(await service.getAllOnce()).toEqual([]);
    selectPaired(3);
    expect((await service.getAllOnce()).map((forward) => forward.id)).toEqual([created.id]);
  });

  it('preserves a paired listener running state when its last connection failed', async () => {
    selectPaired();
    await firstValueFrom(service.create(5, { ...payload, startImmediately: false }));
    remoteApi.getForwardState.mockResolvedValueOnce({
      ...runtime,
      status: 'error',
      running: true,
      lastError: 'Remote service unavailable.',
    });
    const [saved] = await service.getAllOnce();
    expect(saved.status).toBe('error');
    expect(saved.running).toBe(true);
    expect(saved.lastError).toBe('Remote service unavailable.');
  });

  it('keeps a failed start saved once and exposes the error for retry', async () => {
    selectPaired();
    remoteApi.startForward.mockRejectedValueOnce(new Error('Local port 5173 is already in use.'));
    const created = await firstValueFrom(service.create(5, payload));
    expect(created.status).toBe('error');
    expect(created.lastError).toContain('already in use');
    const saved = await service.getAllOnce();
    expect(saved).toHaveLength(1);
    expect(saved[0].status).toBe('error');
    expect((await firstValueFrom(service.start(created.id))).status).toBe('active');
  });

  it('rejects public bind addresses and invalid ports before saving', async () => {
    selectPaired();
    await expect(
      firstValueFrom(service.create(5, { ...payload, bindAddress: '0.0.0.0' })),
    ).rejects.toThrow('loopback');
    await expect(
      firstValueFrom(service.create(5, { ...payload, remotePort: 65536 })),
    ).rejects.toThrow('65535');
    expect(await service.getAllOnce()).toEqual([]);
  });

  it('preserves deliberately selected IPv6 targets in paired forwards', async () => {
    selectPaired();
    await firstValueFrom(
      service.create(5, { ...payload, remoteHost: '::1', startImmediately: false }),
    );
    expect((await service.getAllOnce())[0].remoteHost).toBe('::1');
  });

  it('removes a forward from its original environment when the user switches while stopping it', async () => {
    selectPaired(3);
    const created = await firstValueFrom(
      service.create(5, { ...payload, startImmediately: false }),
    );
    let stopped!: () => void;
    let stopping!: () => void;
    const didStart = new Promise<void>((resolve) => {
      stopping = resolve;
    });
    remoteApi.stopForward.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          stopped = () => resolve({ ...runtime, status: 'inactive' });
          stopping();
        }),
    );
    const removing = firstValueFrom(service.remove(created.id));
    await didStart;
    selectPaired(4);
    const other = await firstValueFrom(service.create(5, { ...payload, startImmediately: false }));
    stopped();
    await removing;
    expect((await service.getAllOnce()).map((forward) => forward.id)).toEqual([other.id]);
    selectPaired(3);
    expect(await service.getAllOnce()).toEqual([]);
  });
});
