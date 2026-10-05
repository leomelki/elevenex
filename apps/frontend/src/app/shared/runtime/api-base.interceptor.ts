import { inject, untracked } from '@angular/core';
import { HttpInterceptorFn, withInterceptors } from '@angular/common/http';
import { Observable, switchMap } from 'rxjs';
import { getBackendOrigin } from './runtime-config';
import { ServerConnectionService } from '../services/server-connection.service';

const ABSOLUTE_URL_PATTERN = /^[a-z][a-z\d+\-.]*:\/\//i;

// Untracked because subscribing runs this synchronously inside whatever effect
// sent the request. The connection state read while gating would otherwise
// become that effect's dependency, re-running it — and resending its request —
// on every reconnect.
const apiBaseInterceptor: HttpInterceptorFn = (req, next) => untracked(() => {
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

  const ready = new Observable<void>((subscriber) => {
    const controller = new AbortController();
    untracked(() => serverConnection.waitUntilInteractive(controller.signal)).then(
      () => { subscriber.next(); subscriber.complete(); },
      (error) => subscriber.error(error),
    );
    return () => controller.abort();
  });
  return ready.pipe(switchMap(() => {
    if (getBackendOrigin() !== backendOrigin) throw new Error('The backend changed before this request could be sent.');
    return next(request);
  }));
});

export function provideApiBaseInterceptor() {
  return withInterceptors([apiBaseInterceptor]);
}
