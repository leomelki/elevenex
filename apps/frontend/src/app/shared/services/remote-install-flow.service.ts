import { Injectable, signal } from '@angular/core';

import {
  ElectronRemoteServerEnsureReadyPayload,
  ElectronRemoteServerEnsureReadyResult,
  getElectronRemoteServerApi,
} from '../runtime/electron-remote-server';

export interface RemoteInstallFlowState {
  sessionId: number;
  payload: ElectronRemoteServerEnsureReadyPayload;
  result: ElectronRemoteServerEnsureReadyResult;
  terminalOutput: string[];
  terminalExited: boolean;
  terminalError: string | null;
  checking: boolean;
}

@Injectable({ providedIn: 'root' })
export class RemoteInstallFlowService {
  private readonly _state = signal<RemoteInstallFlowState | null>(null);
  readonly state = this._state.asReadonly();

  private pendingResolver: ((result: ElectronRemoteServerEnsureReadyResult) => void) | null = null;
  private removeInstallerListener: (() => void) | null = null;

  constructor() {
    const api = getElectronRemoteServerApi();
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
            terminalError: event.message || 'SSH installer terminal failed.',
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
    payload: ElectronRemoteServerEnsureReadyPayload,
  ): Promise<ElectronRemoteServerEnsureReadyResult> {
    const api = getElectronRemoteServerApi();
    if (!api) {
      return {
        status: 'unsupported',
        installPhase: 'checking',
        installStatus: 'unknown',
        remotePlatform: 'unknown',
        remoteArch: 'unknown',
        missingDependencies: [],
        message: 'Remote server install is only available in the Electron app.',
        localPort: null,
        sessionId: null,
        osRelease: {},
        suggestedCommands: [],
        version: null,
      };
    }

    const initialResult = await api.ensureReady(payload);
    return this.handleEnsureReadyResult(payload, initialResult);
  }

  async recheck(): Promise<void> {
    const current = this._state();
    const api = getElectronRemoteServerApi();
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
    const api = getElectronRemoteServerApi();
    if (!current || !api) {
      return;
    }

    await api.sendInput({ sessionId: current.sessionId, data });
  }

  async resize(cols: number, rows: number): Promise<void> {
    const current = this._state();
    const api = getElectronRemoteServerApi();
    if (!current || !api) {
      return;
    }

    await api.resize({ sessionId: current.sessionId, cols, rows });
  }

  async cancel(): Promise<void> {
    const current = this._state();
    const api = getElectronRemoteServerApi();
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
      message: 'Remote install was canceled.',
    });
  }

  private async handleEnsureReadyResult(
    payload: ElectronRemoteServerEnsureReadyPayload,
    result: ElectronRemoteServerEnsureReadyResult,
  ): Promise<ElectronRemoteServerEnsureReadyResult> {
    if (result.status !== 'waiting-for-user' || !result.sessionId) {
      const currentSessionId = this._state()?.sessionId ?? null;
      const resolver = this.pendingResolver;
      this.pendingResolver = null;
      this._state.set(null);
      if (currentSessionId !== null) {
        void getElectronRemoteServerApi()?.closeSession(currentSessionId).catch(() => undefined);
      }
      resolver?.(result);
      return result;
    }

    const current = this._state();
    const nextState: RemoteInstallFlowState = {
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
