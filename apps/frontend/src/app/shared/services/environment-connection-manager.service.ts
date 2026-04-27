import { Injectable, computed, inject, signal } from '@angular/core';
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
import { getElectronBrowserApi } from '@/shared/runtime/electron-browser';
import { getElectronSshForwardingApi } from '@/shared/runtime/electron-ssh-forwarding';

import { NavigationService } from './navigation.service';
import { OnboardingConnectionService } from './onboarding-connection.service';
import { OnboardingStartupService } from './onboarding-startup.service';
import { OnboardingStateService } from './onboarding-state.service';

export interface SavedServerDraft {
  id?: number;
  name: string;
  sshHost: string;
  sshUser?: string | null;
  sshPort: number;
  authMode: ServerAuthMode;
  identityFilePath?: string | null;
}

function buildRandomPortSeed() {
  return ELEVENEX_REMOTE_PORT + 100 + Math.floor(Math.random() * 4000);
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

  readonly switching = signal(false);
  readonly switchError = signal('');
  readonly pendingTargetLabel = signal('');
  readonly snapshot = this.onboardingState.snapshotState;

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

    return 'Local';
  });

  async switchToLocal(): Promise<{ ok: boolean; error?: string }> {
    return this.runSwitch('Local workspace', async () => {
      await this.stopActiveRemoteTunnel();
      this.onboardingState.setMode('local');
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
        await this.finalizeWorkspaceHandoff();
      } catch (error) {
        await this.restorePreviousRemote(previousServer);
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
      localPort: existing?.localPort ?? buildRandomPortSeed(),
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

  deleteServer(id: number): void {
    this.onboardingState.deleteServer(id);
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
      return { ok: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not switch environments.';
      this.switchError.set(message);
      return { ok: false, error: message };
    } finally {
      this.switching.set(false);
      this.pendingTargetLabel.set('');
    }
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

  private async restorePreviousRemote(server: SavedServer | null): Promise<void> {
    if (!server || server.authMode === 'password') {
      return;
    }

    const result = await this.onboardingConnection.reconnect(server, { interactive: false }).catch(() => null);
    if (!result || result.kind !== 'success') {
      return;
    }

    const restoredServer: SavedServer = {
      ...server,
      localPort: result.localPort,
      installStatus: result.installStatus,
      lastConnectedAt: new Date().toISOString(),
    };
    this.onboardingState.saveServer(restoredServer);
    await this.onboardingStartup.prepareStartupPortForwardPrompt(restoredServer).catch(() => undefined);
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
