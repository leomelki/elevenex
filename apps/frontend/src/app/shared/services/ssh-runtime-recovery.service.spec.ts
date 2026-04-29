import '@angular/compiler';
import { TestBed } from '@angular/core/testing';
import { of, throwError } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SshRuntimeRecoveryService } from './ssh-runtime-recovery.service';

describe('SshRuntimeRecoveryService', () => {
  const server = {
    id: 17,
    name: 'Prod',
    sshHost: 'example.com',
    sshUser: 'deploy',
    sshPort: 22,
    authMode: 'agent' as const,
    identityFilePath: null,
    localPort: 4310,
    remotePort: 11111,
    installStatus: 'available' as const,
    createdAt: '2024-01-01',
    updatedAt: '2024-01-01',
    lastConnectedAt: '2024-01-01',
  };

  const makeForward = (overrides: Record<string, unknown> = {}) => ({
    id: 1,
    projectId: 5,
    name: 'API',
    sshHost: server.sshHost,
    sshUser: server.sshUser,
    sshPort: server.sshPort,
    bindAddress: '127.0.0.1',
    localPort: 3000,
    remoteHost: '127.0.0.1',
    remotePort: 3000,
    createdAt: '2024-01-01',
    updatedAt: '2024-01-01',
    status: 'inactive' as const,
    pid: null,
    startedAt: null,
    stoppedAt: null,
    lastError: null,
    debugDetails: null,
    destinationLabel: '127.0.0.1:3000 -> 127.0.0.1:3000',
    connectionLabel: 'deploy@example.com:22',
    ...overrides,
  });

  const sshForwardsServiceMock = {
    isSupported: vi.fn(),
    getAllOnce: vi.fn(),
    start: vi.fn(),
  };

  const onboardingStateMock = {
    readSnapshot: vi.fn(),
    getActiveServer: vi.fn(),
    saveServer: vi.fn(),
  };

  const onboardingConnectionMock = {
    reconnect: vi.fn(),
  };

  const onboardingStartupMock = {
    prepareStartupPortForwardPrompt: vi.fn(),
    clearStartupFailure: vi.fn(),
    startupFailure: vi.fn().mockReturnValue(null),
  };

  const navigationServiceMock = {
    refreshTree: vi.fn(),
  };

  const createService = () => TestBed.runInInjectionContext(() => new SshRuntimeRecoveryService(
    sshForwardsServiceMock as never,
    onboardingStateMock as never,
    onboardingConnectionMock as never,
    onboardingStartupMock as never,
    navigationServiceMock as never,
  ));

  beforeEach(() => {
    vi.clearAllMocks();
    sshForwardsServiceMock.isSupported.mockResolvedValue(true);
    sshForwardsServiceMock.getAllOnce.mockResolvedValue([]);
    sshForwardsServiceMock.start.mockReturnValue(of(makeForward({ status: 'active', pid: 123 })));
    onboardingStateMock.readSnapshot.mockReturnValue({
      mode: 'ssh',
      currentStep: 'project',
      activeServerId: server.id,
      remoteConnectionReady: true,
      projectHandoffAcknowledged: true,
      servers: [server],
      lastSshDefaults: null,
    });
    onboardingStateMock.getActiveServer.mockReturnValue(server);
    onboardingConnectionMock.reconnect.mockResolvedValue({
      kind: 'success',
      serverId: server.id,
      localPort: 4400,
      installStatus: 'available',
    });
    onboardingStartupMock.prepareStartupPortForwardPrompt.mockResolvedValue(undefined);

    const windowMock = (globalThis as typeof globalThis & { window?: any }).window ?? {};
    (globalThis as typeof globalThis & { window?: any }).window = windowMock;
    windowMock.__ELEVENEX_ELECTRON__ = {
      sshForwarding: {
        isSupported: vi.fn().mockResolvedValue(true),
        getState: vi.fn().mockResolvedValue({
          id: server.id,
          status: 'inactive',
          installStatus: 'available',
          pid: null,
          startedAt: null,
          stoppedAt: null,
          lastError: null,
          debugDetails: null,
        }),
      },
    };
  });

  it('does not show a saved-forward banner on the initial inactive snapshot', async () => {
    sshForwardsServiceMock.getAllOnce.mockResolvedValue([makeForward({ status: 'inactive' })]);

    const service = createService();
    await service.refreshNow();

    expect(service.disconnectedForwardsBanner()).toBeNull();
  });

  it('shows a saved-forward banner after a live forward disconnects', async () => {
    const service = createService();
    sshForwardsServiceMock.getAllOnce.mockResolvedValueOnce([makeForward({ status: 'active', pid: 123 })]);
    sshForwardsServiceMock.getAllOnce.mockResolvedValueOnce([makeForward({ status: 'error', lastError: 'Connection reset' })]);

    await service.refreshNow();
    await service.refreshNow();

    expect(service.disconnectedForwardsBanner()?.totalCount).toBe(1);
    expect(service.disconnectedForwardsBanner()?.forwards[0].lastError).toBe('Connection reset');
  });

  it('dismisses the saved-forward banner until a fresh disconnect appears', async () => {
    const service = createService();
    sshForwardsServiceMock.getAllOnce.mockResolvedValueOnce([makeForward({ id: 1, name: 'API', status: 'active', pid: 123 })]);
    sshForwardsServiceMock.getAllOnce.mockResolvedValueOnce([makeForward({ id: 1, name: 'API', status: 'error' })]);
    sshForwardsServiceMock.getAllOnce.mockResolvedValueOnce([
      makeForward({ id: 1, name: 'API', status: 'error' }),
      makeForward({ id: 2, name: 'DB', localPort: 5432, remotePort: 5432, status: 'active', pid: 124 }),
    ]);
    sshForwardsServiceMock.getAllOnce.mockResolvedValueOnce([
      makeForward({ id: 1, name: 'API', status: 'error' }),
      makeForward({ id: 2, name: 'DB', localPort: 5432, remotePort: 5432, status: 'inactive' }),
    ]);

    await service.refreshNow();
    await service.refreshNow();
    service.dismissDisconnectedForwardsBanner();
    expect(service.disconnectedForwardsBanner()).toBeNull();

    await service.refreshNow();
    await service.refreshNow();

    expect(service.disconnectedForwardsBanner()?.totalCount).toBe(2);
  });

  it('reconnects disconnected saved forwards and clears them from the banner', async () => {
    const service = createService();
    sshForwardsServiceMock.getAllOnce.mockResolvedValueOnce([makeForward({ status: 'active', pid: 123 })]);
    sshForwardsServiceMock.getAllOnce.mockResolvedValueOnce([makeForward({ status: 'error' })]);

    await service.refreshNow();
    await service.refreshNow();

    const failures = await service.reconnectAllDisconnectedForwards();

    expect(failures).toHaveLength(0);
    expect(sshForwardsServiceMock.start).toHaveBeenCalledWith(1);
    expect(service.disconnectedForwardsBanner()).toBeNull();
  });

  it('shows the blocking overlay when the remote tunnel drops after being active', async () => {
    const getState = ((globalThis as typeof globalThis & { window?: any }).window?.__ELEVENEX_ELECTRON__?.sshForwarding.getState);
    getState.mockResolvedValueOnce({
      id: server.id,
      status: 'active',
      installStatus: 'available',
      pid: 300,
      startedAt: '2024-01-01',
      stoppedAt: null,
      lastError: null,
      debugDetails: null,
    });
    getState.mockResolvedValueOnce({
      id: server.id,
      status: 'error',
      installStatus: 'available',
      pid: null,
      startedAt: '2024-01-01',
      stoppedAt: '2024-01-01',
      lastError: 'Remote tunnel dropped.',
      debugDetails: null,
    });

    const service = createService();
    await service.refreshNow();
    await service.refreshNow();

    expect(service.remoteDisconnect()?.message).toBe('Remote tunnel dropped.');
  });

  it('keeps the remote overlay open when reconnect fails and updates the message', async () => {
    const service = createService();
    (service as any)._remoteDisconnect.set({
      server,
      localPort: server.localPort,
      message: 'Old error',
    });
    onboardingConnectionMock.reconnect.mockResolvedValue({
      kind: 'error',
      message: 'Still offline',
    });

    await service.retryRemoteConnection();

    expect(service.remoteDisconnect()?.message).toBe('Still offline');
  });

  it('clears the remote overlay and updates onboarding state after reconnect success', async () => {
    const service = createService();
    (service as any)._remoteDisconnect.set({
      server,
      localPort: server.localPort,
      message: 'Old error',
    });

    await service.retryRemoteConnection();

    expect(service.remoteDisconnect()).toBeNull();
    expect(onboardingStateMock.saveServer).toHaveBeenCalled();
    expect(onboardingStartupMock.prepareStartupPortForwardPrompt).toHaveBeenCalled();
    expect(navigationServiceMock.refreshTree).toHaveBeenCalledOnce();
  });

  it('returns reconnect failures for saved forwards without clearing the banner', async () => {
    const service = createService();
    sshForwardsServiceMock.getAllOnce.mockResolvedValueOnce([makeForward({ status: 'active', pid: 123 })]);
    sshForwardsServiceMock.getAllOnce.mockResolvedValueOnce([makeForward({ status: 'error' })]);
    sshForwardsServiceMock.start.mockReturnValue(throwError(() => new Error('Reconnect failed')));

    await service.refreshNow();
    await service.refreshNow();

    const failures = await service.reconnectAllDisconnectedForwards();

    expect(failures).toHaveLength(1);
    expect(service.disconnectedForwardsBanner()?.totalCount).toBe(1);
  });
});
