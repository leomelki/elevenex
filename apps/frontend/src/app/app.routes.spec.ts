import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Router } from '@angular/router';

import { canAccessAppRoute, getDefaultRedirectPath, routes } from './app.routes';
import { LAST_OPENED_SESSION_STORAGE_KEY } from './features/session/tab-service';
import { ONBOARDING_STORAGE_KEY } from './shared/services/onboarding-state.service';

describe('getDefaultRedirectPath', () => {
  const routerMock = {
    createUrlTree: vi.fn((commands: string[]) => commands.join('/')),
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

    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        { provide: Router, useValue: routerMock },
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

  it('should keep the workspace accessible for a saved SSH server even when the tunnel is not ready', () => {
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
    expect(TestBed.runInInjectionContext(() => canAccessAppRoute())).toBe(true);
  });

  it('should block app routes before onboarding is complete', () => {
    expect(TestBed.runInInjectionContext(() => canAccessAppRoute())).toBe('/onboarding');
  });

  it('should register the info route behind the app access guard', () => {
    const infoRoute = routes.find(route => route.path === 'info');

    expect(infoRoute).toBeTruthy();
    expect(infoRoute?.canActivate).toEqual([canAccessAppRoute]);
  });
});
