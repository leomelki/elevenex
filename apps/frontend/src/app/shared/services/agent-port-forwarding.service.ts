import { Injectable, OnDestroy, effect, inject, signal } from '@angular/core';
import {
  getBackendOrigin,
  getBackendServerId,
  getWebSocketUrl,
  isBackendOriginReady,
} from '../runtime/runtime-config';
import { getElectronSshForwardingApi } from '../runtime/electron-ssh-forwarding';
import { getElectronRemoteLinkApi } from '../runtime/electron-remote-link';
import { getWindowId } from '../runtime/window-context';
import type { DesktopForwardingContext, PortForwardRequest } from '../models/port-forwarding.model';
import {
  OnboardingStateService,
  getActiveOnboardingServer,
  isOnboardingSetupConfigured,
  readOnboardingStateSnapshot,
} from './onboarding-state.service';
import { PortForwardingOperationsService } from './port-forwarding-operations.service';

const DESKTOP_ID_KEY = 'elevenex-port-forwarding-desktop-id';

@Injectable({ providedIn: 'root' })
export class AgentPortForwardingService implements OnDestroy {
  private readonly state = inject(OnboardingStateService);
  private readonly operations = inject(PortForwardingOperationsService);
  private readonly started = signal(false);
  private socket: WebSocket | null = null;
  private connectionKey: string | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private attempts = 0;
  private readonly requests = new Map<string, AbortController>();
  private desktopId: string | null = null;

  constructor() {
    effect(() => {
      const snapshot = this.state.snapshotState();
      if (!this.started()) return;
      const key =
        isOnboardingSetupConfigured(snapshot) && isBackendOriginReady(snapshot)
          ? `${getBackendServerId()}@${getBackendOrigin(snapshot)}`
          : null;
      if (this.connectionKey !== key) {
        this.close();
        this.connectionKey = key;
        this.attempts = 0;
      }
      if (key && !this.socket) this.open();
    });
  }

  start(): void {
    if (!getElectronSshForwardingApi() && !getElectronRemoteLinkApi()) return;
    this.started.set(true);
  }

  private async context(): Promise<DesktopForwardingContext> {
    const identity = () => {
      const id = localStorage.getItem(DESKTOP_ID_KEY) || this.desktopId || crypto.randomUUID();
      localStorage.setItem(DESKTOP_ID_KEY, id);
      return id;
    };
    // Simultaneously opening windows must register as one physical desktop.
    this.desktopId = globalThis.navigator?.locks
      ? await navigator.locks.request(DESKTOP_ID_KEY, identity)
      : identity();
    const snapshot = readOnboardingStateSnapshot();
    const server = snapshot.mode === 'ssh' ? getActiveOnboardingServer(snapshot) : null;
    return {
      desktopId: this.desktopId,
      windowId: getWindowId(),
      mode: snapshot.mode ?? 'local',
      connectionLabel: (snapshot.mode === 'paired'
        ? (snapshot.paired?.name ?? 'Paired desktop')
        : (server?.name ?? (snapshot.mode === 'wsl' ? 'WSL' : 'Local desktop'))
      ).slice(0, 300),
      defaultConnection: snapshot.mode === 'paired' ? 'paired' : server ? 'ssh' : null,
    };
  }

  private open(): void {
    if (!this.started() || !this.connectionKey || !isBackendOriginReady()) return;
    const socket = new WebSocket(getWebSocketUrl('/desktop-port-forwarding'));
    this.socket = socket;
    const environmentKey = getBackendServerId();
    socket.onopen = () => {
      if (this.socket !== socket || environmentKey !== getBackendServerId()) {
        socket.close();
        return;
      }
      void this.context().then(
        (context) => {
          if (
            this.socket === socket &&
            environmentKey === getBackendServerId() &&
            socket.readyState === WebSocket.OPEN
          )
            socket.send(JSON.stringify({ type: 'register', context }));
        },
        () => socket.close(),
      );
    };
    socket.onmessage = (event) => {
      if (
        this.socket !== socket ||
        environmentKey !== getBackendServerId() ||
        !isBackendOriginReady()
      )
        return;
      let message: PortForwardRequest | { type: 'cancel'; id: string } | { type: 'ready' };
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      if (message?.type === 'ready') {
        this.attempts = 0;
        return;
      }
      if (message?.type === 'cancel') {
        this.requests.get(message.id)?.abort();
        return;
      }
      if (
        message?.type !== 'request' ||
        typeof message.id !== 'string' ||
        this.requests.has(message.id)
      )
        return;
      const controller = new AbortController();
      this.requests.set(message.id, controller);
      void this.operations
        .execute(message, controller.signal)
        .then(
          (data) => {
            if (this.socket === socket && socket.readyState === WebSocket.OPEN)
              socket.send(JSON.stringify({ type: 'response', id: message.id, data }));
          },
          (error) => {
            if (this.socket === socket && socket.readyState === WebSocket.OPEN)
              socket.send(
                JSON.stringify({
                  type: 'response',
                  id: message.id,
                  error:
                    error instanceof Error
                      ? error.message.slice(0, 4000)
                      : 'Port forwarding failed.',
                }),
              );
          },
        )
        .finally(() => {
          if (this.requests.get(message.id) === controller) this.requests.delete(message.id);
        });
    };
    socket.onerror = () => socket.close();
    socket.onclose = () => {
      if (this.socket !== socket) return;
      this.socket = null;
      for (const controller of this.requests.values()) controller.abort();
      this.requests.clear();
      this.reconnectTimer = setTimeout(
        () => {
          this.reconnectTimer = null;
          this.open();
        },
        Math.min(500 * 2 ** this.attempts++, 8000),
      );
    };
  }

  private close(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    const socket = this.socket;
    this.socket = null;
    socket?.close();
    for (const controller of this.requests.values()) controller.abort();
    this.requests.clear();
  }

  ngOnDestroy(): void {
    this.started.set(false);
    this.close();
  }
}
