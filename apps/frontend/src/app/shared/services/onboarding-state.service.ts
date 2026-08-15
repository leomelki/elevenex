import { Injectable, signal } from '@angular/core';
import {
  OnboardingLastSshDefaults,
  OnboardingMode,
  OnboardingStateSnapshot,
  OnboardingStep,
  SavedServer,
  WslConnectionState,
} from '../models/onboarding.model';

export const ONBOARDING_STORAGE_KEY = 'elevenex-onboarding';

const DEFAULT_SNAPSHOT: OnboardingStateSnapshot = {
  mode: null,
  currentStep: 'choice',
  activeServerId: null,
  remoteConnectionReady: false,
  projectHandoffAcknowledged: false,
  servers: [],
  lastSshDefaults: null,
  wsl: null,
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function sanitizeServer(value: unknown): SavedServer | null {
  if (!isObject(value)) {
    return null;
  }

  const id = Number(value['id']);
  const sshPort = Number(value['sshPort']);
  const localPort = Number(value['localPort']);
  const remotePort = Number(value['remotePort']);

  if (!Number.isInteger(id) || id <= 0) return null;
  if (!Number.isInteger(sshPort) || sshPort <= 0) return null;
  if (!Number.isInteger(localPort) || localPort <= 0) return null;
  if (!Number.isInteger(remotePort) || remotePort <= 0) return null;

  const authMode = value['authMode'];
  const installStatus = value['installStatus'];
  if (authMode !== 'agent' && authMode !== 'password' && authMode !== 'key') return null;
  if (
    installStatus !== 'unknown'
    && installStatus !== 'available'
    && installStatus !== 'missing'
    && installStatus !== 'needs-update'
    && installStatus !== 'unsupported-os'
    && installStatus !== 'missing-prereqs'
  ) return null;

  return {
    id,
    name: `${value['name'] ?? ''}`.trim(),
    sshHost: `${value['sshHost'] ?? ''}`.trim(),
    sshUser: value['sshUser'] ? `${value['sshUser']}`.trim() : null,
    sshPort,
    authMode,
    identityFilePath: value['identityFilePath'] ? `${value['identityFilePath']}` : null,
    localPort,
    remotePort,
    installStatus,
    createdAt: `${value['createdAt'] ?? ''}`,
    updatedAt: `${value['updatedAt'] ?? ''}`,
    lastConnectedAt: `${value['lastConnectedAt'] ?? ''}`,
  };
}

function sanitizeWslState(value: unknown): WslConnectionState | null {
  if (!isObject(value)) {
    return null;
  }

  const localPort = Number(value['localPort']);
  if (!Number.isInteger(localPort) || localPort <= 0) return null;

  const installStatus = value['installStatus'];
  if (
    installStatus !== 'unknown'
    && installStatus !== 'available'
    && installStatus !== 'missing'
    && installStatus !== 'needs-update'
    && installStatus !== 'unsupported-os'
    && installStatus !== 'missing-prereqs'
  ) return null;

  return {
    distroName: value['distroName'] ? `${value['distroName']}`.trim() : null,
    localPort,
    installStatus,
    lastConnectedAt: `${value['lastConnectedAt'] ?? ''}`,
  };
}

function sanitizeDefaults(value: unknown): OnboardingLastSshDefaults | null {
  if (!isObject(value)) {
    return null;
  }

  const authMode = value['authMode'];
  const sshPort = Number(value['sshPort']);
  if (authMode !== 'agent' && authMode !== 'password' && authMode !== 'key') return null;
  if (!Number.isInteger(sshPort) || sshPort <= 0) return null;

  return {
    name: `${value['name'] ?? ''}`.trim(),
    sshHost: `${value['sshHost'] ?? ''}`.trim(),
    sshUser: value['sshUser'] ? `${value['sshUser']}`.trim() : null,
    sshPort,
    authMode,
    identityFilePath: value['identityFilePath'] ? `${value['identityFilePath']}` : null,
  };
}

export function readOnboardingStateSnapshot(
  storage: Pick<Storage, 'getItem'> | null = typeof localStorage === 'undefined' ? null : localStorage,
): OnboardingStateSnapshot {
  if (!storage) {
    return DEFAULT_SNAPSHOT;
  }

  try {
    const raw = storage.getItem(ONBOARDING_STORAGE_KEY);
    if (!raw) {
      return DEFAULT_SNAPSHOT;
    }

    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const mode = parsed['mode'];
    const currentStep = parsed['currentStep'];
    const activeServerId = Number(parsed['activeServerId']);
    const servers = Array.isArray(parsed['servers'])
      ? parsed['servers'].map(sanitizeServer).filter((value): value is SavedServer => value !== null)
      : [];

    return {
      mode: mode === 'local' || mode === 'ssh' || mode === 'wsl' ? mode : null,
      currentStep:
        currentStep === 'choice' || currentStep === 'ssh' || currentStep === 'install' || currentStep === 'project'
          ? currentStep
          : 'choice',
      activeServerId: Number.isInteger(activeServerId) && activeServerId > 0 ? activeServerId : null,
      remoteConnectionReady: parsed['remoteConnectionReady'] === true,
      projectHandoffAcknowledged: parsed['projectHandoffAcknowledged'] === true,
      servers,
      lastSshDefaults: sanitizeDefaults(parsed['lastSshDefaults']),
      wsl: sanitizeWslState(parsed['wsl']),
    };
  } catch {
    return DEFAULT_SNAPSHOT;
  }
}

export function getActiveOnboardingServer(
  snapshot: OnboardingStateSnapshot,
): SavedServer | null {
  if (!snapshot.activeServerId) {
    return null;
  }

  return snapshot.servers.find(server => server.id === snapshot.activeServerId) ?? null;
}

export function isOnboardingSetupConfigured(snapshot: OnboardingStateSnapshot): boolean {
  if (snapshot.mode === 'local') {
    return true;
  }

  if (snapshot.mode === 'wsl') {
    return snapshot.wsl !== null && snapshot.remoteConnectionReady;
  }

  return snapshot.mode === 'ssh'
    && getActiveOnboardingServer(snapshot) !== null
    && snapshot.remoteConnectionReady;
}

export function isOnboardingComplete(snapshot: OnboardingStateSnapshot): boolean {
  return isOnboardingSetupConfigured(snapshot) && snapshot.projectHandoffAcknowledged;
}

export function getOnboardingBackendOrigin(snapshot: OnboardingStateSnapshot): string | null {
  if (!snapshot.remoteConnectionReady) {
    return null;
  }

  if (snapshot.mode === 'wsl') {
    return snapshot.wsl ? `http://127.0.0.1:${snapshot.wsl.localPort}` : null;
  }

  if (snapshot.mode !== 'ssh') {
    return null;
  }

  const server = getActiveOnboardingServer(snapshot);
  if (!server) {
    return null;
  }

  return `http://127.0.0.1:${server.localPort}`;
}

@Injectable({ providedIn: 'root' })
export class OnboardingStateService {
  private readonly snapshot = signal(readOnboardingStateSnapshot());
  readonly snapshotState = this.snapshot.asReadonly();

  readSnapshot(): OnboardingStateSnapshot {
    return this.snapshot();
  }

  getActiveServer(snapshot = this.readSnapshot()): SavedServer | null {
    return getActiveOnboardingServer(snapshot);
  }

  setMode(mode: OnboardingMode) {
    const snapshot = this.readSnapshot();
    this.writeSnapshot({
      ...snapshot,
      mode,
      activeServerId: mode === 'local' ? null : snapshot.activeServerId,
      remoteConnectionReady: mode === 'local' ? true : snapshot.remoteConnectionReady,
      currentStep: mode === 'local' ? 'project' : 'ssh',
    });
  }

  getWslState(snapshot = this.readSnapshot()): WslConnectionState | null {
    return snapshot.wsl;
  }

  // WSL has no "add"/"edit" flow the way SavedServer does (see WslConnectionState
  // doc comment) — this just records the last-connected distro/port and, unlike
  // upsertServer, always activates the mode since there is nothing else to pick.
  setWslState(state: WslConnectionState) {
    const snapshot = this.readSnapshot();
    this.writeSnapshot({
      ...snapshot,
      mode: 'wsl',
      currentStep: 'project',
      remoteConnectionReady: true,
      wsl: state,
    });
  }

  clearWslConnection() {
    const snapshot = this.readSnapshot();
    this.writeSnapshot({
      ...snapshot,
      remoteConnectionReady: snapshot.mode === 'wsl' ? false : snapshot.remoteConnectionReady,
    });
  }

  setCurrentStep(step: OnboardingStep) {
    const snapshot = this.readSnapshot();
    this.writeSnapshot({ ...snapshot, currentStep: step });
  }

  markProjectHandoffAcknowledged() {
    const snapshot = this.readSnapshot();
    this.writeSnapshot({ ...snapshot, projectHandoffAcknowledged: true });
  }

  setRemoteConnectionReady(ready: boolean) {
    const snapshot = this.readSnapshot();
    this.writeSnapshot({ ...snapshot, remoteConnectionReady: ready });
  }

  saveServer(server: SavedServer) {
    this.upsertServer(server, { activate: true });
  }

  upsertServer(server: SavedServer, options: { activate?: boolean } = {}) {
    const snapshot = this.readSnapshot();
    const servers = snapshot.servers.filter(entry => entry.id !== server.id);
    const nextServer = { ...server, updatedAt: new Date().toISOString() };
    const shouldActivate = options.activate === true;
    this.writeSnapshot({
      ...snapshot,
      mode: shouldActivate ? 'ssh' : snapshot.mode,
      currentStep: shouldActivate ? 'project' : snapshot.currentStep,
      activeServerId: shouldActivate ? nextServer.id : snapshot.activeServerId,
      remoteConnectionReady: shouldActivate ? true : snapshot.remoteConnectionReady,
      servers: [nextServer, ...servers],
      lastSshDefaults: {
        name: nextServer.name,
        sshHost: nextServer.sshHost,
        sshUser: nextServer.sshUser,
        sshPort: nextServer.sshPort,
        authMode: nextServer.authMode,
        identityFilePath: nextServer.identityFilePath,
      },
    });
  }

  deleteServer(id: number) {
    const snapshot = this.readSnapshot();
    const nextServers = snapshot.servers.filter(server => server.id !== id);
    const isActive = snapshot.activeServerId === id;
    this.writeSnapshot({
      ...snapshot,
      servers: nextServers,
      activeServerId: isActive ? null : snapshot.activeServerId,
      remoteConnectionReady: isActive ? false : snapshot.remoteConnectionReady,
      currentStep: isActive ? 'ssh' : snapshot.currentStep,
    });
  }

  saveLastSshDefaults(defaults: OnboardingLastSshDefaults) {
    const snapshot = this.readSnapshot();
    this.writeSnapshot({ ...snapshot, lastSshDefaults: defaults });
  }

  clearActiveServer() {
    const snapshot = this.readSnapshot();
    this.writeSnapshot({ ...snapshot, activeServerId: null, remoteConnectionReady: false });
  }

  private writeSnapshot(snapshot: OnboardingStateSnapshot) {
    localStorage.setItem(ONBOARDING_STORAGE_KEY, JSON.stringify(snapshot));
    this.snapshot.set(snapshot);
  }
}
