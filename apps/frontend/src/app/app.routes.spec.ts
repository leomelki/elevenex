import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Router } from '@angular/router';

import { canAccessAppRoute, getDefaultRedirectPath, routes } from './app.routes';
import { LAST_OPENED_SESSION_STORAGE_KEY } from './features/session/tab-service';
import { ONBOARDING_STORAGE_KEY } from './shared/services/onboarding-state.service';
import { OnboardingStartupService } from './shared/services/onboarding-startup.service';

describe('getDefaultRedirectPath', () => {
  const startupFailure = signal<unknown>(null);
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

    startupFailure.set(null);
    routerMock.createUrlTree.mockClear();

    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        { provide: Router, useValue: routerMock },
        { provide: OnboardingStartupService, useValue: { startupFailure: startupFailure.asReadonly() } },
      ],
    });
  });

  it('should redirect to projects when no last opened session is stored', () => {
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

  it('should redirect to projects when onboarding is complete and no session is stored', () => {
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

  it('should block app routes before onboarding is complete', () => {
    expect(TestBed.runInInjectionContext(() => canAccessAppRoute())).toBe('/onboarding');
  });

  it('should register the info route behind the app access guard', () => {
    const infoRoute = routes.find(route => route.path === 'info');

    expect(infoRoute).toBeTruthy();
    expect(infoRoute?.canActivate).toEqual([canAccessAppRoute]);
  });
});
