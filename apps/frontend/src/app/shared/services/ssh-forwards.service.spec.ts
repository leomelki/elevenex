import '@angular/compiler';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { readOnboardingStateSnapshot, writeOnboardingStateSnapshot } from './onboarding-state.service';
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
  const runtime = { id: 1, status: 'active' as const, pid: null, startedAt: null, stoppedAt: null, lastError: null, debugDetails: null };
  const remoteApi = {
    startForward: vi.fn(async () => runtime),
    stopForward: vi.fn(async () => ({ ...runtime, status: 'inactive' as const })),
    getForwardState: vi.fn(async (): Promise<ElectronSshForwardRuntimeState | null> => null),
  };
  const payload = {
    name: 'Preview', sshHost: '', sshPort: 22, bindAddress: '127.0.0.1',
    localPort: 5173, remoteHost: 'localhost', remotePort: 5173, startImmediately: true,
  };
  function selectPaired(id = 3) {
    writeOnboardingStateSnapshot({ ...readOnboardingStateSnapshot(), mode: 'paired', paired: { id, name: 'Studio', localPort: 51234 } });
    window.__ELEVENEX_ELECTRON__ = { remoteLink: remoteApi as unknown as ElectronRemoteLinkApi };
  }
  afterEach(() => { window.__ELEVENEX_ELECTRON__ = originalBridge; });

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
    localStorage.setItem(FORWARDS_KEY, JSON.stringify({
      5: [makeStored(), makeStored({ id: 2, remoteHost: '::1' })],
    }));

    const forwards = await service.getAllOnce();

    expect(forwards.map(forward => forward.remoteHost)).toEqual(['localhost', 'localhost']);
    expect(readStoredForwards()[5].map((entry: { remoteHost: string }) => entry.remoteHost))
      .toEqual(['localhost', 'localhost']);
  });

  it('leaves non-loopback remote hosts untouched', async () => {
    localStorage.setItem(FORWARDS_KEY, JSON.stringify({
      5: [makeStored({ remoteHost: '10.0.0.4' })],
    }));

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
    const created = await service.create(5, {
      name: 'Vite',
      sshHost: 'workstation',
      sshUser: 'bits',
      sshPort: 22,
      bindAddress: '127.0.0.1',
      localPort: 5178,
      remoteHost: 'localhost',
      remotePort: 5178,
      startImmediately: false,
    }).toPromise();

    expect(created?.remoteHost).toBe('localhost');
    expect(created?.destinationLabel).toBe('127.0.0.1:5178 -> localhost:5178');
  });
  it('creates paired forwards without SSH configuration and routes runtime calls to the saved device', async () => {
    selectPaired();
    const created = await firstValueFrom(service.create(5, payload));
    expect(created.pairedDeviceId).toBe(3);
    expect(created.connectionLabel).toBe('Studio');
    expect(created.status).toBe('active');
    expect(remoteApi.startForward).toHaveBeenCalledWith(expect.objectContaining({ deviceId: 3, remoteHost: 'localhost', localPort: 5173 }));
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
    const created = await firstValueFrom(service.create(5, { ...payload, startImmediately: false }));
    selectPaired(4);
    expect(await service.getAllOnce()).toEqual([]);
    selectPaired(3);
    expect((await service.getAllOnce()).map(forward => forward.id)).toEqual([created.id]);
  });

  it('preserves a paired listener running state when its last connection failed', async () => {
    selectPaired();
    await firstValueFrom(service.create(5, { ...payload, startImmediately: false }));
    remoteApi.getForwardState.mockResolvedValueOnce({
      ...runtime, status: 'error', running: true, lastError: 'Remote service unavailable.',
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
    await expect(firstValueFrom(service.create(5, { ...payload, bindAddress: '0.0.0.0' }))).rejects.toThrow('loopback');
    await expect(firstValueFrom(service.create(5, { ...payload, remotePort: 65536 }))).rejects.toThrow('65535');
    expect(await service.getAllOnce()).toEqual([]);
  });

  it('preserves deliberately selected IPv6 targets in paired forwards', async () => {
    selectPaired();
    await firstValueFrom(service.create(5, { ...payload, remoteHost: '::1', startImmediately: false }));
    expect((await service.getAllOnce())[0].remoteHost).toBe('::1');
  });

  it('removes a forward from its original environment when the user switches while stopping it', async () => {
    selectPaired(3);
    const created = await firstValueFrom(service.create(5, { ...payload, startImmediately: false }));
    let stopped!: () => void;
    remoteApi.stopForward.mockImplementationOnce(() => new Promise(resolve => { stopped = () => resolve({ ...runtime, status: 'inactive' }); }));
    const removing = firstValueFrom(service.remove(created.id));
    selectPaired(4);
    const other = await firstValueFrom(service.create(5, { ...payload, startImmediately: false }));
    stopped();
    await removing;
    expect((await service.getAllOnce()).map(forward => forward.id)).toEqual([other.id]);
    selectPaired(3);
    expect(await service.getAllOnce()).toEqual([]);
  });

});
