declare global {
  interface Window {
    __ELEVENEX_RUNTIME__?: ElevenexRuntimeConfig;
  }
}

export interface ElevenexRuntimeConfig {
  apiBaseUrl?: string;
  backendOrigin?: string;
  mode?: 'browser' | 'electron-local' | 'electron-debug';
}

import { getOnboardingBackendOrigin, readOnboardingStateSnapshot } from '../services/onboarding-state.service';

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

export function getBackendOrigin(): string {
  const onboardingOrigin = getOnboardingBackendOrigin(readOnboardingStateSnapshot());
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

export function getApiBaseUrl(): string {
  const runtimeApiBase = normalizeBaseUrl(getRuntimeConfig().apiBaseUrl);
  if (runtimeApiBase) {
    return runtimeApiBase;
  }

  return `${getBackendOrigin()}/api`;
}

export function getWebSocketUrl(path: string, params?: URLSearchParams): string {
  const url = new URL(path, getBackendOrigin());
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
