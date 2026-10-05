import { signal } from '@angular/core';
import { ServerConnectionService } from '@/shared/services/server-connection.service';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { OnboardingStateService } from '@/shared/services/onboarding-state.service';
import type { RemoteLinkDeviceState, RemoteLinkStatus } from '@/shared/runtime/electron-remote-link';

import { RemoteLinkService } from './remote-link.service';

function device(overrides: Partial<RemoteLinkDeviceState> = {}): RemoteLinkDeviceState {
  return {
    id: 3,
    name: 'Studio',
    transport: 'p2p',
    endpoint: '',
    createdAt: '2024-01-01',
    lastConnectedAt: '2024-01-01',
    status: 'connected',
    localPort: 51234,
    backendUrl: 'http://127.0.0.1:51234',
    path: 'direct',
    error: null,
    ...overrides,
  };
}

describe('RemoteLinkService', () => {
  let emitStatus: (state: RemoteLinkDeviceState) => void;

  const api = {
    getSharing: vi.fn(async () => ({
      configured: false,
      enabled: false,
      transport: null,
      endpoint: null,
      label: '',
      status: 'stopped' as RemoteLinkStatus,
      connectedPeers: 0,
      error: null,
    })),
    list: vi.fn(async () => [device()]),
    connect: vi.fn(async () => device()),
    onSharingChanged: vi.fn(() => () => undefined),
    onStatusChanged: vi.fn((callback: (state: RemoteLinkDeviceState) => void) => {
      emitStatus = callback;
      return () => undefined;
    }),
  };

  const serverConnectionMock = {
    setTransportAvailable: vi.fn(),
    recheck: vi.fn(),
    waitUntilInteractive: vi.fn(() => Promise.resolve()),
  };
  const snapshotState = signal({ mode: 'paired', remoteConnectionReady: true, paired: { id: 3, name: 'Studio', localPort: 51234 } });
  const onboardingStateMock = {
    snapshotState,
    readSnapshot: vi.fn(() => snapshotState()),
    paired: { id: 3, name: 'Studio', localPort: 51234 } as { id: number; name: string; localPort: number } | null,
    getPairedState: vi.fn(() => onboardingStateMock.paired),
    setPairedState: vi.fn(),
    markPairedConnected: vi.fn(),
    clearPairedConnection: vi.fn(),
  };

  function createService(): RemoteLinkService {
    TestBed.configureTestingModule({
      providers: [
        RemoteLinkService,
        { provide: OnboardingStateService, useValue: onboardingStateMock },
        { provide: ServerConnectionService, useValue: serverConnectionMock },
      ],
    });
    return TestBed.inject(RemoteLinkService);
  }

  beforeEach(() => {
    TestBed.resetTestingModule();
    vi.clearAllMocks();
    onboardingStateMock.paired = { id: 3, name: 'Studio', localPort: 51234 };
    snapshotState.set({ mode: 'paired', remoteConnectionReady: true, paired: onboardingStateMock.paired });
    (window as unknown as { __ELEVENEX_ELECTRON__?: unknown }).__ELEVENEX_ELECTRON__ = {
      remoteLink: api,
    };
  });

  it('re-arms the window backend when the link comes back on its own', () => {
    createService();

    emitStatus(device({ status: 'reconnecting', localPort: 51234 }));
    expect(onboardingStateMock.clearPairedConnection).toHaveBeenCalled();

    emitStatus(device({ status: 'connected', localPort: 51234 }));
    expect(onboardingStateMock.markPairedConnected).toHaveBeenCalledWith({
      id: 3,
      name: 'Studio',
      localPort: 51234,
    });
  });

  it('leaves another device alone', () => {
    createService();
    vi.clearAllMocks();

    emitStatus(device({ id: 9, status: 'reconnecting' }));

    expect(onboardingStateMock.clearPairedConnection).not.toHaveBeenCalled();
    expect(onboardingStateMock.markPairedConnected).not.toHaveBeenCalled();
  });

  it('refuses to point the window at a port whose link is not up', async () => {
    api.connect.mockResolvedValueOnce(
      device({ status: 'reconnecting', error: 'The link dropped.' }),
    );
    const service = createService();

    await expect(service.connect(3)).rejects.toThrow('The link dropped.');
    expect(onboardingStateMock.setPairedState).not.toHaveBeenCalled();
  });

  it('points the window at a connected link', async () => {
    const service = createService();

    await service.connect(3);

    expect(onboardingStateMock.setPairedState).toHaveBeenCalledWith({
      id: 3,
      name: 'Studio',
      localPort: 51234,
    });
  });
  it('blocks requests immediately on a transport outage and rechecks after recovery', () => {
    createService();
    emitStatus(device({ status: 'reconnecting' }));
    expect(serverConnectionMock.setTransportAvailable).toHaveBeenLastCalledWith(false);
    emitStatus(device());
    expect(serverConnectionMock.setTransportAvailable).toHaveBeenLastCalledWith(true);
  });

  it('ignores recovery from a remembered device after switching to local', () => {
    createService();
    snapshotState.update(snapshot => ({ ...snapshot, mode: 'local' }));
    emitStatus(device());
    expect(onboardingStateMock.markPairedConnected).not.toHaveBeenCalled();
  });

  it('does not reactivate a desktop when an old startup attempt finishes after cancellation', async () => {
    let resolve!: (state: RemoteLinkDeviceState) => void;
    api.connect.mockReturnValueOnce(new Promise(done => { resolve = done; }));
    const service = createService();
    const controller = new AbortController();
    const attempt = service.connect(3, controller.signal);
    controller.abort();
    await expect(attempt).rejects.toThrow();
    resolve(device());
    await Promise.resolve();
    expect(onboardingStateMock.setPairedState).not.toHaveBeenCalled();
    expect(service.busy()).toBe(false);
  });

  it('waits for the backend gateway before reporting a usable connection', async () => {
    let ready!: () => void;
    serverConnectionMock.waitUntilInteractive.mockReturnValueOnce(new Promise(resolve => { ready = resolve; }));
    const service = createService();
    const attempt = service.connect(3);
    await vi.waitFor(() => expect(serverConnectionMock.waitUntilInteractive).toHaveBeenCalled());
    expect(service.busy()).toBe(true);
    ready();
    await attempt;
    expect(service.busy()).toBe(false);
  });

  it('does not overwrite a newer status event with an old list response', async () => {
    const service = createService();
    await service.refresh();
    let resolve!: (devices: RemoteLinkDeviceState[]) => void;
    api.list.mockReturnValueOnce(new Promise(done => { resolve = done; }));
    const refresh = service.refresh();
    emitStatus(device({ status: 'reconnecting' }));
    resolve([device()]);
    await refresh;
    expect(service.devices()[0].status).toBe('reconnecting');
  });

});
