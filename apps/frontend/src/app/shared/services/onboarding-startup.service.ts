import { Injectable, signal } from '@angular/core';
import { firstValueFrom, timeout } from 'rxjs';
import { RemoteLinkService } from '@/features/remote-link/remote-link.service';
import { PairedDeviceState, SavedServer } from '../models/onboarding.model';
import { SshForward } from '../models/ssh-forward.model';
import { OnboardingConnectionService } from './onboarding-connection.service';
import { OnboardingStateService } from './onboarding-state.service';
import { ServerConnectionService } from './server-connection.service';
import { awaitConnectionOperation } from '../runtime/connection-operation';
import { NavigationService } from './navigation.service';
import { SshForwardsService } from './ssh-forwards.service';
import { ProjectsService } from './projects.service';

export interface StartupConnectionFailure {
  server: SavedServer;
  message: string;
  retryable?: boolean;
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

function matchesServer(forward: SshForward, server: SavedServer | PairedDeviceState): boolean {
  if (!('sshHost' in server)) return forward.pairedDeviceId === server.id;
  if (forward.pairedDeviceId) return false;
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

  private connectionGeneration = 0;
  private controller: AbortController | null = null;
  readonly startupVerifying = signal(false);
  private initializePromise: Promise<void> | null = null;

  constructor(
    private readonly onboardingState: OnboardingStateService,
    private readonly onboardingConnection: OnboardingConnectionService,
    private readonly sshForwardsService: SshForwardsService,
    private readonly projectsService: ProjectsService,
    private readonly navigationService: NavigationService,
    private readonly remoteLink: RemoteLinkService,
    private readonly serverConnection: ServerConnectionService,
  ) {}

  initialize(): Promise<void> {
    if (this.initializePromise) return this.initializePromise;
    const promise = this.initializeConnection().finally(() => {
      if (this.initializePromise === promise) this.initializePromise = null;
    });
    this.initializePromise = promise;
    return promise;
  }

  cancelStartupConnection(): void {
    ++this.connectionGeneration;
    this.controller?.abort();
    this.startupVerifying.set(false);
    if (this._startupConnectingServer()) this.onboardingConnection.cancelCurrentConnection();
    this._startupConnectingServer.set(null);
    this.initializePromise = null;
  }

  private async initializeConnection(): Promise<void> {
    const generation = ++this.connectionGeneration;
    const snapshot = this.onboardingState.readSnapshot();
    if (snapshot.mode === 'paired') {
      const controller = new AbortController();
      this.controller = controller;
      try {
        await this.restorePairedLink(snapshot.paired, controller.signal);
      } finally {
        if (generation === this.connectionGeneration) this.controller = null;
      }
      return;
    }

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
        message: 'Enter the SSH password to reconnect to this remote server.',
      });
      return;
    }

    this._startupConnectingServer.set(server);
    const controller = new AbortController();
    this.controller = controller;
    try {
      const result = await this.onboardingConnection.reconnect(server, { interactive: false });
      if (generation !== this.connectionGeneration) return;
      if (result.kind === 'success') {
        const nextServer: SavedServer = {
          ...server,
          localPort: result.localPort,
          installStatus: result.installStatus,
          lastConnectedAt: new Date().toISOString(),
        };
        this.onboardingState.saveServer(nextServer);
        this._startupConnectingServer.set(nextServer);
        this.startupVerifying.set(true);
        this.serverConnection.recheck();
        await awaitConnectionOperation(this.serverConnection.waitUntilInteractive(controller.signal), controller.signal, 15000);
        if (generation !== this.connectionGeneration) return;
        this._startupFailure.set(null);
        this.navigationService.refreshTree();
        this._startupConnectingServer.set(null);
        await this.prepareStartupPortForwardPrompt(nextServer);
        return;
      }

      this._startupFailure.set({
        server,
        ...(result.kind !== 'error' || result.retryable === false ? { retryable: false } : {}),
        message: result.message || 'Could not connect to the SSH server.',
      });
    } catch (error) {
      if (generation !== this.connectionGeneration) return;
      this._startupFailure.set({
        server: this._startupConnectingServer() ?? server,
        message: error instanceof Error ? error.message : 'An unexpected error occurred while reconnecting.',
      });
    } finally {
      if (generation === this.connectionGeneration) {
        this._startupConnectingServer.set(null);
        this.startupVerifying.set(false);
        this.controller = null;
      }
    }
  }

  /**
   * Brings a paired desktop's link back up for a window that reopened on one.
   *
   * The link client lives in the main process and is torn down with the last
   * window holding it, so a window restored onto a paired desktop remembers the
   * device but has nothing behind its loopback port. This is the paired
   * equivalent of the SSH reconnect above; without it the window keeps the
   * device's name and the previous run's dead port for the rest of its life.
   */
  private async restorePairedLink(paired: PairedDeviceState | null, signal: AbortSignal): Promise<void> {
    if (!paired) {
      this.onboardingState.setRemoteConnectionReady(false);
      return;
    }

    // The remembered port belonged to the previous run's listener, so nothing
    // may open a socket against it until the link reports a live one.
    this.onboardingState.setRemoteConnectionReady(false);

    try {
      await this.remoteLink.connect(paired.id, signal);
      if (signal.aborted) return;
      if (!signal.aborted) this.navigationService.refreshTree();
      await this.prepareStartupPortForwardPrompt(paired);
    } catch {
      // Nothing to retry against here — the device row in the environment
      // switcher carries the link's real status, and selecting it retries with
      // the error surfaced.
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

  async prepareStartupPortForwardPrompt(server: SavedServer | PairedDeviceState): Promise<void> {
    const generation = this.connectionGeneration;
    const [allForwards, activeProjects] = await Promise.all([
      firstValueFrom(this.sshForwardsService.getAll().pipe(timeout(8000))).catch(() => []),
      firstValueFrom(this.projectsService.getAll('active').pipe(timeout(8000))).catch(() => []),
    ]);
    if (generation !== this.connectionGeneration) return;
    const activeProjectIds = new Set(activeProjects.map(p => p.id));
    const pending = allForwards
      .filter(forward => matchesServer(forward, server))
      .filter(forward => activeProjectIds.has(forward.projectId))
      .filter(forward => !forward.running && forward.status !== 'active' && forward.status !== 'connecting')
      .map(toPromptItem);

    if (pending.length === 0) {
      this._startupPortForwardPrompt.set(null);
      return;
    }

    this._startupPortForwardPrompt.set({
      serverLabel: !('sshHost' in server) ? server.name : server.sshUser
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
      throw new Error(`Could not start port forward ${id}.`);
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
