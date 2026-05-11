import { Injectable, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { SavedServer } from '../models/onboarding.model';
import { SshForward } from '../models/ssh-forward.model';
import { OnboardingConnectionService } from './onboarding-connection.service';
import { OnboardingStateService } from './onboarding-state.service';
import { NavigationService } from './navigation.service';
import { SshForwardsService } from './ssh-forwards.service';

export interface StartupConnectionFailure {
  server: SavedServer;
  message: string;
}

export interface StartupPortForwardPromptItem {
  id: number;
  projectId: number;
  name: string;
  localPort: number;
  remoteHost: string;
  remotePort: number;
  destinationLabel: string;
}

export interface StartupPortForwardPrompt {
  serverLabel: string;
  totalCount: number;
  forwards: StartupPortForwardPromptItem[];
  startingIds: number[];
}

function normalizeUser(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function matchesServer(forward: SshForward, server: SavedServer): boolean {
  return forward.sshHost === server.sshHost
    && normalizeUser(forward.sshUser) === normalizeUser(server.sshUser)
    && forward.sshPort === server.sshPort;
}

function toPromptItem(forward: SshForward): StartupPortForwardPromptItem {
  return {
    id: forward.id,
    projectId: forward.projectId,
    name: forward.name,
    localPort: forward.localPort,
    remoteHost: forward.remoteHost,
    remotePort: forward.remotePort,
    destinationLabel: forward.destinationLabel,
  };
}

@Injectable({ providedIn: 'root' })
export class OnboardingStartupService {
  private readonly _startupFailure = signal<StartupConnectionFailure | null>(null);
  private readonly _startupPortForwardPrompt = signal<StartupPortForwardPrompt | null>(null);
  private readonly _startupConnectingServer = signal<SavedServer | null>(null);
  readonly startupFailure = this._startupFailure.asReadonly();
  readonly startupPortForwardPrompt = this._startupPortForwardPrompt.asReadonly();
  readonly startupConnectingServer = this._startupConnectingServer.asReadonly();

  constructor(
    private readonly onboardingState: OnboardingStateService,
    private readonly onboardingConnection: OnboardingConnectionService,
    private readonly sshForwardsService: SshForwardsService,
    private readonly navigationService: NavigationService,
  ) {}

  async initialize(): Promise<void> {
    const snapshot = this.onboardingState.readSnapshot();
    if (snapshot.mode !== 'ssh') {
      return;
    }

    const server = this.onboardingState.getActiveServer(snapshot);
    if (!server) {
      this.onboardingState.setRemoteConnectionReady(false);
      return;
    }

    if (server.authMode === 'password') {
      this._startupFailure.set({
        server,
        message: 'Password-based SSH connections must be reconnected manually after restarting the app.',
      });
      return;
    }

    this._startupConnectingServer.set(server);
    try {
      const result = await this.onboardingConnection.reconnect(server, { interactive: false });
      if (result.kind === 'success') {
        const nextServer: SavedServer = {
          ...server,
          localPort: result.localPort,
          installStatus: result.installStatus,
          lastConnectedAt: new Date().toISOString(),
        };
        this.onboardingState.saveServer(nextServer);
        await this.prepareStartupPortForwardPrompt(nextServer);
        this._startupFailure.set(null);
        this.navigationService.refreshTree();
        return;
      }

      this._startupFailure.set({
        server,
        message: result.message || 'Could not connect to the SSH server.',
      });
    } catch {
      this._startupFailure.set({
        server,
        message: 'An unexpected error occurred while reconnecting.',
      });
    } finally {
      this._startupConnectingServer.set(null);
    }
  }

  setStartupFailure(failure: StartupConnectionFailure) {
    this._startupFailure.set(failure);
  }

  clearStartupFailure() {
    this._startupFailure.set(null);
  }

  dismissStartupPortForwardPrompt() {
    this._startupPortForwardPrompt.set(null);
  }

  async prepareStartupPortForwardPrompt(server: SavedServer): Promise<void> {
    const allForwards = await firstValueFrom(this.sshForwardsService.getAll()).catch(() => []);
    const pending = allForwards
      .filter(forward => matchesServer(forward, server))
      .filter(forward => forward.status !== 'active' && forward.status !== 'connecting')
      .map(toPromptItem);

    if (pending.length === 0) {
      this._startupPortForwardPrompt.set(null);
      return;
    }

    this._startupPortForwardPrompt.set({
      serverLabel: server.sshUser
        ? `${server.sshUser}@${server.sshHost}:${server.sshPort}`
        : `${server.sshHost}:${server.sshPort}`,
      totalCount: pending.length,
      forwards: pending,
      startingIds: [],
    });
  }

  async startStartupPortForward(id: number): Promise<void> {
    const prompt = this._startupPortForwardPrompt();
    if (!prompt || prompt.startingIds.includes(id)) {
      return;
    }

    this.patchPrompt({
      startingIds: [...prompt.startingIds, id],
    });

    try {
      await firstValueFrom(this.sshForwardsService.start(id));
      const nextPrompt = this._startupPortForwardPrompt();
      if (!nextPrompt) {
        return;
      }

      const remaining = nextPrompt.forwards.filter(forward => forward.id !== id);
      this.commitPrompt({
        ...nextPrompt,
        forwards: remaining,
        totalCount: remaining.length,
        startingIds: nextPrompt.startingIds.filter(value => value !== id),
      });
    } catch {
      const nextPrompt = this._startupPortForwardPrompt();
      if (!nextPrompt) {
        return;
      }

      this.commitPrompt({
        ...nextPrompt,
        startingIds: nextPrompt.startingIds.filter(value => value !== id),
      });
      throw new Error(`Could not start SSH forward ${id}.`);
    }
  }

  async startAllStartupPortForwards(): Promise<void> {
    const prompt = this._startupPortForwardPrompt();
    if (!prompt) {
      return;
    }

    const ids = prompt.forwards
      .map(forward => forward.id)
      .filter(id => !prompt.startingIds.includes(id));

    await Promise.allSettled(ids.map(id => this.startStartupPortForward(id)));
  }

  private patchPrompt(patch: Partial<StartupPortForwardPrompt>) {
    const current = this._startupPortForwardPrompt();
    if (!current) {
      return;
    }

    this._startupPortForwardPrompt.set({
      ...current,
      ...patch,
    });
  }

  private commitPrompt(next: StartupPortForwardPrompt) {
    if (next.forwards.length === 0) {
      this._startupPortForwardPrompt.set(null);
      return;
    }

    this._startupPortForwardPrompt.set(next);
  }
}
