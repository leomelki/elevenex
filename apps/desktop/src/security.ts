import { resolve, relative, extname, isAbsolute } from 'node:path';

export const APP_ORIGIN = 'app://elevenex';

export function isAppUrl(value: string, devUrl?: string): boolean {
  try {
    const url = new URL(value);
    if (url.username || url.password) return false;
    return devUrl
      ? url.origin === new URL(devUrl).origin
      : url.protocol === 'app:' && url.host === 'elevenex';
  } catch {
    return false;
  }
}

export function isExternalUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password;
  } catch {
    return false;
  }
}

export function contentSecurityPolicy(devUrl?: string): string {
  const connect = devUrl ? `'self' ${new URL(devUrl).origin} ${new URL(devUrl).origin.replace('http:', 'ws:')}` : "'self'";
  // Angular injects production component styles with ngCspNonce. Vite HMR adds
  // style elements in development, so only the dev policy permits inline CSS.
  return [
    "default-src 'none'",
    "script-src 'self'",
    devUrl ? "style-src 'self' 'unsafe-inline'" : "style-src 'self' 'nonce-__ELEVENEX_NONCE__'",
    "font-src 'self'",
    "img-src 'self' data:",
    `connect-src ${connect}`,
    "base-uri 'self'",
    "object-src 'none'",
    "frame-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'none'",
  ].join('; ');
}

/** Decode before resolving and reject traversal; callers separately check symlinks. */
export function rendererPath(root: string, requestUrl: string): string | undefined {
  if (!isAppUrl(requestUrl)) return undefined;
  try {
    const pathname = decodeURIComponent(new URL(requestUrl).pathname);
    if (pathname.includes('\0') || pathname.includes('\\')) return undefined;
    const file = resolve(root, `.${pathname}`);
    const child = relative(root, file);
    if (child.startsWith('..') || isAbsolute(child)) return undefined;
    return extname(file) ? file : resolve(root, 'index.html');
  } catch {
    return undefined;
  }
}
