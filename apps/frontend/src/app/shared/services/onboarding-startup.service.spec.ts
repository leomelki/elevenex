import { of, throwError } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { OnboardingStartupService } from './onboarding-startup.service';

describe('OnboardingStartupService', () => {
  const server = {
    id: 17,
    name: 'Prod',
    sshHost: 'example.com',
    sshUser: 'deploy',
    sshPort: 22,
    authMode: 'agent' as const,
    identityFilePath: null,
    localPort: 4310,
    remotePort: 4311,
    installStatus: 'available' as const,
    createdAt: '2024-01-01',
    updatedAt: '2024-01-01',
    lastConnectedAt: '2024-01-01',
  };

  const onboardingStateMock = {
    readSnapshot: vi.fn(),
    getActiveServer: vi.fn(),
    setRemoteConnectionReady: vi.fn(),
    setCurrentStep: vi.fn(),
    saveServer: vi.fn(),
  };

  const onboardingConnectionMock = {
    reconnect: vi.fn(),
  };

  const sshForwardsServiceMock = {
    getAll: vi.fn(),
    start: vi.fn(),
  };

  const createService = () => new OnboardingStartupService(
    onboardingStateMock as never,
    onboardingConnectionMock as never,
    sshForwardsServiceMock as never,
  );

  beforeEach(() => {
    vi.clearAllMocks();
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
    sshForwardsServiceMock.getAll.mockReturnValue(of([]));
    sshForwardsServiceMock.start.mockReturnValue(of({
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
      status: 'active',
      pid: 123,
      startedAt: '2024-01-01',
      stoppedAt: null,
      lastError: null,
      debugDetails: null,
      destinationLabel: '127.0.0.1:3000 -> 127.0.0.1:3000',
      connectionLabel: 'deploy@example.com:22',
    }));

  });

  it('should not create a prompt in local mode', async () => {
    onboardingStateMock.readSnapshot.mockReturnValue({
      mode: 'local',
      currentStep: 'project',
      activeServerId: null,
      remoteConnectionReady: true,
      projectHandoffAcknowledged: true,
      servers: [],
      lastSshDefaults: null,
    });

    const service = createService();
    await service.initialize();

    expect(service.startupPortForwardPrompt()).toBeNull();
    expect(onboardingConnectionMock.reconnect).not.toHaveBeenCalled();
  });

  it('should not create a prompt when remote reconnect fails', async () => {
    onboardingConnectionMock.reconnect.mockResolvedValue({
      kind: 'error',
      message: 'Failed',
    });

    const service = createService();
    await service.initialize();

    expect(service.startupPortForwardPrompt()).toBeNull();
    expect(onboardingConnectionMock.reconnect).toHaveBeenCalledWith(server, { interactive: false });
    // Failures should surface via startupFailure so the runtime overlay can show them,
    // and must NOT reset the saved onboarding state (no redirect to /onboarding).
    expect(service.startupFailure()).toEqual({ server, message: 'Failed' });
    expect(onboardingStateMock.setRemoteConnectionReady).not.toHaveBeenCalled();
    expect(onboardingStateMock.setCurrentStep).not.toHaveBeenCalled();
  });

  it('should include only matching inactive forwards after successful startup reconnect', async () => {
    sshForwardsServiceMock.getAll.mockReturnValue(of([
      {
        id: 1,
        projectId: 5,
        name: 'API',
        sshHost: 'example.com',
        sshUser: 'deploy',
        sshPort: 22,
        bindAddress: '127.0.0.1',
        localPort: 3000,
        remoteHost: '127.0.0.1',
        remotePort: 3000,
        createdAt: '2024-01-01',
        updatedAt: '2024-01-01',
        status: 'inactive',
        pid: null,
        startedAt: null,
        stoppedAt: null,
        lastError: null,
        debugDetails: null,
        destinationLabel: '127.0.0.1:3000 -> 127.0.0.1:3000',
        connectionLabel: 'deploy@example.com:22',
      },
      {
        id: 2,
        projectId: 5,
        name: 'Already Live',
        sshHost: 'example.com',
        sshUser: 'deploy',
        sshPort: 22,
        bindAddress: '127.0.0.1',
        localPort: 5432,
        remoteHost: '127.0.0.1',
        remotePort: 5432,
        createdAt: '2024-01-01',
        updatedAt: '2024-01-01',
        status: 'active',
        pid: 123,
        startedAt: '2024-01-01',
        stoppedAt: null,
        lastError: null,
        debugDetails: null,
        destinationLabel: '127.0.0.1:5432 -> 127.0.0.1:5432',
        connectionLabel: 'deploy@example.com:22',
      },
      {
        id: 3,
        projectId: 8,
        name: 'Other Host',
        sshHost: 'elsewhere.com',
        sshUser: 'deploy',
        sshPort: 22,
        bindAddress: '127.0.0.1',
        localPort: 8080,
        remoteHost: '127.0.0.1',
        remotePort: 8080,
        createdAt: '2024-01-01',
        updatedAt: '2024-01-01',
        status: 'inactive',
        pid: null,
        startedAt: null,
        stoppedAt: null,
        lastError: null,
        debugDetails: null,
        destinationLabel: '127.0.0.1:8080 -> 127.0.0.1:8080',
        connectionLabel: 'deploy@elsewhere.com:22',
      },
    ]));

    const service = createService();
    await service.initialize();

    const prompt = service.startupPortForwardPrompt();
    expect(prompt?.forwards).toHaveLength(1);
    expect(prompt?.forwards[0].name).toBe('API');
  });

  it('should remove a forward from the prompt after starting it', async () => {
    const service = createService();
    await service.prepareStartupPortForwardPrompt(server);

    sshForwardsServiceMock.getAll.mockReturnValue(of([
      {
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
        status: 'inactive',
        pid: null,
        startedAt: null,
        stoppedAt: null,
        lastError: null,
        debugDetails: null,
        destinationLabel: '127.0.0.1:3000 -> 127.0.0.1:3000',
        connectionLabel: 'deploy@example.com:22',
      },
    ]));
    await service.prepareStartupPortForwardPrompt(server);

    await service.startStartupPortForward(1);

    expect(sshForwardsServiceMock.start).toHaveBeenCalledWith(1);
    expect(service.startupPortForwardPrompt()).toBeNull();
  });

  it('should start all forwards and clear the prompt', async () => {
    sshForwardsServiceMock.getAll.mockReturnValue(of([
      {
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
        status: 'inactive',
        pid: null,
        startedAt: null,
        stoppedAt: null,
        lastError: null,
        debugDetails: null,
        destinationLabel: '127.0.0.1:3000 -> 127.0.0.1:3000',
        connectionLabel: 'deploy@example.com:22',
      },
      {
        id: 2,
        projectId: 5,
        name: 'DB',
        sshHost: server.sshHost,
        sshUser: server.sshUser,
        sshPort: server.sshPort,
        bindAddress: '127.0.0.1',
        localPort: 5432,
        remoteHost: '127.0.0.1',
        remotePort: 5432,
        createdAt: '2024-01-01',
        updatedAt: '2024-01-01',
        status: 'inactive',
        pid: null,
        startedAt: null,
        stoppedAt: null,
        lastError: null,
        debugDetails: null,
        destinationLabel: '127.0.0.1:5432 -> 127.0.0.1:5432',
        connectionLabel: 'deploy@example.com:22',
      },
    ]));

    const service = createService();
    await service.prepareStartupPortForwardPrompt(server);
    await service.startAllStartupPortForwards();

    expect(sshForwardsServiceMock.start).toHaveBeenCalledTimes(2);
    expect(service.startupPortForwardPrompt()).toBeNull();
  });

  it('should keep the prompt visible when a start fails', async () => {
    sshForwardsServiceMock.getAll.mockReturnValue(of([
      {
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
        status: 'inactive',
        pid: null,
        startedAt: null,
        stoppedAt: null,
        lastError: null,
        debugDetails: null,
        destinationLabel: '127.0.0.1:3000 -> 127.0.0.1:3000',
        connectionLabel: 'deploy@example.com:22',
      },
    ]));
    sshForwardsServiceMock.start.mockReturnValueOnce(throwError(() => new Error('boom')));

    const service = createService();
    await service.prepareStartupPortForwardPrompt(server);

    await expect(service.startStartupPortForward(1)).rejects.toThrow('Could not start SSH forward 1.');
    expect(service.startupPortForwardPrompt()?.forwards).toHaveLength(1);
  });

  it('should dismiss the prompt for the current launch', async () => {
    sshForwardsServiceMock.getAll.mockReturnValue(of([
      {
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
        status: 'inactive',
        pid: null,
        startedAt: null,
        stoppedAt: null,
        lastError: null,
        debugDetails: null,
        destinationLabel: '127.0.0.1:3000 -> 127.0.0.1:3000',
        connectionLabel: 'deploy@example.com:22',
      },
    ]));

    const service = createService();
    await service.prepareStartupPortForwardPrompt(server);
    service.dismissStartupPortForwardPrompt();

    expect(service.startupPortForwardPrompt()).toBeNull();
  });
});
