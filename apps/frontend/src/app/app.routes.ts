import { inject } from '@angular/core';
import { Router, Routes, UrlTree } from '@angular/router';
import { readLastOpenedSessionId } from './features/session/tab-service';
import {
  getActiveOnboardingServer,
  readOnboardingStateSnapshot,
} from './shared/services/onboarding-state.service';
import { OnboardingStateSnapshot } from './shared/models/onboarding.model';

function hasFunctionalOnboarding(snapshot: OnboardingStateSnapshot): boolean {
  if (!snapshot.projectHandoffAcknowledged) {
    return false;
  }
  if (snapshot.mode === 'local') {
    return true;
  }
  // For SSH mode, allow workspace access whenever the user has an active server saved,
  // even if the live tunnel isn't ready — the runtime overlay handles reconnect / change-server.
  return snapshot.mode === 'ssh' && getActiveOnboardingServer(snapshot) !== null;
}

export function getDefaultRedirectPath(): string {
  if (!hasFunctionalOnboarding(readOnboardingStateSnapshot())) {
    return '/onboarding';
  }

  const sessionId = readLastOpenedSessionId();
  return sessionId ? `/sessions/${sessionId}` : '/projects';
}

export function canAccessAppRoute(): boolean | UrlTree {
  if (hasFunctionalOnboarding(readOnboardingStateSnapshot())) {
    return true;
  }

  const router = inject(Router);
  return router.createUrlTree(['/onboarding']);
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
    canActivate: [canAccessAppRoute],
    loadComponent: () =>
      import('./features/info/info').then(m => m.Info),
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
