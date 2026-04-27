import { APP_INITIALIZER, ApplicationConfig, provideBrowserGlobalErrorListeners } from '@angular/core';
import { provideRouter } from '@angular/router';
import { provideHttpClient } from '@angular/common/http';
import { withHashLocation } from '@angular/router';
import { routes } from './app.routes';
import { provideZard } from '@/shared/core/provider/providezard';
import { provideApiBaseInterceptor } from './shared/runtime/api-base.interceptor';
import { shouldUseHashLocation } from './shared/runtime/runtime-config';
import { OnboardingStartupService } from './shared/services/onboarding-startup.service';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideRouter(routes, ...(shouldUseHashLocation() ? [withHashLocation()] : [])),
    provideHttpClient(provideApiBaseInterceptor()),
    provideZard(),
    {
      provide: APP_INITIALIZER,
      multi: true,
      deps: [OnboardingStartupService],
      useFactory: (startup: OnboardingStartupService) => () => startup.initialize(),
    },
  ],
};
