import { inject } from '@angular/core';
import { Router, Routes, UrlTree } from '@angular/router';
import { readLastOpenedSessionId } from './features/session/tab-service';
import { isOnboardingComplete, readOnboardingStateSnapshot } from './shared/services/onboarding-state.service';
import { OnboardingStartupService } from './shared/services/onboarding-startup.service';

export function getDefaultRedirectPath(): string {
  const startupService = inject(OnboardingStartupService);
  if (startupService.startupFailure()) {
    return '/connection-lost';
  }

  if (!isOnboardingComplete(readOnboardingStateSnapshot())) {
    return '/onboarding';
  }

  const sessionId = readLastOpenedSessionId();
  return sessionId ? `/sessions/${sessionId}` : '/projects';
}

export function canAccessAppRoute(): boolean | UrlTree {
  if (isOnboardingComplete(readOnboardingStateSnapshot())) {
    return true;
  }

  const router = inject(Router);
  const startupService = inject(OnboardingStartupService);
  if (startupService.startupFailure()) {
    return router.createUrlTree(['/connection-lost']);
  }
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
    path: 'connection-lost',
    loadComponent: () =>
      import('./features/connection-lost/connection-lost').then(m => m.ConnectionLost),
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
