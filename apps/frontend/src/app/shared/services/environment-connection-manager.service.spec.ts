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
import { OpenWindowsService } from './open-windows.service';
import { SshRuntimeRecoveryService } from './ssh-runtime-recovery.service';
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
    wsl: null,
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
    clearStartupFailure: vi.fn(),
  };

  const sshRuntimeRecoveryMock = {
    setRemoteDisconnect: vi.fn(),
    clearRemoteDisconnect: vi.fn(),
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
        activeAgentProvider: 'claude',
        hasStartedAgentRuntime: false,
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

  // The main process's view of the open windows, which the manager consults
  // for the "open elsewhere" guards.
  let openWindows: { windowId: string; envRef: { mode: string; serverId: number | null }; label: string; focused: boolean }[];

  beforeEach(() => {
    vi.clearAllMocks();
    openWindows = [
      { windowId: 'w-test', envRef: { mode: 'local', serverId: null }, label: 'Local', focused: true },
    ];
    snapshotState.set({
      mode: 'local',
      currentStep: 'project',
      activeServerId: null,
      remoteConnectionReady: true,
      projectHandoffAcknowledged: true,
      servers: [server],
      lastSshDefaults: null,
      wsl: null,
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
    // The window id comes from the preload-injected runtime config, which is
    // also what scopes this window's storage.
    windowMock.__ELEVENEX_RUNTIME__ = { windowId: 'w-test' };
    windowMock.__ELEVENEX_ELECTRON__ = {
      sshForwarding: {
        stop: vi.fn().mockResolvedValue(undefined),
      },
      browser: {
        close: vi.fn().mockResolvedValue(undefined),
      },
      windows: {
        // Resolved lazily so a test can reassign `openWindows` after setup.
        list: vi.fn(() => Promise.resolve(openWindows)),
        openNew: vi.fn().mockResolvedValue('w-new'),
        focus: vi.fn().mockResolvedValue(true),
        setEnvironment: vi.fn().mockResolvedValue(true),
        onChanged: vi.fn(() => () => {}),
        broadcast: vi.fn().mockResolvedValue(true),
        onBroadcast: vi.fn(() => () => {}),
      },
    };

    TestBed.configureTestingModule({
      providers: [
        EnvironmentConnectionManagerService,
        { provide: OnboardingStateService, useValue: onboardingStateMock },
        { provide: OnboardingConnectionService, useValue: onboardingConnectionMock },
        { provide: OnboardingStartupService, useValue: onboardingStartupMock },
        { provide: SshRuntimeRecoveryService, useValue: sshRuntimeRecoveryMock },
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

  describe('multi-window', () => {
    function windowsApi() {
      return (globalThis as any).window.__ELEVENEX_ELECTRON__.windows;
    }

    it('tells the main process where the window ended up after a switch', async () => {
      // Without this the main process keeps the lease on the environment the
      // window just left, so its tunnel is never released and the saved layout
      // restores it on the wrong backend.
      const service = TestBed.inject(EnvironmentConnectionManagerService);

      await service.switchToServer(server);

      expect(windowsApi().setEnvironment).toHaveBeenCalledWith(
        expect.objectContaining({
          env: expect.objectContaining({ mode: 'ssh', serverId: server.id, label: 'Prod' }),
        }),
      );
    });

    it('reports the environment even when the switch failed', async () => {
      // A failed switch can still leave the window somewhere else (the
      // restore-previous path), so the bookkeeping must not be skipped.
      snapshotState.update(current => ({ ...current, mode: 'ssh', activeServerId: server.id }));
      onboardingConnectionMock.connect.mockResolvedValueOnce({ kind: 'error', message: 'nope' });
      const alternate = { ...server, id: 18, name: 'Stage' };
      snapshotState.update(current => ({ ...current, servers: [server, alternate] }));

      const service = TestBed.inject(EnvironmentConnectionManagerService);
      const result = await service.switchToServer(alternate);

      expect(result.ok).toBe(false);
      expect(windowsApi().setEnvironment).toHaveBeenCalled();
    });

    it('opens a new window on an explicit environment', async () => {
      const service = TestBed.inject(EnvironmentConnectionManagerService);

      const result = await service.openInNewWindow(server);

      expect(result.ok).toBe(true);
      expect(windowsApi().openNew).toHaveBeenCalledWith(
        expect.objectContaining({ mode: 'ssh', serverId: server.id }),
      );
    });

    it('opens a new window on the current environment', async () => {
      const service = TestBed.inject(EnvironmentConnectionManagerService);

      await service.openInNewWindow('current');

      expect(windowsApi().openNew).toHaveBeenCalledWith(
        expect.objectContaining({ mode: 'local' }),
      );
    });

    it('refuses to delete a server another window is connected to', async () => {
      openWindows = [
        { windowId: 'w-test', envRef: { mode: 'local', serverId: null }, label: 'Local', focused: true },
        { windowId: 'w-other', envRef: { mode: 'ssh', serverId: server.id }, label: 'Prod', focused: false },
      ];

      const service = TestBed.inject(EnvironmentConnectionManagerService);
      await TestBed.inject(OpenWindowsService).refresh();

      const result = service.deleteServer(server.id);

      expect(result.ok).toBe(false);
      expect(result.windowId).toBe('w-other');
      expect(onboardingStateMock.deleteServer).not.toHaveBeenCalled();
    });

    it('allows deleting a server no other window is using', async () => {
      const service = TestBed.inject(EnvironmentConnectionManagerService);
      await TestBed.inject(OpenWindowsService).refresh();

      expect(service.deleteServer(server.id).ok).toBe(true);
      expect(onboardingStateMock.deleteServer).toHaveBeenCalledWith(server.id);
    });

    it('ignores this window when deciding whether a server is in use', async () => {
      // Being connected to a server yourself must not block deleting it — the
      // existing UI already hides delete for the active server.
      openWindows = [
        { windowId: 'w-test', envRef: { mode: 'ssh', serverId: server.id }, label: 'Prod', focused: true },
      ];

      const service = TestBed.inject(EnvironmentConnectionManagerService);
      await TestBed.inject(OpenWindowsService).refresh();

      expect(service.serverDeletionBlocker(server.id)).toBeNull();
    });
  });
});
