import { Injectable, computed, effect, inject, signal } from '@angular/core';
import { Router } from '@angular/router';

import {
  BrowserViewStateService,
  buildBrowserViewProjectPrefix,
} from '@/features/browser-panel/browser-view-state.service';
import { BrowserTabsStateService } from '@/features/browser-panel/browser-tabs-state.service';
import { TabService } from '@/features/session/tab-service';
import { buildVSCodeIframeKey, VSCodeWebStateService } from '@/features/vscode-web/vscode-web-state.service';
import { ELEVENEX_REMOTE_PORT } from '@/shared/constants/elevenex';
import { OnboardingLastSshDefaults, SavedServer, ServerAuthMode } from '@/shared/models/onboarding.model';
import { getElectronWslServerApi } from '@/shared/runtime/electron-wsl-server';
import { getElectronBrowserApi } from '@/shared/runtime/electron-browser';
import { getElectronSshForwardingApi } from '@/shared/runtime/electron-ssh-forwarding';
import { ElectronEnvironmentRef, getElectronWindowsApi } from '@/shared/runtime/electron-windows';
import { getBackendOrigin } from '@/shared/runtime/runtime-config';

import { NavigationService } from './navigation.service';
import { OnboardingConnectionService } from './onboarding-connection.service';
import { OnboardingStartupService } from './onboarding-startup.service';
import { OnboardingStateService } from './onboarding-state.service';
import { OpenWindowsService } from './open-windows.service';
import { SshRuntimeRecoveryService } from './ssh-runtime-recovery.service';

export interface SavedServerDraft {
  id?: number;
  name: string;
  sshHost: string;
  sshUser?: string | null;
  sshPort: number;
  authMode: ServerAuthMode;
  identityFilePath?: string | null;
}

function normalizeDraft(draft: SavedServerDraft): SavedServerDraft {
  return {
    id: draft.id,
    name: draft.name.trim(),
    sshHost: draft.sshHost.trim(),
    sshUser: draft.sshUser?.trim() || null,
    sshPort: draft.sshPort,
    authMode: draft.authMode,
    identityFilePath: draft.identityFilePath?.trim() || null,
  };
}

@Injectable({ providedIn: 'root' })
export class EnvironmentConnectionManagerService {
  private readonly router = inject(Router);
  private readonly onboardingState = inject(OnboardingStateService);
  private readonly onboardingConnection = inject(OnboardingConnectionService);
  private readonly onboardingStartup = inject(OnboardingStartupService);
  private readonly tabService = inject(TabService);
  private readonly vscodeWebState = inject(VSCodeWebStateService);
  private readonly browserViewState = inject(BrowserViewStateService);
  private readonly browserTabsState = inject(BrowserTabsStateService);
  private readonly navigationService = inject(NavigationService);
  private readonly sshRuntimeRecovery = inject(SshRuntimeRecoveryService);
  private readonly openWindows = inject(OpenWindowsService);

  readonly switching = signal(false);
  readonly switchError = signal('');
  readonly pendingTargetLabel = signal('');
  readonly snapshot = this.onboardingState.snapshotState;

  private publishedEnvironment: string | null = null;

  constructor() {
    // Catches every path that changes this window's environment without going
    // through switchTo*(): the startup reconnect, tunnel recovery, and
    // finishing onboarding all move the window to a different backend.
    effect(() => {
      this.snapshot();
      void this.publishEnvironmentToMainProcess();
    });
  }

  readonly activeServer = computed(() => this.onboardingState.getActiveServer(this.snapshot()));
  readonly savedServers = computed(() =>
    [...this.snapshot().servers].sort((left, right) => {
      if (left.id === this.snapshot().activeServerId) return -1;
      if (right.id === this.snapshot().activeServerId) return 1;
      return left.name.localeCompare(right.name);
    }),
  );
  readonly environmentLabel = computed(() => {
    const snapshot = this.snapshot();
    if (snapshot.mode === 'ssh') {
      return this.activeServer()?.name || 'Remote server';
    }
    if (snapshot.mode === 'wsl') {
      return snapshot.wsl?.distroName ? `WSL: ${snapshot.wsl.distroName}` : 'WSL backend';
    }

    return 'Local';
  });

  async switchToLocal(): Promise<{ ok: boolean; error?: string }> {
    return this.runSwitch('Local workspace', async () => {
      await this.stopActiveRemoteTunnel();
      this.onboardingState.setMode('local');
      this.sshRuntimeRecovery.clearRemoteDisconnect();
      this.onboardingStartup.clearStartupFailure();
      await this.finalizeWorkspaceHandoff();
    });
  }

  async isWslSupported(): Promise<boolean> {
    try {
      return (await getElectronWslServerApi()?.isSupported()) ?? false;
    } catch {
      return false;
    }
  }

  // WSL is a single, always-visible connection like Local — no draft/name to
  // gather first, and (unlike SSH) nothing to tear down on switch-away since
  // there is no tunnel, only a local wsl.exe process spawn.
  async switchToWsl(distroName?: string | null): Promise<{ ok: boolean; error?: string }> {
    const label = distroName ? `WSL: ${distroName}` : 'WSL backend';
    return this.runSwitch(label, async () => {
      await this.stopActiveRemoteTunnel();
      const result = await this.onboardingConnection.connectWsl(distroName);
      if (result.kind !== 'success') {
        throw new Error(result.message || 'Could not connect to WSL.');
      }

      this.onboardingState.setWslState({
        distroName: result.distroName,
        localPort: result.localPort,
        installStatus: result.installStatus,
        lastConnectedAt: new Date().toISOString(),
      });
      this.sshRuntimeRecovery.clearRemoteDisconnect();
      this.onboardingStartup.clearStartupFailure();
      await this.finalizeWorkspaceHandoff();
    });
  }

  async switchToServer(
    server: SavedServer,
    options: { password?: string; passphrase?: string } = {},
  ): Promise<{ ok: boolean; error?: string }> {
    return this.runSwitch(server.name, async () => {
      const currentActive = this.activeServer();
      const wasActive = this.snapshot().mode === 'ssh' && currentActive?.id === server.id && this.snapshot().remoteConnectionReady;
      if (wasActive) {
        this.sshRuntimeRecovery.clearRemoteDisconnect();
        this.onboardingStartup.clearStartupFailure();
        await this.finalizeWorkspaceHandoff();
        return;
      }

      const previousServer = currentActive;
      await this.stopActiveRemoteTunnel();

      try {
        const result = await this.onboardingConnection.connect({
          id: server.id,
          name: server.name,
          sshHost: server.sshHost,
          sshUser: server.sshUser ?? undefined,
          sshPort: server.sshPort,
          authMode: server.authMode,
          password: options.password,
          identityFilePath: server.identityFilePath,
          passphrase: options.passphrase,
        });

        if (result.kind !== 'success') {
          throw new Error(result.message || 'Could not connect to the selected server.');
        }

        this.onboardingState.saveServer({
          ...server,
          localPort: result.localPort,
          installStatus: result.installStatus,
          lastConnectedAt: new Date().toISOString(),
        });
        await this.onboardingStartup.prepareStartupPortForwardPrompt({
          ...server,
          localPort: result.localPort,
          installStatus: result.installStatus,
          lastConnectedAt: new Date().toISOString(),
        });
        this.sshRuntimeRecovery.clearRemoteDisconnect();
        this.onboardingStartup.clearStartupFailure();
        await this.finalizeWorkspaceHandoff();
      } catch (error) {
        const restored = await this.restorePreviousRemote(previousServer);
        const message = error instanceof Error ? error.message : 'Could not connect to the selected server.';
        const overlayServer = restored ?? previousServer ?? server;
        this.sshRuntimeRecovery.setRemoteDisconnect(overlayServer, message);
        throw error;
      }
    });
  }

  saveServerDraft(draft: SavedServerDraft): SavedServer {
    const normalized = normalizeDraft(draft);
    const now = new Date().toISOString();
    const nextId = normalized.id ?? Date.now();
    const existing = this.savedServers().find(server => server.id === nextId) ?? null;
    const nextServer: SavedServer = {
      id: nextId,
      name: normalized.name || normalized.sshHost || 'Remote server',
      sshHost: normalized.sshHost,
      sshUser: normalized.sshUser ?? null,
      sshPort: normalized.sshPort,
      authMode: normalized.authMode,
      identityFilePath: normalized.identityFilePath ?? null,
      localPort: existing?.localPort ?? 0,
      remotePort: existing?.remotePort ?? ELEVENEX_REMOTE_PORT,
      installStatus: existing?.installStatus ?? 'unknown',
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      lastConnectedAt: existing?.lastConnectedAt ?? now,
    };

    this.onboardingState.upsertServer(nextServer);
    this.onboardingState.saveLastSshDefaults(this.toDefaults(nextServer));
    return nextServer;
  }

  /**
   * A server another window is currently connected to cannot be removed: the
   * catalogue is shared, so deleting it here would pull the environment out
   * from under a window the user can still see.
   */
  serverDeletionBlocker(id: number): { windowLabel: string; windowId: string } | null {
    const others = this.openWindows.othersOn({ mode: 'ssh', serverId: id });
    const blocker = others[0];
    return blocker ? { windowLabel: blocker.label, windowId: blocker.windowId } : null;
  }

  deleteServer(id: number): { ok: boolean; error?: string; windowId?: string } {
    const blocker = this.serverDeletionBlocker(id);
    if (blocker) {
      return {
        ok: false,
        error: `“${blocker.windowLabel}” is open in another window. Close that window first.`,
        windowId: blocker.windowId,
      };
    }

    this.onboardingState.deleteServer(id);
    return { ok: true };
  }

  focusWindow(windowId: string): Promise<boolean> {
    return this.openWindows.focusWindow(windowId);
  }

  async stopTunnelForServer(id: number): Promise<void> {
    const api = getElectronSshForwardingApi();
    if (!api) {
      return;
    }

    await api.stop(id).catch(() => undefined);
  }

  clearError() {
    this.switchError.set('');
  }

  private async runSwitch(label: string, action: () => Promise<void>): Promise<{ ok: boolean; error?: string }> {
    if (this.switching()) {
      return { ok: false, error: 'A connection switch is already in progress.' };
    }

    this.switching.set(true);
    this.switchError.set('');
    this.pendingTargetLabel.set(label);

    try {
      await action();
      await this.publishEnvironmentToMainProcess();
      return { ok: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not switch environments.';
      this.switchError.set(message);
      // A failed switch may still have left this window somewhere else (the
      // restore-previous path), so the main process is told either way.
      await this.publishEnvironmentToMainProcess();
      return { ok: false, error: message };
    } finally {
      this.switching.set(false);
      this.pendingTargetLabel.set('');
    }
  }

  /** The environment this window is currently on, as the main process sees it. */
  currentEnvironmentRef(): ElectronEnvironmentRef {
    const snapshot = this.snapshot();
    if (snapshot.mode === 'ssh') {
      const server = this.onboardingState.getActiveServer(snapshot);
      if (server) {
        return { mode: 'ssh', serverId: server.id, label: server.name || server.sshHost };
      }
    }
    if (snapshot.mode === 'wsl') {
      return { mode: 'wsl', serverId: null, label: this.environmentLabel() };
    }

    return { mode: 'local', serverId: null, label: 'Local' };
  }

  environmentRefForServer(server: SavedServer): ElectronEnvironmentRef {
    return { mode: 'ssh', serverId: server.id, label: server.name || server.sshHost };
  }

  /**
   * Tells the main process where this window ended up.
   *
   * Load-bearing rather than cosmetic: the refcounted SSH tunnel leases, the
   * window title, the MCP callback origin and the layout persisted for the next
   * launch all live in the main process, and none of them can follow a change
   * they are not told about.
   *
   * De-duplicated because two paths reach it: an explicit switch (which reports
   * as soon as it settles, deterministically) and a snapshot effect that
   * catches everything else — startup reconnects, tunnel recovery, onboarding.
   */
  private async publishEnvironmentToMainProcess(): Promise<void> {
    const api = getElectronWindowsApi();
    if (!api) {
      return;
    }

    const env = this.currentEnvironmentRef();
    const backendOrigin = getBackendOrigin();
    const fingerprint = `${env.mode}:${env.serverId ?? ''}:${env.label}:${backendOrigin}`;
    if (fingerprint === this.publishedEnvironment) {
      return;
    }
    this.publishedEnvironment = fingerprint;

    try {
      await api.setEnvironment({ env, backendOrigin });
    } catch {
      // Retry on the next change rather than pinning a stale fingerprint.
      this.publishedEnvironment = null;
    }
  }

  /**
   * Opens another window on `target`, leaving this one exactly as it is. When
   * the environment is already connected the tunnel is reused, so the window
   * appears immediately with no connection overlay.
   */
  async openInNewWindow(target: 'current' | 'local' | 'wsl' | SavedServer): Promise<{ ok: boolean; error?: string }> {
    if (!this.openWindows.isMultiWindowSupported) {
      return { ok: false, error: 'Multiple windows are only available in the desktop app.' };
    }

    let env: ElectronEnvironmentRef;
    if (target === 'current') {
      env = this.currentEnvironmentRef();
    } else if (target === 'local') {
      env = { mode: 'local', serverId: null, label: 'Local' };
    } else if (target === 'wsl') {
      env = { mode: 'wsl', serverId: null, label: 'WSL backend' };
    } else {
      env = this.environmentRefForServer(target);
    }

    const ok = await this.openWindows.openWindow(env);
    return ok ? { ok: true } : { ok: false, error: 'Could not open a new window.' };
  }

  private async stopActiveRemoteTunnel(): Promise<void> {
    const snapshot = this.snapshot();
    const activeServer = this.onboardingState.getActiveServer(snapshot);
    if (snapshot.mode !== 'ssh' || !activeServer) {
      return;
    }

    await this.stopTunnelForServer(activeServer.id);
    this.onboardingState.setRemoteConnectionReady(false);
  }

  private async finalizeWorkspaceHandoff(): Promise<void> {
    this.clearWorkspaceState();
    this.navigationService.refreshTree();
    await this.router.navigate(['/projects']);
  }

  private async restorePreviousRemote(server: SavedServer | null): Promise<SavedServer | null> {
    if (!server) {
      return null;
    }

    if (server.authMode === 'password') {
      // Can't auto-reconnect password servers, but keep them as the active context
      // so the workspace stays mounted and the disconnect overlay can show.
      this.onboardingState.upsertServer(server, { activate: true });
      return server;
    }

    const result = await this.onboardingConnection.reconnect(server, { interactive: false }).catch(() => null);
    if (!result || result.kind !== 'success') {
      this.onboardingState.upsertServer(server, { activate: true });
      return server;
    }

    const restoredServer: SavedServer = {
      ...server,
      localPort: result.localPort,
      installStatus: result.installStatus,
      lastConnectedAt: new Date().toISOString(),
    };
    this.onboardingState.saveServer(restoredServer);
    await this.onboardingStartup.prepareStartupPortForwardPrompt(restoredServer).catch(() => undefined);
    return restoredServer;
  }

  private clearWorkspaceState(): void {
    const openTabs = this.tabService.tabs();
    const browserApi = getElectronBrowserApi();

    for (const tab of openTabs) {
      this.vscodeWebState.destroyIframe(buildVSCodeIframeKey(tab.projectId, tab.worktreePath));
    }

    const projectIds = new Set(openTabs.map(tab => tab.projectId));
    for (const key of this.browserViewState.states().keys()) {
      const match = /^project:(\d+):tab:/.exec(key);
      if (match) {
        projectIds.add(Number(match[1]));
      }
    }
    for (const projectId of projectIds) {
      const browserPrefix = buildBrowserViewProjectPrefix(projectId);
      const browserKeys = Array.from(this.browserViewState.states().keys())
        .filter(key => key.startsWith(browserPrefix));

      this.browserTabsState.removeProject(projectId);
      this.browserViewState.removeStatesByPrefix(browserPrefix);
      for (const key of browserKeys) {
        void browserApi?.close(key);
      }
    }

    this.tabService.resetForEnvironmentChange();
  }

  private toDefaults(server: SavedServer): OnboardingLastSshDefaults {
    return {
      name: server.name,
      sshHost: server.sshHost,
      sshUser: server.sshUser,
      sshPort: server.sshPort,
      authMode: server.authMode,
      identityFilePath: server.identityFilePath,
    };
  }
}
