import { Injectable, signal } from '@angular/core';
import { ELEVENEX_REMOTE_PORT } from '../constants/elevenex';
import { SavedServer, ServerAuthMode, ServerInstallStatus } from '../models/onboarding.model';
import { getElectronSshForwardingApi } from '../runtime/electron-ssh-forwarding';
import { ElectronRemoteServerEnsureReadyPayload, RemoteInstallPhase, getElectronRemoteServerApi } from '../runtime/electron-remote-server';
import { RemoteInstallFlowService } from './remote-install-flow.service';

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

@Injectable({ providedIn: 'root' })
export class OnboardingConnectionService {
  private readonly _currentPhase = signal<RemoteInstallPhase | null>(null);
  readonly currentPhase = this._currentPhase.asReadonly();

  private activeServerId: number | null = null;
  private removePhaseListener: (() => void) | null = null;

  constructor(private readonly remoteInstallFlow: RemoteInstallFlowService) {
    const api = getElectronRemoteServerApi();
    if (api?.onPhaseUpdate) {
      this.removePhaseListener = api.onPhaseUpdate((event) => {
        if (event.serverId === this.activeServerId) {
          this._currentPhase.set(event.phase);
        }
      });
    }
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
    options: { interactive?: boolean } = {},
  ): Promise<OnboardingConnectionResult> {
    if (server.authMode === 'password') {
      return {
        kind: 'error',
        message: 'Password-based SSH connections must be reconnected manually after restarting the app.',
      };
    }

    return this.startTunnel({
      id: server.id,
      sshHost: server.sshHost,
      sshUser: server.sshUser,
      sshPort: server.sshPort,
      authMode: server.authMode,
      password: null,
      identityFilePath: server.identityFilePath,
      passphrase: null,
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
