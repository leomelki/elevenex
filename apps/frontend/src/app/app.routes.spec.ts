import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Router } from '@angular/router';

import { canAccessAppRoute, getDefaultRedirectPath, routes } from './app.routes';
import { LAST_OPENED_SESSION_STORAGE_KEY } from './features/session/tab-service';
import { ONBOARDING_STORAGE_KEY } from './shared/services/onboarding-state.service';
import { AppSettingsService } from './shared/services/app-settings.service';

describe('getDefaultRedirectPath', () => {
  const routerMock = {
    createUrlTree: vi.fn((commands: string[]) => commands.join('/')),
  };
  const appSettingsMock = {
    load: vi.fn(),
  };

  beforeEach(() => {
    const store = new Map<string, string>();
    Object.defineProperty(globalThis, 'localStorage', {
      value: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => {
          store.set(key, value);
        },
        clear: () => {
          store.clear();
        },
      },
      configurable: true,
    });
    localStorage.clear();

    routerMock.createUrlTree.mockClear();
    appSettingsMock.load.mockResolvedValue({
      defaultClaudeSessionSurface: 'claude-ui',
      defaultAgentProvider: 'claude',
      sessionToolbarButtons: null,
      onboardingCompletedAt: '2026-01-01T00:00:00.000Z',
      createdAt: null,
      updatedAt: null,
    });

    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        { provide: Router, useValue: routerMock },
        { provide: AppSettingsService, useValue: appSettingsMock },
      ],
    });
  });

  it('should redirect to onboarding for a fresh install', () => {
    expect(TestBed.runInInjectionContext(() => getDefaultRedirectPath())).toBe('/onboarding');
  });

  it('should redirect to the last opened session when one is stored', () => {
    localStorage.setItem(ONBOARDING_STORAGE_KEY, JSON.stringify({
      mode: 'local',
      currentStep: 'project',
      activeServerId: null,
      remoteConnectionReady: true,
      projectHandoffAcknowledged: true,
      servers: [],
      lastSshDefaults: null,
    }));
    localStorage.setItem(LAST_OPENED_SESSION_STORAGE_KEY, '42');

    expect(TestBed.runInInjectionContext(() => getDefaultRedirectPath())).toBe('/sessions/42');
  });

  it('should redirect to projects when local onboarding is complete and no session is stored', () => {
    localStorage.setItem(ONBOARDING_STORAGE_KEY, JSON.stringify({
      mode: 'local',
      currentStep: 'project',
      activeServerId: null,
      remoteConnectionReady: true,
      projectHandoffAcknowledged: true,
      servers: [],
      lastSshDefaults: null,
    }));

    expect(TestBed.runInInjectionContext(() => getDefaultRedirectPath())).toBe('/projects');
  });

  it('should keep the workspace targetable for a saved SSH server even when the tunnel is not ready', () => {
    localStorage.setItem(ONBOARDING_STORAGE_KEY, JSON.stringify({
      mode: 'ssh',
      currentStep: 'project',
      activeServerId: 19,
      remoteConnectionReady: false,
      projectHandoffAcknowledged: true,
      servers: [{
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
      }],
      lastSshDefaults: null,
    }));

    expect(TestBed.runInInjectionContext(() => getDefaultRedirectPath())).toBe('/projects');
  });

  it('should block app routes before backend connection preflight is complete', async () => {
    await expect(TestBed.runInInjectionContext(() => canAccessAppRoute())).resolves.toBe('/onboarding');
    expect(appSettingsMock.load).not.toHaveBeenCalled();
  });

  it('should block app routes when backend onboarding is incomplete', async () => {
    localStorage.setItem(ONBOARDING_STORAGE_KEY, JSON.stringify({
      mode: 'local',
      currentStep: 'project',
      activeServerId: null,
      remoteConnectionReady: true,
      projectHandoffAcknowledged: false,
      servers: [],
      lastSshDefaults: null,
    }));
    appSettingsMock.load.mockResolvedValueOnce({
      defaultClaudeSessionSurface: 'claude-ui',
      defaultAgentProvider: 'claude',
      sessionToolbarButtons: null,
      onboardingCompletedAt: null,
      createdAt: null,
      updatedAt: null,
    });

    await expect(TestBed.runInInjectionContext(() => canAccessAppRoute())).resolves.toBe('/onboarding');
  });

  it('should allow app routes when backend onboarding is complete', async () => {
    localStorage.setItem(ONBOARDING_STORAGE_KEY, JSON.stringify({
      mode: 'local',
      currentStep: 'project',
      activeServerId: null,
      remoteConnectionReady: true,
      projectHandoffAcknowledged: false,
      servers: [],
      lastSshDefaults: null,
    }));

    await expect(TestBed.runInInjectionContext(() => canAccessAppRoute())).resolves.toBe(true);
  });

  it('should register the settings route behind the app access guard', () => {
    const settingsRoute = routes.find(route => route.path === 'settings');

    expect(settingsRoute).toBeTruthy();
    expect(settingsRoute?.canActivate).toEqual([canAccessAppRoute]);
  });

  it('should redirect the legacy info route to settings', () => {
    const infoRoute = routes.find(route => route.path === 'info');

    expect(infoRoute).toBeTruthy();
    expect(infoRoute?.redirectTo).toBe('settings');
  });
});
