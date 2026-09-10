import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ONBOARDING_STORAGE_KEY } from '../services/onboarding-state.service';
import { installMemoryLocalStorage } from '../testing/memory-storage';
import { getApiBaseUrl } from './runtime-config';

/** What Electron's preload injects: this machine's backend, fixed at window open. */
const LOCAL_ORIGIN = 'http://127.0.0.1:50111';

const SSH_SERVER = {
  id: 19,
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

function storeOnboarding(overrides: Record<string, unknown>): void {
  localStorage.setItem(
    ONBOARDING_STORAGE_KEY,
    JSON.stringify({
      mode: 'local',
      currentStep: 'project',
      activeServerId: null,
      remoteConnectionReady: true,
      projectHandoffAcknowledged: true,
      servers: [],
      lastSshDefaults: null,
      ...overrides,
    }),
  );
}

describe('getApiBaseUrl', () => {
  let restoreStorage: () => void;

  beforeEach(() => {
    restoreStorage = installMemoryLocalStorage();
    window.__ELEVENEX_RUNTIME__ = { backendOrigin: LOCAL_ORIGIN, apiBaseUrl: `${LOCAL_ORIGIN}/api` };
  });

  afterEach(() => {
    delete window.__ELEVENEX_RUNTIME__;
    restoreStorage();
  });

  it('uses the injected API base on the local backend', () => {
    storeOnboarding({ mode: 'local' });

    expect(getApiBaseUrl()).toBe(`${LOCAL_ORIGIN}/api`);
  });

  it('follows a switch to an SSH backend rather than the one the window opened on', () => {
    // Hand-built URLs — markdown images — used to keep asking this machine for
    // files that only exist on the remote one.
    storeOnboarding({ mode: 'ssh', activeServerId: 19, servers: [SSH_SERVER] });

    expect(getApiBaseUrl()).toBe('http://127.0.0.1:4310/api');
  });

  it('agrees with REST calls while the tunnel is still coming up', () => {
    storeOnboarding({
      mode: 'ssh',
      activeServerId: 19,
      remoteConnectionReady: false,
      servers: [SSH_SERVER],
    });

    expect(getApiBaseUrl()).toBe(`${LOCAL_ORIGIN}/api`);
  });
});
