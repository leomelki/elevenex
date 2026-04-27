import { HttpInterceptorFn, withInterceptors } from '@angular/common/http';
import { getBackendOrigin } from './runtime-config';

const ABSOLUTE_URL_PATTERN = /^[a-z][a-z\d+\-.]*:\/\//i;

const apiBaseInterceptor: HttpInterceptorFn = (req, next) => {
  if (!req.url.startsWith('/') || ABSOLUTE_URL_PATTERN.test(req.url)) {
    return next(req);
  }

  return next(req.clone({
    url: `${getBackendOrigin()}${req.url}`,
  }));
};

export function provideApiBaseInterceptor() {
  return withInterceptors([apiBaseInterceptor]);
}
