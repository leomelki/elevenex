import { inject } from '@angular/core';
import { HttpInterceptorFn, withInterceptors } from '@angular/common/http';
import { from, switchMap } from 'rxjs';
import { getBackendOrigin } from './runtime-config';
import { ServerConnectionService } from '../services/server-connection.service';

const ABSOLUTE_URL_PATTERN = /^[a-z][a-z\d+\-.]*:\/\//i;

const apiBaseInterceptor: HttpInterceptorFn = (req, next) => {
  const backendOrigin = getBackendOrigin();
  const isRelativeBackendRequest = req.url.startsWith('/');
  const isAbsoluteBackendRequest = req.url.startsWith(`${backendOrigin}/`);

  if (!isRelativeBackendRequest && !isAbsoluteBackendRequest) {
    return next(req);
  }

  const serverConnection = inject(ServerConnectionService);
  const request = isRelativeBackendRequest && !ABSOLUTE_URL_PATTERN.test(req.url)
    ? req.clone({ url: `${backendOrigin}${req.url}` })
    : req;

  return from(serverConnection.waitUntilInteractive()).pipe(
    switchMap(() => next(request)),
  );
};

export function provideApiBaseInterceptor() {
  return withInterceptors([apiBaseInterceptor]);
}
