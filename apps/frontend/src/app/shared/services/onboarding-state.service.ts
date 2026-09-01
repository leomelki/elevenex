import { Injectable, signal } from '@angular/core';
import { getElectronWindowsApi } from '../runtime/electron-windows';
import { getInjectedWindowEnvironment, getWindowId } from '../runtime/window-context';
import {
  OnboardingLastSshDefaults,
  OnboardingMode,
  OnboardingStateSnapshot,
  OnboardingStep,
  SavedServer,
  WslConnectionState,
} from '../models/onboarding.model';

/**
 * Pre-split key. Still read as a fallback so an existing install migrates
 * cleanly, and rewritten by neither half once the split keys exist.
 */
export const ONBOARDING_STORAGE_KEY = 'elevenex-onboarding';

/**
 * Saved SSH servers and last-used SSH defaults: app-global, exactly like the
 * theme. Adding a server in one window makes it available in all of them.
 */
export const ENVIRONMENT_CATALOGUE_STORAGE_KEY = 'elevenex-environments';

/**
 * Which environment *this window* is on. Per-window by construction: two
 * windows pointing at different backends is the whole point of multi-window,
 * and this is the value `getBackendOrigin()` reads to decide where requests go.
 */
export const WINDOW_SESSION_STORAGE_KEY_BASE = 'elevenex-onboarding-session';

function getWindowSessionStorageKey(): string {
  return `${WINDOW_SESSION_STORAGE_KEY_BASE}@${getWindowId()}`;
}

let cachedSnapshot: OnboardingStateSnapshot | null = null;
let cachedRawState: { catalogue: string | null; session: string | null } | null = null;

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

function parseJson(raw: string | null): Record<string, unknown> | null {
  if (!raw) {
    return null;
  }

  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function readCatalogue(raw: string | null): Pick<OnboardingStateSnapshot, 'servers' | 'lastSshDefaults'> {
  const parsed = parseJson(raw);

  return {
    servers: Array.isArray(parsed?.['servers'])
      ? (parsed['servers'] as unknown[]).map(sanitizeServer).filter((value): value is SavedServer => value !== null)
      : [],
    lastSshDefaults: sanitizeDefaults(parsed?.['lastSshDefaults']),
  };
}

type WindowSession = Omit<OnboardingStateSnapshot, 'servers' | 'lastSshDefaults'>;

/**
 * Session for a window that has never written its own state: a brand-new window,
 * or one restored from the saved layout.
 *
 * The main process injects the environment it opened the window on, so the
 * window comes up on the right backend immediately instead of flashing the
 * local workspace (or the onboarding screen) first. `remoteConnectionReady`
 * stays false for remotes — the tunnel has to be claimed before requests may go
 * anywhere — but the connection flow reuses a live tunnel, so it is brief.
 */
function seedSessionFromInjectedEnvironment(): WindowSession | null {
  const injected = getInjectedWindowEnvironment();
  if (!injected) {
    return null;
  }

  if (injected.mode === 'ssh' && Number.isInteger(injected.serverId) && (injected.serverId ?? 0) > 0) {
    return {
      mode: 'ssh',
      currentStep: 'project',
      activeServerId: injected.serverId,
      remoteConnectionReady: false,
      projectHandoffAcknowledged: true,
      wsl: null,
    };
  }

  if (injected.mode === 'wsl') {
    return {
      mode: 'wsl',
      currentStep: 'project',
      activeServerId: null,
      remoteConnectionReady: false,
      projectHandoffAcknowledged: true,
      wsl: null,
    };
  }

  if (injected.mode === 'local') {
    return {
      mode: 'local',
      currentStep: 'project',
      activeServerId: null,
      remoteConnectionReady: true,
      projectHandoffAcknowledged: true,
      wsl: null,
    };
  }

  return null;
}

function readWindowSession(raw: string | null): WindowSession {
  const parsed = parseJson(raw);

  if (!parsed) {
    return seedSessionFromInjectedEnvironment() ?? {
      mode: DEFAULT_SNAPSHOT.mode,
      currentStep: DEFAULT_SNAPSHOT.currentStep,
      activeServerId: DEFAULT_SNAPSHOT.activeServerId,
      remoteConnectionReady: DEFAULT_SNAPSHOT.remoteConnectionReady,
      projectHandoffAcknowledged: DEFAULT_SNAPSHOT.projectHandoffAcknowledged,
      wsl: DEFAULT_SNAPSHOT.wsl,
    };
  }

  const mode = parsed['mode'];
  const currentStep = parsed['currentStep'];
  const activeServerId = Number(parsed['activeServerId']);

  return {
    mode: mode === 'local' || mode === 'ssh' || mode === 'wsl' ? mode : null,
    currentStep:
      currentStep === 'choice' || currentStep === 'ssh' || currentStep === 'install' || currentStep === 'project'
        ? currentStep
        : 'choice',
    activeServerId: Number.isInteger(activeServerId) && activeServerId > 0 ? activeServerId : null,
    remoteConnectionReady: parsed['remoteConnectionReady'] === true,
    projectHandoffAcknowledged: parsed['projectHandoffAcknowledged'] === true,
    wsl: sanitizeWslState(parsed['wsl']),
  };
}

export function readOnboardingStateSnapshot(
  storage: Pick<Storage, 'getItem'> | null = typeof localStorage === 'undefined' ? null : localStorage,
): OnboardingStateSnapshot {
  if (!storage) {
    return DEFAULT_SNAPSHOT;
  }

  // Both halves fall back to the pre-split key so an existing install keeps its
  // servers and its active environment on the first launch after upgrading.
  // Guarded because this runs on every HTTP request: an unavailable storage
  // must degrade to defaults, not take the whole app down.
  let legacyRaw: string | null;
  let catalogueRaw: string | null;
  let sessionRaw: string | null;
  try {
    legacyRaw = storage.getItem(ONBOARDING_STORAGE_KEY);
    catalogueRaw = storage.getItem(ENVIRONMENT_CATALOGUE_STORAGE_KEY) ?? legacyRaw;
    sessionRaw = storage.getItem(getWindowSessionStorageKey()) ?? legacyRaw;
  } catch {
    return DEFAULT_SNAPSHOT;
  }

  // This runs on every HTTP request (see api-base.interceptor) and now reads
  // two keys, so the parse is memoised against the raw strings rather than
  // behind an invalidation flag: getItem is cheap, JSON.parse is not, and
  // comparing the source text cannot go stale on an external write.
  if (
    cachedSnapshot
    && cachedRawState
    && cachedRawState.catalogue === catalogueRaw
    && cachedRawState.session === sessionRaw
  ) {
    return cachedSnapshot;
  }

  const snapshot: OnboardingStateSnapshot = {
    ...readWindowSession(sessionRaw),
    ...readCatalogue(catalogueRaw),
  };

  cachedRawState = { catalogue: catalogueRaw, session: sessionRaw };
  cachedSnapshot = snapshot;

  return snapshot;
}

/** IPC channel used to tell the other windows the server list changed. */
export const ENVIRONMENT_CATALOGUE_CHANGED_CHANNEL = 'environments:changed';

export function writeOnboardingStateSnapshot(snapshot: OnboardingStateSnapshot): void {
  if (typeof localStorage === 'undefined') {
    return;
  }

  try {
    localStorage.setItem(
      ENVIRONMENT_CATALOGUE_STORAGE_KEY,
      JSON.stringify({ servers: snapshot.servers, lastSshDefaults: snapshot.lastSshDefaults }),
    );
    localStorage.setItem(
      getWindowSessionStorageKey(),
      JSON.stringify({
        mode: snapshot.mode,
        currentStep: snapshot.currentStep,
        activeServerId: snapshot.activeServerId,
        remoteConnectionReady: snapshot.remoteConnectionReady,
        projectHandoffAcknowledged: snapshot.projectHandoffAcknowledged,
        wsl: snapshot.wsl,
      }),
    );
    // The pre-split key has now been superseded on both axes; leaving it around
    // would resurrect stale state for any window created later.
    localStorage.removeItem(ONBOARDING_STORAGE_KEY);
  } catch {
    // Storage failures must not break a connection switch.
  }

  // Force the next read to re-derive from storage rather than trusting an
  // in-memory copy that may not match what actually landed on disk.
  cachedRawState = null;
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
    const previous = this.snapshot();
    writeOnboardingStateSnapshot(snapshot);
    this.snapshot.set(snapshot);

    // The catalogue is app-global: the other windows' server lists have to
    // follow, and localStorage's `storage` event is not dependable between
    // Electron BrowserWindows.
    if (
      previous.servers !== snapshot.servers
      || previous.lastSshDefaults !== snapshot.lastSshDefaults
    ) {
      void getElectronWindowsApi()?.broadcast(ENVIRONMENT_CATALOGUE_CHANGED_CHANNEL);
    }
  }

  /** Re-reads storage after another window changed the shared catalogue. */
  refreshFromStorage() {
    this.snapshot.set(readOnboardingStateSnapshot());
  }
}
