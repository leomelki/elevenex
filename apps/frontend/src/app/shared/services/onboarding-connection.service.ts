import { Injectable, signal } from '@angular/core';
import { ELEVENEX_REMOTE_PORT } from '../constants/elevenex';
import { SavedServer, ServerAuthMode, ServerInstallStatus } from '../models/onboarding.model';
import { getElectronSshForwardingApi } from '../runtime/electron-ssh-forwarding';
import { ElectronRemoteServerEnsureReadyPayload, RemoteInstallPhase, getElectronRemoteServerApi } from '../runtime/electron-remote-server';
import { getElectronWslServerApi, WSL_SERVER_ID } from '../runtime/electron-wsl-server';
import { RemoteInstallFlowService } from './remote-install-flow.service';
import { WslInstallFlowService } from './wsl-install-flow.service';

export interface OnboardingConnectPayload {
  id?: number;
  name: string;
  sshHost: string;
  sshUser?: string;
  sshPort: number;
  authMode: ServerAuthMode;
  password?: string;
  identityFilePath?: string | null;
  passphrase?: string;
}

export interface OnboardingConnectionSuccess {
  kind: 'success';
  serverId: number;
  localPort: number;
  installStatus: ServerInstallStatus;
}

export interface OnboardingConnectionFailure {
  kind: 'missing-install' | 'error' | 'unsupported';
  message: string;
}

export type OnboardingConnectionResult =
  | OnboardingConnectionSuccess
  | OnboardingConnectionFailure;

export interface OnboardingWslConnectionSuccess {
  kind: 'success';
  distroName: string | null;
  localPort: number;
  installStatus: ServerInstallStatus;
}

export type OnboardingWslConnectionResult =
  | OnboardingWslConnectionSuccess
  | OnboardingConnectionFailure;

@Injectable({ providedIn: 'root' })
export class OnboardingConnectionService {
  private readonly _currentPhase = signal<RemoteInstallPhase | null>(null);
  readonly currentPhase = this._currentPhase.asReadonly();

  private activeServerId: number | null = null;
  private removePhaseListener: (() => void) | null = null;
  private removeWslPhaseListener: (() => void) | null = null;

  constructor(
    private readonly remoteInstallFlow: RemoteInstallFlowService,
    private readonly wslInstallFlow: WslInstallFlowService,
  ) {
    const api = getElectronRemoteServerApi();
    if (api?.onPhaseUpdate) {
      this.removePhaseListener = api.onPhaseUpdate((event) => {
        if (event.serverId === this.activeServerId) {
          this._currentPhase.set(event.phase);
        }
      });
    }

    const wslApi = getElectronWslServerApi();
    if (wslApi?.onPhaseUpdate) {
      this.removeWslPhaseListener = wslApi.onPhaseUpdate((event) => {
        if (event.serverId === WSL_SERVER_ID) {
          this._currentPhase.set(event.phase);
        }
      });
    }
  }

  async isWslSupported(): Promise<boolean> {
    const api = getElectronWslServerApi();
    if (!api) {
      return false;
    }

    try {
      return await api.isSupported();
    } catch {
      return false;
    }
  }

  // Connects to the singleton WSL backend (see WslConnectionState doc comment
  // in onboarding.model.ts) — no host/user/port/auth to gather first, unlike
  // connect() for SSH. distroName omitted picks WSL's own default distro.
  //
  // Deliberately does NOT gate on isWslSupported() here (that also requires
  // WSL itself to already be installed) — ensureReady() below still runs so
  // the "WSL isn't installed, run `wsl --install`" guidance from the main
  // process (see ensureWslServerReady in main.cjs) reaches the user, instead
  // of a generic "not available" message.
  async connectWsl(distroName?: string | null): Promise<OnboardingWslConnectionResult> {
    if (!getElectronWslServerApi()) {
      return {
        kind: 'unsupported',
        message: 'WSL backend connections are only available in the Electron app.',
      };
    }

    this._currentPhase.set(null);

    let runtime;
    try {
      runtime = await this.wslInstallFlow.ensureReady({ distroName: distroName ?? null });
    } finally {
      this._currentPhase.set(null);
    }

    if (runtime.status === 'waiting-for-user') {
      return {
        kind: 'missing-install',
        message: runtime.message || 'Install the missing requirements inside WSL and retry.',
      };
    }

    if (runtime.status === 'unsupported') {
      return {
        kind: 'unsupported',
        message: runtime.message || 'WSL is not available on this machine.',
      };
    }

    if (runtime.status === 'ready') {
      return {
        kind: 'success',
        distroName: runtime.distroName ?? distroName ?? null,
        localPort: runtime.localPort ?? 0,
        installStatus: runtime.installStatus ?? 'available',
      };
    }

    return {
      kind: 'error',
      message: runtime.message || 'Could not connect to WSL.',
    };
  }

  async isSupported(): Promise<boolean> {
    const api = getElectronSshForwardingApi();
    if (!api) {
      return false;
    }

    try {
      return await api.isSupported();
    } catch {
      return false;
    }
  }

  async pickIdentityFile(): Promise<string | null> {
    const api = getElectronSshForwardingApi();
    if (!api?.pickIdentityFile) {
      return null;
    }

    return api.pickIdentityFile();
  }

  async connect(payload: OnboardingConnectPayload): Promise<OnboardingConnectionResult> {
    return this.startTunnel({
      id: payload.id ?? Date.now(),
      sshHost: payload.sshHost.trim(),
      sshUser: payload.sshUser?.trim() || null,
      sshPort: payload.sshPort,
      authMode: payload.authMode,
      password: payload.password?.trim() || null,
      identityFilePath: payload.identityFilePath?.trim() || null,
      passphrase: payload.passphrase?.trim() || null,
    }, { interactive: true });
  }

  async reconnect(
    server: SavedServer,
    options: { interactive?: boolean; password?: string; passphrase?: string } = {},
  ): Promise<OnboardingConnectionResult> {
    const password = options.password?.trim() || null;
    if (server.authMode === 'password' && !password) {
      return {
        kind: 'error',
        message: 'Enter the SSH password to reconnect to this remote server.',
      };
    }

    return this.startTunnel({
      id: server.id,
      sshHost: server.sshHost,
      sshUser: server.sshUser,
      sshPort: server.sshPort,
      authMode: server.authMode,
      password,
      identityFilePath: server.identityFilePath,
      passphrase: options.passphrase?.trim() || null,
    }, { interactive: options.interactive ?? true });
  }

  private async startTunnel(payload: {
    id: number;
    sshHost: string;
    sshUser: string | null;
    sshPort: number;
    authMode: ServerAuthMode;
    password: string | null;
    identityFilePath: string | null;
    passphrase: string | null;
  }, options: { interactive: boolean }): Promise<OnboardingConnectionResult> {
    if (!(await this.isSupported())) {
      return {
        kind: 'unsupported',
        message: 'SSH onboarding is only available in the Electron app.',
      };
    }

    this.activeServerId = payload.id;
    this._currentPhase.set(null);

    const runtimePayload: ElectronRemoteServerEnsureReadyPayload = {
      id: payload.id,
      sshHost: payload.sshHost,
      sshUser: payload.sshUser,
      sshPort: payload.sshPort,
      bindAddress: '127.0.0.1',
      remoteHost: '127.0.0.1',
      remotePort: ELEVENEX_REMOTE_PORT,
      authMode: payload.authMode,
      password: payload.password,
      identityFilePath: payload.identityFilePath,
      passphrase: payload.passphrase,
      sessionId: null,
    };

    let runtime;
    try {
      runtime = options.interactive
        ? await this.remoteInstallFlow.ensureReady(runtimePayload)
        : await getElectronRemoteServerApi()?.ensureReady(runtimePayload);
    } finally {
      this.activeServerId = null;
      this._currentPhase.set(null);
    }

    if (!runtime) {
      return {
        kind: 'unsupported',
        message: 'Remote server install is only available in the Electron app.',
      };
    }

    if (runtime.status === 'waiting-for-user') {
      return {
        kind: 'missing-install',
        message: runtime.message || 'Install the missing requirements on the remote server and retry.',
      };
    }

    if (runtime.status === 'unsupported') {
      return {
        kind: 'unsupported',
        message: runtime.message || 'This remote server platform is not supported yet.',
      };
    }

    if (runtime.status === 'ready') {
      return {
        kind: 'success',
        serverId: payload.id,
        localPort: runtime.localPort ?? 0,
        installStatus: runtime.installStatus ?? 'available',
      };
    }

    return {
      kind: 'error',
      message: runtime.message || 'Could not connect to the SSH server.',
    };
  }
}
