declare global {
  interface Window {
    __ELEVENEX_RUNTIME__?: ElevenexRuntimeConfig;
  }
}

export interface ElevenexRuntimeConfig {
  apiBaseUrl?: string;
  backendOrigin?: string;
  mode?: 'browser' | 'electron-local' | 'electron-debug';
  /** Desktop window this renderer runs in — injected by preload.cjs. */
  windowId?: string;
  /** Environment the main process opened this window on. */
  windowEnvironment?: ElectronEnvironmentRef | null;
}

import type { OnboardingStateSnapshot } from '../models/onboarding.model';
import type { ElectronEnvironmentRef } from './electron-windows';
import { getActiveOnboardingServer, getOnboardingBackendOrigin, readOnboardingStateSnapshot } from '../services/onboarding-state.service';
import { getWindowId } from './window-context';

function normalizeBaseUrl(value: string | undefined): string {
  return value ? value.replace(/\/+$/, '') : '';
}

function getWindowRuntime(): ElevenexRuntimeConfig | undefined {
  if (typeof window === 'undefined') {
    return undefined;
  }

  return window.__ELEVENEX_RUNTIME__;
}

function hasElectronBridge(): boolean {
  if (typeof window === 'undefined') {
    return false;
  }

  return typeof window.__ELEVENEX_ELECTRON__ !== 'undefined';
}

export function getRuntimeConfig(): ElevenexRuntimeConfig {
  return getWindowRuntime() ?? {};
}

/**
 * Which backend this window talks to. Used to namespace state that belongs to
 * a workspace rather than to a window.
 */
export function getBackendServerId(): string {
  const snapshot = readOnboardingStateSnapshot();
  if (snapshot?.mode === 'ssh') {
    const server = getActiveOnboardingServer(snapshot);
    if (server) return `server-${server.id}`;
  }
  if (snapshot?.mode === 'wsl') {
    return 'wsl';
  }
  return 'local';
}

/**
 * Backend *and* window. Two windows on the same backend are two independent
 * workspaces, so their open tabs and layouts must not share a key.
 */
export function getWindowScopeId(): string {
  return `${getBackendServerId()}#${getWindowId()}`;
}

export function getBackendOrigin(
  snapshot: OnboardingStateSnapshot = readOnboardingStateSnapshot(),
): string {
  const onboardingOrigin = getOnboardingBackendOrigin(snapshot);
  if (onboardingOrigin) {
    return normalizeBaseUrl(onboardingOrigin);
  }

  const runtimeOrigin = normalizeBaseUrl(getRuntimeConfig().backendOrigin);
  if (runtimeOrigin) {
    return runtimeOrigin;
  }

  if (hasElectronBridge()) {
    return 'http://127.0.0.1:11111';
  }

  if (typeof window !== 'undefined' && window.location.origin !== 'null') {
    return normalizeBaseUrl(window.location.origin);
  }

  return 'http://127.0.0.1:11111';
}

/**
 * Whether `getBackendOrigin()` currently resolves to the backend the user
 * actually selected.
 *
 * In `ssh`/`wsl` mode the origin is a tunnel port that only exists once the
 * connection is up. Until then, inside Electron, `getBackendOrigin()` falls
 * back to this machine's own port — a different backend entirely, one that
 * knows nothing about the remote sessions. One-shot requests retry and recover
 * from that, but a long-lived WebSocket opened against the fallback connects
 * happily, never errors and therefore never reconnects: it stays silently
 * bound to the wrong host for the lifetime of the window. Such sockets must
 * wait for this to be true before connecting.
 *
 * Served over http there is no such trap — the fallback is the page's own
 * origin, which is the backend serving the app and is what every REST call
 * already targets.
 */
export function isBackendOriginReady(
  snapshot: OnboardingStateSnapshot = readOnboardingStateSnapshot(),
): boolean {
  if (snapshot.mode !== 'ssh' && snapshot.mode !== 'wsl') {
    return true;
  }

  return !hasElectronBridge() || snapshot.remoteConnectionReady;
}

export function getApiBaseUrl(): string {
  const runtimeApiBase = normalizeBaseUrl(getRuntimeConfig().apiBaseUrl);
  if (runtimeApiBase) {
    return runtimeApiBase;
  }

  return `${getBackendOrigin()}/api`;
}

export function getWebSocketUrl(
  path: string,
  params?: URLSearchParams,
  origin: string = getBackendOrigin(),
): string {
  const url = new URL(path, origin);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';

  if (params) {
    url.search = params.toString();
  }

  return url.toString();
}

export function getSocketIoBaseUrl(namespace = ''): string {
  return `${getBackendOrigin()}${namespace}`;
}

export function shouldUseHashLocation(): boolean {
  const runtime = getRuntimeConfig();
  if (runtime.mode === 'electron-local') {
    return true;
  }

  if (typeof window === 'undefined') {
    return false;
  }

  return window.location.protocol === 'file:';
}
