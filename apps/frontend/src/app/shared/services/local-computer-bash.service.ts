import { Injectable, NgZone, effect, inject, signal } from '@angular/core';
import { getWebSocketUrl, isBackendOriginReady } from '../runtime/runtime-config';
import { LocalBashState, getElectronLocalBashApi } from '../runtime/electron-local-bash';
import { OnboardingStateService } from './onboarding-state.service';

type ServerMessage =
  | { type: 'execute'; id: string; command: string; cwd?: string; timeoutMs: number }
  | { type: 'cancel'; id: string };

const DISABLED_STATE: LocalBashState = {
  enabled: false,
  supported: false,
  shell: '',
  platform: '',
  label: 'Local computer',
};

/** Keeps an opt-in reverse command bridge connected to the selected remote backend. */
@Injectable({ providedIn: 'root' })
export class LocalComputerBashService {
  private readonly api = getElectronLocalBashApi();
  private readonly onboarding = inject(OnboardingStateService);
  private readonly zone = inject(NgZone);
  private socket: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private generation = 0;
  private removeStateListener: (() => void) | null = null;

  readonly state = signal<LocalBashState>(DISABLED_STATE);
  readonly saving = signal(false);
  readonly connected = signal(false);
  readonly error = signal<string | null>(null);

  constructor() {
    if (!this.api) return;
    void this.api
      .getState()
      .then((state) => this.zone.run(() => this.state.set(state)))
      .catch((error) =>
        this.zone.run(() =>
          this.error.set(
            error instanceof Error ? error.message : 'Could not read local Bash settings.',
          ),
        ),
      );
    this.removeStateListener = this.api.onStateChanged((state) => {
      this.zone.run(() => this.state.set(state));
    });
    effect(() => {
      const snapshot = this.onboarding.snapshotState();
      const enabled = this.state().enabled;
      const shouldConnect =
        enabled &&
        (snapshot.mode === 'ssh' || snapshot.mode === 'wsl' || snapshot.mode === 'paired') &&
        isBackendOriginReady(snapshot);
      this.reconcile(shouldConnect);
    });
  }

  async setEnabled(enabled: boolean): Promise<void> {
    if (!this.api || this.saving()) return;
    this.saving.set(true);
    this.error.set(null);
    try {
      this.state.set(await this.api.setEnabled(enabled));
    } catch (error) {
      this.error.set(
        error instanceof Error ? error.message : 'Could not update local Bash access.',
      );
      throw error;
    } finally {
      this.saving.set(false);
    }
  }

  private reconcile(shouldConnect: boolean): void {
    if (!shouldConnect) {
      this.disconnect();
      return;
    }
    if (!this.socket || this.socket.readyState === WebSocket.CLOSED) this.connect();
  }

  private connect(): void {
    if (!this.api || this.socket?.readyState === WebSocket.CONNECTING) return;
    const generation = ++this.generation;
    const socket = new WebSocket(getWebSocketUrl('/local-computer-channel'));
    this.socket = socket;
    socket.addEventListener('open', () => {
      if (generation !== this.generation) return socket.close();
      const state = this.state();
      socket.send(
        JSON.stringify({
          type: 'ready',
          label: state.label,
          platform: state.platform,
        }),
      );
      this.zone.run(() => this.connected.set(true));
    });
    socket.addEventListener('message', (event) => {
      let message: ServerMessage;
      try {
        message = JSON.parse(`${event.data}`) as ServerMessage;
      } catch {
        return;
      }
      if (message.type === 'execute') void this.execute(socket, message);
      else if (message.type === 'cancel') void this.api!.cancel(message.id);
    });
    socket.addEventListener('close', () => {
      if (generation !== this.generation) return;
      this.socket = null;
      this.zone.run(() => this.connected.set(false));
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        const snapshot = this.onboarding.snapshotState();
        if (this.state().enabled && isBackendOriginReady(snapshot)) this.connect();
      }, 1_000);
    });
    socket.addEventListener('error', () => socket.close());
  }

  private async execute(
    socket: WebSocket,
    message: Extract<ServerMessage, { type: 'execute' }>,
  ): Promise<void> {
    try {
      const result = await this.api!.run({
        id: message.id,
        command: message.command,
        cwd: message.cwd,
        timeoutMs: message.timeoutMs,
      });
      this.sendResult(socket, message.id, result);
    } catch (error) {
      this.sendResult(socket, message.id, {
        error: error instanceof Error ? error.message : 'Local Bash command failed.',
      });
    }
  }

  private sendResult(socket: WebSocket, id: string, result: unknown): void {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: 'result', id, result }));
    }
  }

  private disconnect(): void {
    this.generation += 1;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.socket?.close();
    this.socket = null;
    this.connected.set(false);
  }
}
