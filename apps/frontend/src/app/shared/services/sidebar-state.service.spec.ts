import { TestBed } from '@angular/core/testing';
import { Injector } from '@angular/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installMemoryLocalStorage } from '../testing/memory-storage';
import { OnboardingStateService } from './onboarding-state.service';
import { pruneOrphanWindowScopes } from './scoped-storage';
import { SidebarStateService, SIDEBAR_DEFAULT_WIDTH } from './sidebar-state.service';

describe('SidebarStateService', () => {
  let restoreStorage: () => void;
  let onboarding: OnboardingStateService;
  let service: SidebarStateService;

  // Separate injectors simulate independent renderers sharing localStorage.
  function openWindow(state: OnboardingStateService = onboarding): SidebarStateService {
    return Injector.create({
      parent: TestBed.inject(Injector),
      providers: [SidebarStateService, { provide: OnboardingStateService, useValue: state }],
    }).get(SidebarStateService);
  }

  beforeEach(() => {
    restoreStorage = installMemoryLocalStorage();
    window.__ELEVENEX_RUNTIME__ = { windowId: 'w-first' };
    TestBed.configureTestingModule({});
    onboarding = TestBed.inject(OnboardingStateService);
    service = openWindow();
  });

  afterEach(() => {
    restoreStorage();
    window.__ELEVENEX_RUNTIME__ = undefined;
    vi.restoreAllMocks();
  });

  it('starts collapsed without writing defaults over stored choices', () => {
    const write = vi.spyOn(localStorage, 'setItem');
    expect(service.expandedKeys()).toEqual(new Set());
    expect(service.sessionListVisibleLimits().size).toBe(0);
    expect(service.width()).toBe(SIDEBAR_DEFAULT_WIDTH);
    expect(write).not.toHaveBeenCalled();
  });

  it('restores nested nodes, finished tasks, session limits, and width in a new window', () => {
    const nodes = [
      'project-1',
      'repo-2',
      'workspace-2-3',
      'session-folder-4',
      'archive-2-3',
      'threads-5',
      'finished-2',
    ];
    for (const key of nodes) service.setExpanded(key, true);
    service.setSessionListVisibleLimit('2-3', 28);
    service.setWidth(350);

    window.__ELEVENEX_RUNTIME__ = { windowId: 'w-new' };
    const restored = openWindow();
    expect(restored.expandedKeys()).toEqual(new Set(nodes));
    expect(restored.sessionListVisibleLimits()).toEqual(new Map([['2-3', 28]]));
    expect(restored.width()).toBe(350);

    // Closing the original desktop window no longer discards its sidebar memory.
    pruneOrphanWindowScopes(['w-new'], { authoritative: true });
    expect(openWindow().expandedKeys()).toEqual(new Set(nodes));
  });

  it('remembers collapses including an entirely collapsed sidebar', () => {
    service.setExpanded('project-1', true);
    service.setExpanded('project-1', false);
    service.setSessionListVisibleLimit('2-3', 48);
    service.setSessionListVisibleLimit('2-3', null);
    expect(openWindow().expandedKeys().size).toBe(0);
    expect(openWindow().sessionListVisibleLimits().size).toBe(0);
  });

  it('persists clamped width only when a resize finishes', () => {
    service.setWidth(600, false);
    expect(service.width()).toBe(420);
    expect(openWindow().width()).toBe(SIDEBAR_DEFAULT_WIDTH);
    service.setWidth(service.width());
    expect(openWindow().width()).toBe(420);
    service.setWidth(200);
    expect(openWindow().width()).toBe(250);
  });

  it('keeps running windows independent and writes only the item changed by each window', () => {
    service.setExpanded('project-1', true);
    const second = openWindow();
    expect(second.expandedKeys()).toEqual(new Set(['project-1']));

    service.setExpanded('project-1', false);
    service.setExpanded('repo-2', true);
    service.setSessionListVisibleLimit('2-3', 28);
    service.setWidth(350);
    // A storage event must not reset another live window's current choices.
    window.dispatchEvent(new StorageEvent('storage'));
    expect(second.expandedKeys()).toEqual(new Set(['project-1']));
    expect(second.width()).toBe(SIDEBAR_DEFAULT_WIDTH);
    second.setExpanded('workspace-2-3', true);
    second.setSessionListVisibleLimit('2-4', 48);

    expect(service.expandedKeys()).toEqual(new Set(['repo-2']));
    const restored = openWindow();
    expect(restored.expandedKeys()).toEqual(new Set(['repo-2', 'workspace-2-3']));
    expect(restored.sessionListVisibleLimits()).toEqual(
      new Map([
        ['2-3', 28],
        ['2-4', 48],
      ]),
    );
    expect(restored.width()).toBe(350);
  });

  it('restores each backend on switching without carrying over identical node ids', () => {
    service.setExpanded('project-1', true);
    service.setSessionListVisibleLimit('2-3', 28);
    service.setWidth(350);

    onboarding.setPairedState({ id: 9, name: 'First backend', localPort: 4321 });
    // No effect tick or reload is needed to get the new backend's memory.
    expect(service.expandedKeys().size).toBe(0);
    expect(service.sessionListVisibleLimits().size).toBe(0);
    expect(service.width()).toBe(SIDEBAR_DEFAULT_WIDTH);
    service.setExpanded('repo-2', true);

    onboarding.setPairedState({ id: 10, name: 'Second backend', localPort: 4322 });
    service.setExpanded('workspace-2-3', true);
    onboarding.setMode('local');
    expect(service.expandedKeys()).toEqual(new Set(['project-1']));
    expect(service.sessionListVisibleLimits()).toEqual(new Map([['2-3', 28]]));
    expect(service.width()).toBe(350);
    onboarding.setPairedState({ id: 9, name: 'First backend', localPort: 5432 });
    expect(service.expandedKeys()).toEqual(new Set(['repo-2']));
  });

  it('does not restore again on reconnect or unrelated onboarding updates', () => {
    service.setExpanded('project-1', true);
    const second = openWindow();
    second.setExpanded('project-1', false);
    onboarding.setRemoteConnectionReady(false);
    onboarding.setRemoteConnectionReady(true);
    expect(service.expandedKeys()).toEqual(new Set(['project-1']));
    expect(openWindow().expandedKeys().size).toBe(0);
  });

  it('keys SSH memory by saved server identity and keeps WSL separate', () => {
    const server = {
      id: 7,
      name: 'SSH backend',
      sshHost: 'example.com',
      sshUser: 'deploy',
      sshPort: 22,
      authMode: 'agent' as const,
      identityFilePath: null,
      localPort: 4321,
      remotePort: 11111,
      installStatus: 'available' as const,
      createdAt: '',
      updatedAt: '',
      lastConnectedAt: '',
    };
    onboarding.saveServer(server);
    service.setExpanded('project-1', true);
    onboarding.saveServer({ ...server, id: 8 });
    expect(service.expandedKeys().size).toBe(0);
    service.setExpanded('repo-2', true);
    onboarding.setWslState({
      distroName: 'Ubuntu',
      localPort: 4323,
      installStatus: 'available',
      lastConnectedAt: '',
    });
    expect(service.expandedKeys().size).toBe(0);
    service.setExpanded('workspace-2-3', true);
    onboarding.saveServer({ ...server, localPort: 5432 });
    expect(service.expandedKeys()).toEqual(new Set(['project-1']));
    onboarding.setMode('wsl');
    expect(service.expandedKeys()).toEqual(new Set(['workspace-2-3']));
  });

  it('discards every legacy expansion and width scope without migrating it', () => {
    localStorage.setItem('elevenex-nav-expanded', '["project-1"]');
    localStorage.setItem('elevenex-nav-expanded@local#win:w-first', '["repo-2"]');
    localStorage.setItem('elevenex-nav-expanded@server-9#win:w-old', '["project-3"]');
    localStorage.setItem('sidebar-width@local#win:w-first', '400');
    localStorage.setItem('other-setting', 'keep');
    expect(service.expandedKeys().size).toBe(0);
    expect(service.width()).toBe(SIDEBAR_DEFAULT_WIDTH);
    expect(localStorage.length).toBe(1);
    expect(localStorage.getItem('other-setting')).toBe('keep');
  });

  it('ignores corrupt entries and uses defaults for invalid limits and widths', () => {
    const prefix = 'elevenex-sidebar-state-v1@local:';
    localStorage.setItem(`${prefix}expanded:project-1`, '{broken');
    localStorage.setItem(`${prefix}expanded:`, 'true');
    localStorage.setItem(`${prefix}session-limit:2-3`, '-1');
    localStorage.setItem(`${prefix}session-limit:2-4`, 'Infinity');
    localStorage.setItem(`${prefix}session-limit:2-5`, '28.5');
    localStorage.setItem(`${prefix}width`, 'NaN');
    expect(service.expandedKeys().size).toBe(0);
    expect(service.sessionListVisibleLimits().size).toBe(0);
    expect(service.width()).toBe(SIDEBAR_DEFAULT_WIDTH);
  });

  it('keeps the sidebar usable when storage reads and writes fail', () => {
    localStorage.setItem('unrelated', 'value');
    vi.spyOn(localStorage, 'key').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
      throw new Error('full');
    });
    vi.spyOn(localStorage, 'removeItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(service.expandedKeys().size).toBe(0);
    expect(() => service.setExpanded('project-1', true)).not.toThrow();
    expect(service.expandedKeys()).toEqual(new Set(['project-1']));
    expect(() => service.setExpanded('project-1', false)).not.toThrow();
    expect(service.expandedKeys().size).toBe(0);
  });
});
