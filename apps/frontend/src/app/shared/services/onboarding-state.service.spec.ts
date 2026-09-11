import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { OnboardingStateSnapshot, SavedServer } from '../models/onboarding.model';
import { installMemoryLocalStorage } from '../testing/memory-storage';
import {
  ENVIRONMENT_CATALOGUE_STORAGE_KEY,
  ONBOARDING_STORAGE_KEY,
  WINDOW_SESSION_STORAGE_KEY_BASE,
  getOnboardingBackendOrigin,
  readOnboardingStateSnapshot,
  writeOnboardingStateSnapshot,
} from './onboarding-state.service';

const server: SavedServer = {
  id: 12,
  name: 'Prod',
  sshHost: 'example.com',
  sshUser: 'deploy',
  sshPort: 22,
  authMode: 'agent',
  identityFilePath: null,
  localPort: 4310,
  remotePort: 11111,
  installStatus: 'available',
  createdAt: '2024-01-01',
  updatedAt: '2024-01-01',
  lastConnectedAt: '2024-01-01',
};

function setWindow(windowId: string, environment?: unknown): void {
  (window as unknown as { __ELEVENEX_RUNTIME__?: unknown }).__ELEVENEX_RUNTIME__ = {
    windowId,
    windowEnvironment: environment ?? null,
  };
}

function sessionKey(windowId: string): string {
  return `${WINDOW_SESSION_STORAGE_KEY_BASE}@${windowId}`;
}

describe('onboarding state storage', () => {
  let restoreStorage: () => void;

  beforeEach(() => {
    restoreStorage = installMemoryLocalStorage();
    setWindow('w-alpha');
  });

  afterEach(() => {
    restoreStorage();
    (window as unknown as { __ELEVENEX_RUNTIME__?: unknown }).__ELEVENEX_RUNTIME__ = {};
  });

  it('splits the catalogue from the per-window session on write', () => {
    writeOnboardingStateSnapshot({
      mode: 'ssh',
      currentStep: 'project',
      activeServerId: server.id,
      remoteConnectionReady: true,
      projectHandoffAcknowledged: true,
      servers: [server],
      lastSshDefaults: null,
      wsl: null,
      paired: null,
    });

    const catalogue = JSON.parse(localStorage.getItem(ENVIRONMENT_CATALOGUE_STORAGE_KEY)!);
    const session = JSON.parse(localStorage.getItem(sessionKey('w-alpha'))!);

    expect(catalogue.servers).toHaveLength(1);
    expect(catalogue.mode).toBeUndefined();
    expect(session.mode).toBe('ssh');
    expect(session.servers).toBeUndefined();
    expect(localStorage.getItem(ONBOARDING_STORAGE_KEY)).toBeNull();
  });

  it('keeps the paired device across a reload', () => {
    // The device is what names the backend origin for the whole window, so
    // dropping it on write leaves a window in paired mode with nothing to dial:
    // requests fall back to this machine's backend and the route guard sends the
    // window back to the mode picker.
    writeOnboardingStateSnapshot({
      mode: 'paired',
      currentStep: 'project',
      activeServerId: null,
      remoteConnectionReady: true,
      projectHandoffAcknowledged: true,
      servers: [],
      lastSshDefaults: null,
      wsl: null,
      paired: { id: 7, name: 'La-TV.local', localPort: 51234 },
    });

    const snapshot = readOnboardingStateSnapshot();

    expect(snapshot.paired).toEqual({ id: 7, name: 'La-TV.local', localPort: 51234 });
    expect(getOnboardingBackendOrigin(snapshot)).toBe('http://127.0.0.1:51234');
  });

  it('keeps a device whose link is not claimed yet', () => {
    // A window seeded by the main process knows its device before it knows the
    // port. Losing the device here would be the same dead end as above, so the
    // record survives while the origin stays unresolved.
    writeOnboardingStateSnapshot({
      mode: 'paired',
      currentStep: 'project',
      activeServerId: null,
      remoteConnectionReady: false,
      projectHandoffAcknowledged: true,
      servers: [],
      lastSshDefaults: null,
      wsl: null,
      paired: { id: 7, name: 'La-TV.local', localPort: 0 },
    });

    const snapshot = readOnboardingStateSnapshot();

    expect(snapshot.paired?.id).toBe(7);
    expect(getOnboardingBackendOrigin(snapshot)).toBeNull();
  });

  it('gives two windows independent environments over a shared catalogue', () => {
    writeOnboardingStateSnapshot({
      mode: 'ssh',
      currentStep: 'project',
      activeServerId: server.id,
      remoteConnectionReady: true,
      projectHandoffAcknowledged: true,
      servers: [server],
      lastSshDefaults: null,
      wsl: null,
      paired: null,
    });

    setWindow('w-beta');
    writeOnboardingStateSnapshot({
      ...readOnboardingStateSnapshot(),
      mode: 'local',
      activeServerId: null,
      remoteConnectionReady: true,
    });

    expect(readOnboardingStateSnapshot().mode).toBe('local');
    setWindow('w-alpha');
    const alpha = readOnboardingStateSnapshot();
    expect(alpha.mode).toBe('ssh');
    expect(alpha.activeServerId).toBe(server.id);
    // The server list itself is app-global.
    expect(alpha.servers).toHaveLength(1);
  });

  it('migrates an install that predates the split', () => {
    localStorage.setItem(ONBOARDING_STORAGE_KEY, JSON.stringify({
      mode: 'ssh',
      currentStep: 'project',
      activeServerId: server.id,
      remoteConnectionReady: true,
      projectHandoffAcknowledged: true,
      servers: [server],
      lastSshDefaults: null,
      wsl: null,
      paired: null,
    }));

    const snapshot = readOnboardingStateSnapshot();

    expect(snapshot.mode).toBe('ssh');
    expect(snapshot.activeServerId).toBe(server.id);
    expect(snapshot.servers).toHaveLength(1);
  });

  it('seeds a new window from the environment the main process opened it on', () => {
    // Otherwise a restored SSH window would come up on the local workspace (or
    // the onboarding screen) before correcting itself.
    localStorage.setItem(
      ENVIRONMENT_CATALOGUE_STORAGE_KEY,
      JSON.stringify({ servers: [server], lastSshDefaults: null }),
    );
    setWindow('w-fresh', { mode: 'ssh', serverId: server.id, label: 'Prod' });

    const snapshot = readOnboardingStateSnapshot();

    expect(snapshot.mode).toBe('ssh');
    expect(snapshot.activeServerId).toBe(server.id);
    // The tunnel still has to be claimed before requests may go anywhere.
    expect(snapshot.remoteConnectionReady).toBe(false);
    expect(snapshot.projectHandoffAcknowledged).toBe(true);
  });

  it('prefers stored window state over the injected environment', () => {
    localStorage.setItem(sessionKey('w-fresh'), JSON.stringify({
      mode: 'local',
      currentStep: 'project',
      remoteConnectionReady: true,
    }));
    setWindow('w-fresh', { mode: 'ssh', serverId: server.id, label: 'Prod' });

    expect(readOnboardingStateSnapshot().mode).toBe('local');
  });

  it('re-reads when storage changes underneath the memoised snapshot', () => {
    expect(readOnboardingStateSnapshot().mode).toBeNull();

    localStorage.setItem(sessionKey('w-alpha'), JSON.stringify({
      mode: 'local',
      currentStep: 'project',
      remoteConnectionReady: true,
    }));

    expect(readOnboardingStateSnapshot().mode).toBe('local');
  });

  it('keeps a paired window on its own loopback origin while the link is down', () => {
    const snapshot: OnboardingStateSnapshot = {
      mode: 'paired',
      currentStep: 'project',
      activeServerId: null,
      // The link dropped: nothing may open a socket, but requests must still
      // fail against the device rather than quietly answer from this machine.
      remoteConnectionReady: false,
      projectHandoffAcknowledged: true,
      servers: [],
      lastSshDefaults: null,
      wsl: null,
      paired: { id: 3, name: 'Studio', localPort: 51234 },
    };

    expect(getOnboardingBackendOrigin(snapshot)).toBe('http://127.0.0.1:51234');
  });

  it('falls back to defaults on unreadable storage', () => {
    localStorage.setItem(sessionKey('w-alpha'), '{ not json');
    localStorage.setItem(ENVIRONMENT_CATALOGUE_STORAGE_KEY, '{ not json');

    const snapshot = readOnboardingStateSnapshot();

    expect(snapshot.mode).toBeNull();
    expect(snapshot.servers).toEqual([]);
  });
});
