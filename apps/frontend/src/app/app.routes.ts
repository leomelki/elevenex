import { inject } from '@angular/core';
import { Router, Routes, UrlTree } from '@angular/router';
import { readLastOpenedSessionId } from './features/session/tab-service';
import {
  getActiveOnboardingServer,
  readOnboardingStateSnapshot,
} from './shared/services/onboarding-state.service';
import { OnboardingStateSnapshot } from './shared/models/onboarding.model';
import { AppSettingsService } from './shared/services/app-settings.service';

function hasBackendConnection(snapshot: OnboardingStateSnapshot): boolean {
  if (snapshot.mode === 'local') {
    return true;
  }
  // For WSL mode, allow workspace access whenever a WSL connection was ever
  // established, mirroring the SSH server case below.
  if (snapshot.mode === 'wsl') {
    return snapshot.wsl !== null;
  }
  // For SSH mode, allow workspace access whenever the user has an active server saved,
  // even if the live tunnel isn't ready — the runtime overlay handles reconnect / change-server.
  return snapshot.mode === 'ssh' && getActiveOnboardingServer(snapshot) !== null;
}

export function getDefaultRedirectPath(): string {
  if (!hasBackendConnection(readOnboardingStateSnapshot())) {
    return '/onboarding';
  }

  const sessionId = readLastOpenedSessionId();
  return sessionId ? `/sessions/${sessionId}` : '/projects';
}

export async function canAccessAppRoute(): Promise<boolean | UrlTree> {
  const router = inject(Router);
  if (!hasBackendConnection(readOnboardingStateSnapshot())) {
    return router.createUrlTree(['/onboarding']);
  }

  const appSettings = inject(AppSettingsService);
  try {
    const settings = await appSettings.load();
    return settings.onboardingCompletedAt
      ? true
      : router.createUrlTree(['/onboarding']);
  } catch {
    return router.createUrlTree(['/onboarding']);
  }
}

export const routes: Routes = [
  { path: '', redirectTo: getDefaultRedirectPath, pathMatch: 'full' },
  {
    path: 'onboarding',
    loadComponent: () =>
      import('./features/onboarding/onboarding').then(m => m.Onboarding),
  },
  {
    path: 'info',
    redirectTo: 'settings',
    pathMatch: 'full',
  },
  {
    path: 'settings',
    canActivate: [canAccessAppRoute],
    loadComponent: () =>
      import('./features/settings/settings').then(m => m.Settings),
  },
  {
    path: 'projects',
    canActivate: [canAccessAppRoute],
    loadComponent: () =>
      import('./features/projects/project-list/project-list').then(m => m.ProjectList),
  },
  {
    path: 'projects/:id',
    canActivate: [canAccessAppRoute],
    loadComponent: () =>
      import('./features/projects/project-detail/project-detail').then(m => m.ProjectDetail),
  },
  {
    path: 'sessions',
    canActivate: [canAccessAppRoute],
    loadComponent: () =>
      import('./features/session/session-container/session-container').then(m => m.SessionContainer),
    children: [
      {
        path: ':id',
        loadComponent: () =>
          // Empty component - session-container handles display
          import('./features/session/session-route-wrapper/session-route-wrapper').then(m => m.SessionRouteWrapper),
      },
    ],
  },
];
