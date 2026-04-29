import { ApplicationConfig, provideBrowserGlobalErrorListeners } from '@angular/core';
import { provideRouter } from '@angular/router';
import { provideHttpClient } from '@angular/common/http';
import { withHashLocation } from '@angular/router';
import { routes } from './app.routes';
import { provideZard } from '@/shared/core/provider/providezard';
import { provideApiBaseInterceptor } from './shared/runtime/api-base.interceptor';
import { shouldUseHashLocation } from './shared/runtime/runtime-config';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideRouter(routes, ...(shouldUseHashLocation() ? [withHashLocation()] : [])),
    provideHttpClient(provideApiBaseInterceptor()),
    provideZard(),
  ],
};
