import { Injectable, signal } from '@angular/core';

import {
  ElectronWslServerEnsureReadyPayload,
  ElectronWslServerEnsureReadyResult,
  getElectronWslServerApi,
} from '../runtime/electron-wsl-server';

export interface WslInstallFlowState {
  sessionId: number;
  payload: ElectronWslServerEnsureReadyPayload;
  result: ElectronWslServerEnsureReadyResult;
  terminalOutput: string[];
  terminalExited: boolean;
  terminalError: string | null;
  checking: boolean;
}

// Mirrors RemoteInstallFlowService exactly, but talks to the WSL IPC bridge.
// Kept as a separate service (rather than parametrizing the SSH one) because
// the SSH version is hardwired to getElectronRemoteServerApi() and shared by
// other SSH-only consumers — duplicating this ~140-line glue layer is safer
// than threading a transport parameter through it.
@Injectable({ providedIn: 'root' })
export class WslInstallFlowService {
  private readonly _state = signal<WslInstallFlowState | null>(null);
  readonly state = this._state.asReadonly();

  private pendingResolver: ((result: ElectronWslServerEnsureReadyResult) => void) | null = null;
  private removeInstallerListener: (() => void) | null = null;

  constructor() {
    const api = getElectronWslServerApi();
    if (api?.onInstallerEvent) {
      this.removeInstallerListener = api.onInstallerEvent((event) => {
        const current = this._state();
        if (!current || current.sessionId !== event.sessionId) {
          return;
        }

        if (event.type === 'data' && event.data) {
          this._state.set({
            ...current,
            terminalOutput: [...current.terminalOutput, event.data],
          });
          return;
        }

        if (event.type === 'error') {
          this._state.set({
            ...current,
            terminalError: event.message || 'WSL installer terminal failed.',
          });
          return;
        }

        if (event.type === 'exit' || event.type === 'closed') {
          this._state.set({
            ...current,
            terminalExited: true,
          });
        }
      });
    }
  }

  async ensureReady(
    payload: ElectronWslServerEnsureReadyPayload,
  ): Promise<ElectronWslServerEnsureReadyResult> {
    const api = getElectronWslServerApi();
    if (!api) {
      return {
        status: 'unsupported',
        installPhase: 'checking',
        installStatus: 'unknown',
        remotePlatform: 'unknown',
        remoteArch: 'unknown',
        missingDependencies: [],
        message: 'WSL backend connections are only available in the Electron app.',
        localPort: null,
        sessionId: null,
        osRelease: {},
        installGuidance: [],
        version: null,
        distroName: null,
      };
    }

    const initialResult = await api.ensureReady(payload);
    return this.handleEnsureReadyResult(payload, initialResult);
  }

  async recheck(): Promise<void> {
    const current = this._state();
    const api = getElectronWslServerApi();
    if (!current || !api) {
      return;
    }

    this._state.set({
      ...current,
      checking: true,
      terminalError: null,
    });

    const nextResult = await api.recheck({
      ...current.payload,
      sessionId: current.sessionId,
    });
    const pendingPayload = current.payload;
    await this.handleEnsureReadyResult(pendingPayload, nextResult);
  }

  async sendInput(data: string): Promise<void> {
    const current = this._state();
    const api = getElectronWslServerApi();
    if (!current || !api) {
      return;
    }

    await api.sendInput({ sessionId: current.sessionId, data });
  }

  async resize(cols: number, rows: number): Promise<void> {
    const current = this._state();
    const api = getElectronWslServerApi();
    if (!current || !api) {
      return;
    }

    await api.resize({ sessionId: current.sessionId, cols, rows });
  }

  async cancel(): Promise<void> {
    const current = this._state();
    const api = getElectronWslServerApi();
    if (!current) {
      return;
    }

    await api?.closeSession(current.sessionId).catch(() => undefined);
    const resolver = this.pendingResolver;
    this.pendingResolver = null;
    this._state.set(null);
    resolver?.({
      ...current.result,
      status: 'error',
      message: 'WSL install was canceled.',
    });
  }

  private async handleEnsureReadyResult(
    payload: ElectronWslServerEnsureReadyPayload,
    result: ElectronWslServerEnsureReadyResult,
  ): Promise<ElectronWslServerEnsureReadyResult> {
    if (result.status !== 'waiting-for-user' || !result.sessionId) {
      const currentSessionId = this._state()?.sessionId ?? null;
      const resolver = this.pendingResolver;
      this.pendingResolver = null;
      this._state.set(null);
      if (currentSessionId !== null) {
        void getElectronWslServerApi()?.closeSession(currentSessionId).catch(() => undefined);
      }
      resolver?.(result);
      return result;
    }

    const current = this._state();
    const nextState: WslInstallFlowState = {
      sessionId: result.sessionId,
      payload,
      result,
      terminalOutput: current?.sessionId === result.sessionId ? current.terminalOutput : [],
      terminalExited: false,
      terminalError: null,
      checking: false,
    };
    this._state.set(nextState);

    if (this.pendingResolver) {
      return new Promise((resolve) => {
        const previousResolver = this.pendingResolver;
        this.pendingResolver = (finalResult) => {
          previousResolver?.(finalResult);
          resolve(finalResult);
        };
      });
    }

    return new Promise((resolve) => {
      this.pendingResolver = resolve;
    });
  }
}
