import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { Router } from '@angular/router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { BrowserTabsStateService } from '../../features/browser-panel/browser-tabs-state.service';
import { BrowserViewStateService } from '../../features/browser-panel/browser-view-state.service';
import { TabService } from '../../features/session/tab-service';
import { VSCodeWebStateService } from '../../features/vscode-web/vscode-web-state.service';

import { EnvironmentConnectionManagerService } from './environment-connection-manager.service';
import { NavigationService } from './navigation.service';
import { OnboardingConnectionService } from './onboarding-connection.service';
import { OnboardingStartupService } from './onboarding-startup.service';
import { OnboardingStateService } from './onboarding-state.service';
import { OnboardingStateSnapshot } from '../models/onboarding.model';

describe('EnvironmentConnectionManagerService', () => {
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

  const snapshotState = signal<OnboardingStateSnapshot>({
    mode: 'local',
    currentStep: 'project',
    activeServerId: null as number | null,
    remoteConnectionReady: true,
    projectHandoffAcknowledged: true,
    servers: [server],
    lastSshDefaults: null,
  });

  const onboardingStateMock = {
    snapshotState: snapshotState.asReadonly(),
    readSnapshot: vi.fn(() => snapshotState()),
    getActiveServer: vi.fn((snapshot = snapshotState()) =>
      snapshot.activeServerId ? snapshot.servers.find((entry: typeof server) => entry.id === snapshot.activeServerId) ?? null : null),
    setMode: vi.fn((mode: 'local' | 'ssh') => {
      snapshotState.update(current => ({
        ...current,
        mode,
        activeServerId: mode === 'local' ? null : current.activeServerId,
        remoteConnectionReady: true,
      }));
    }),
    setRemoteConnectionReady: vi.fn((ready: boolean) => {
      snapshotState.update(current => ({ ...current, remoteConnectionReady: ready }));
    }),
    saveServer: vi.fn((nextServer: typeof server) => {
      snapshotState.update(current => ({
        ...current,
        mode: 'ssh',
        activeServerId: nextServer.id,
        remoteConnectionReady: true,
        servers: [nextServer, ...current.servers.filter(entry => entry.id !== nextServer.id)],
      }));
    }),
    upsertServer: vi.fn((nextServer: typeof server) => {
      snapshotState.update(current => ({
        ...current,
        servers: [nextServer, ...current.servers.filter(entry => entry.id !== nextServer.id)],
      }));
    }),
    deleteServer: vi.fn((id: number) => {
      snapshotState.update(current => ({
        ...current,
        servers: current.servers.filter(entry => entry.id !== id),
      }));
    }),
    saveLastSshDefaults: vi.fn(),
  };

  const onboardingConnectionMock = {
    connect: vi.fn(),
    reconnect: vi.fn(),
  };

  const onboardingStartupMock = {
    prepareStartupPortForwardPrompt: vi.fn(),
  };

  const routerMock = {
    navigate: vi.fn(() => Promise.resolve(true)),
  };

  const tabServiceMock = {
    tabs: signal([
      {
        sessionId: 100,
        sessionName: 'Session 100',
        branchName: 'main',
        worktreePath: '/tmp/repo-main',
        status: 'active',
        hasUnreviewedCompletion: false,
        lastCompletionAt: null,
        lastCompletionKind: null,
        hasInjectedWorktreeContext: false,
        repoId: 4,
        projectId: 55,
        repoColor: null,
      },
    ]).asReadonly(),
    resetForEnvironmentChange: vi.fn(() => ({ activeSessionId: null, closedSessionIds: [100] })),
  };

  const vscodeWebStateMock = {
    destroyIframe: vi.fn(),
  };

  const browserViewStates = signal(new Map<string, any>([['project:55:tab:1', { key: 'project:55:tab:1' }]]));
  const browserViewStateMock = {
    states: browserViewStates.asReadonly(),
    removeStatesByPrefix: vi.fn(),
  };

  const browserTabsStateMock = {
    removeProject: vi.fn(),
  };

  const navigationServiceMock = {
    refreshTree: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    snapshotState.set({
      mode: 'local',
      currentStep: 'project',
      activeServerId: null,
      remoteConnectionReady: true,
      projectHandoffAcknowledged: true,
      servers: [server],
      lastSshDefaults: null,
    });
    onboardingConnectionMock.connect.mockResolvedValue({
      kind: 'success',
      serverId: server.id,
      localPort: 4400,
      installStatus: 'available',
    });
    onboardingConnectionMock.reconnect.mockResolvedValue({
      kind: 'success',
      serverId: server.id,
      localPort: 4310,
      installStatus: 'available',
    });
    onboardingStartupMock.prepareStartupPortForwardPrompt.mockResolvedValue(undefined);
    browserViewStates.set(new Map([['project:55:tab:1', { key: 'project:55:tab:1' }]]));
    navigationServiceMock.refreshTree.mockReset();

    const windowMock = (globalThis as typeof globalThis & { window?: any }).window ?? {};
    (globalThis as typeof globalThis & { window?: any }).window = windowMock;
    windowMock.__ELEVENEX_ELECTRON__ = {
      sshForwarding: {
        stop: vi.fn().mockResolvedValue(undefined),
      },
      browser: {
        close: vi.fn().mockResolvedValue(undefined),
      },
    };

    TestBed.configureTestingModule({
      providers: [
        EnvironmentConnectionManagerService,
        { provide: OnboardingStateService, useValue: onboardingStateMock },
        { provide: OnboardingConnectionService, useValue: onboardingConnectionMock },
        { provide: OnboardingStartupService, useValue: onboardingStartupMock },
        { provide: TabService, useValue: tabServiceMock },
        { provide: VSCodeWebStateService, useValue: vscodeWebStateMock },
        { provide: BrowserViewStateService, useValue: browserViewStateMock },
        { provide: BrowserTabsStateService, useValue: browserTabsStateMock },
        { provide: NavigationService, useValue: navigationServiceMock },
        { provide: Router, useValue: routerMock },
      ],
    });
  });

  it('switches from local to a saved remote server', async () => {
    const service = TestBed.inject(EnvironmentConnectionManagerService);

    const result = await service.switchToServer(server);

    expect(result.ok).toBe(true);
    expect(onboardingConnectionMock.connect).toHaveBeenCalledWith(expect.objectContaining({
      id: server.id,
      sshHost: server.sshHost,
    }));
    expect(onboardingStateMock.saveServer).toHaveBeenCalled();
    expect(tabServiceMock.resetForEnvironmentChange).toHaveBeenCalled();
    expect(navigationServiceMock.refreshTree).toHaveBeenCalled();
    expect(routerMock.navigate).toHaveBeenCalledWith(['/projects']);
  });

  it('switches from an active remote runtime back to local', async () => {
    snapshotState.update(current => ({
      ...current,
      mode: 'ssh',
      activeServerId: server.id,
      remoteConnectionReady: true,
    }));

    const service = TestBed.inject(EnvironmentConnectionManagerService);
    const stop = (globalThis as any).window.__ELEVENEX_ELECTRON__.sshForwarding.stop;

    const result = await service.switchToLocal();

    expect(result.ok).toBe(true);
    expect(stop).toHaveBeenCalledWith(server.id);
    expect(onboardingStateMock.setMode).toHaveBeenCalledWith('local');
    expect(navigationServiceMock.refreshTree).toHaveBeenCalled();
  });

  it('restores the previous remote server when a remote-to-remote switch fails', async () => {
    snapshotState.update(current => ({
      ...current,
      mode: 'ssh',
      activeServerId: server.id,
      remoteConnectionReady: true,
    }));
    onboardingConnectionMock.connect.mockResolvedValueOnce({
      kind: 'error',
      message: 'Target unreachable',
    });

    const alternate = { ...server, id: 18, name: 'Stage', sshHost: 'stage.example.com' };
    snapshotState.update(current => ({ ...current, servers: [server, alternate] }));

    const service = TestBed.inject(EnvironmentConnectionManagerService);
    const result = await service.switchToServer(alternate);

    expect(result.ok).toBe(false);
    expect(onboardingConnectionMock.reconnect).toHaveBeenCalledWith(server, { interactive: false });
    expect(service.switchError()).toBe('Target unreachable');
  });

  it('saves and deletes server drafts without backend persistence', () => {
    const service = TestBed.inject(EnvironmentConnectionManagerService);

    const saved = service.saveServerDraft({
      name: 'Stage',
      sshHost: 'stage.example.com',
      sshUser: 'deploy',
      sshPort: 2222,
      authMode: 'key',
      identityFilePath: '~/.ssh/stage',
    });
    service.deleteServer(saved.id);

    expect(onboardingStateMock.upsertServer).toHaveBeenCalled();
    expect(onboardingStateMock.deleteServer).toHaveBeenCalledWith(saved.id);
    expect(onboardingStateMock.saveLastSshDefaults).toHaveBeenCalled();
  });
});
