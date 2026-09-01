import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ONBOARDING_STORAGE_KEY } from './onboarding-state.service';
import { installMemoryLocalStorage } from '../testing/memory-storage';
import {
  migrateScopedKey,
  migratedWindowScopedKey,
  parseWindowScopedKey,
  pruneOrphanWindowScopes,
  serverScopedKey,
  windowScopedKey,
} from './scoped-storage';

function setWindowId(windowId: string | undefined): void {
  (window as unknown as { __ELEVENEX_RUNTIME__?: unknown }).__ELEVENEX_RUNTIME__ = windowId
    ? { windowId }
    : {};
}

function connectSsh(id: number): void {
  localStorage.setItem(
    ONBOARDING_STORAGE_KEY,
    JSON.stringify({
      mode: 'ssh',
      remoteConnectionReady: true,
      activeServerId: id,
      servers: [{
        id,
        name: 'prod',
        sshHost: 'example.com',
        sshUser: 'deploy',
        authMode: 'agent',
        installStatus: 'available',
        sshPort: 22,
        localPort: 4310,
        remotePort: 11111,
      }],
    }),
  );
}

describe('scoped storage keys', () => {
  let restoreStorage: () => void;

  beforeEach(() => {
    restoreStorage = installMemoryLocalStorage();
    setWindowId('w-alpha');
  });

  afterEach(() => {
    restoreStorage();
    setWindowId(undefined);
  });

  it('scopes by backend, then by window', () => {
    expect(serverScopedKey('tabs')).toBe('tabs@local');
    expect(windowScopedKey('tabs')).toBe('tabs@local#win:w-alpha');
  });

  it('follows the active backend', () => {
    connectSsh(9);
    expect(serverScopedKey('tabs')).toBe('tabs@server-9');
    expect(windowScopedKey('tabs')).toBe('tabs@server-9#win:w-alpha');
  });

  it('collapses to a single scope in the browser, where there is one window', () => {
    setWindowId(undefined);
    expect(windowScopedKey('tabs')).toBe('tabs@local#win:w0');
  });

  it('keeps two windows on the same backend apart', () => {
    const first = windowScopedKey('tabs');
    setWindowId('w-beta');
    expect(windowScopedKey('tabs')).not.toBe(first);
  });

  it('recognises its own keys and ignores everything else', () => {
    expect(parseWindowScopedKey('tabs@local#win:w-alpha')).toEqual({ windowId: 'w-alpha' });
    expect(parseWindowScopedKey('tabs@local')).toBeNull();
    expect(parseWindowScopedKey('elevenex:browser-devtools-dock:project:1:tab:2')).toBeNull();
    expect(parseWindowScopedKey('tabs@local#win:')).toBeNull();
  });
});

describe('migrateScopedKey', () => {
  let restoreStorage: () => void;

  beforeEach(() => {
    restoreStorage = installMemoryLocalStorage();
    setWindowId('w-alpha');
  });

  afterEach(() => {
    restoreStorage();
  });

  it('moves a value written by an older build', () => {
    localStorage.setItem('tabs', 'legacy');

    const key = migratedWindowScopedKey('tabs');

    expect(localStorage.getItem(key)).toBe('legacy');
    expect(localStorage.getItem('tabs')).toBeNull();
  });

  it('migrates from a backend-scoped key for callers that already had one', () => {
    localStorage.setItem('tabs@local', 'legacy');

    const key = migratedWindowScopedKey('tabs', serverScopedKey('tabs'));

    expect(localStorage.getItem(key)).toBe('legacy');
    expect(localStorage.getItem('tabs@local')).toBeNull();
  });

  it('never overwrites a newer scoped value', () => {
    localStorage.setItem('tabs', 'legacy');
    localStorage.setItem(windowScopedKey('tabs'), 'current');

    migratedWindowScopedKey('tabs');

    expect(localStorage.getItem(windowScopedKey('tabs'))).toBe('current');
    expect(localStorage.getItem('tabs')).toBeNull();
  });

  it('is a no-op when there is nothing to migrate', () => {
    migrateScopedKey('absent', 'absent@local#win:w-alpha');
    expect(localStorage.getItem('absent@local#win:w-alpha')).toBeNull();
  });
});

describe('pruneOrphanWindowScopes', () => {
  let restoreStorage: () => void;

  beforeEach(() => {
    restoreStorage = installMemoryLocalStorage();
    setWindowId('w-alpha');
    localStorage.setItem('tabs@local#win:w-alpha', 'mine');
    localStorage.setItem('tabs@local#win:w-gone', 'stale');
    localStorage.setItem('elevenex-theme', 'dark');
  });

  afterEach(() => {
    restoreStorage();
  });

  it('drops state belonging to windows that no longer exist', () => {
    // Asserts on the keys rather than the count: the test environment's
    // localStorage may hold scoped keys written by other suites.
    const removed = pruneOrphanWindowScopes(['w-alpha'], { authoritative: true });

    expect(removed).toBeGreaterThanOrEqual(1);
    expect(localStorage.getItem('tabs@local#win:w-gone')).toBeNull();
    expect(localStorage.getItem('tabs@local#win:w-alpha')).toBe('mine');
    expect(localStorage.getItem('elevenex-theme')).toBe('dark');
  });

  it('refuses to run on a list it cannot trust', () => {
    // Before the window list has arrived — or in a browser, where it never
    // will — wiping every scope would look like the app losing all open tabs.
    expect(pruneOrphanWindowScopes(['w-alpha'], { authoritative: false })).toBe(0);
    expect(pruneOrphanWindowScopes([], { authoritative: true })).toBe(0);
    expect(localStorage.getItem('tabs@local#win:w-gone')).toBe('stale');
  });

  it('never deletes the current window, even if the list omits it', () => {
    pruneOrphanWindowScopes(['w-gone'], { authoritative: true });

    expect(localStorage.getItem('tabs@local#win:w-alpha')).toBe('mine');
  });
});
