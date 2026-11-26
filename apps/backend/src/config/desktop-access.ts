import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

type Sender = Pick<IncomingMessage, 'headers' | 'socket'>;

// Bootstrap deletes the inherited credentials before initializing any providers
// that start subprocesses. The fallback supports independently assembled hosts.
const localAccess = process.env.ELEVENEX_CODE_ACCESS;
const appAccess = process.env.ELEVENEX_APP_ACCESS;
const handoffAccess = process.env.ELEVENEX_APP_HANDOFF;
export function localDesktopAccess(): string | undefined {
  return localAccess ?? process.env.ELEVENEX_CODE_ACCESS;
}
function matches(supplied: string | string[] | undefined, expected: string | undefined) {
  return typeof expected === 'string' && /^[a-f0-9]{64}$/.test(expected) &&
    typeof supplied === 'string' && /^[a-f0-9]{64}$/.test(supplied) &&
    timingSafeEqual(Buffer.from(supplied), Buffer.from(expected));
}
function privateSocket(request: Sender) {
  return !!process.env.ELEVENEX_DESKTOP_SOCKET && request.socket.remoteAddress === undefined &&
    request.socket.localAddress === undefined;
}
function desktopOrigin(request: Sender) {
  return request.headers.origin === undefined && request.headers['sec-fetch-site'] === undefined;
}
export function hasDesktopAccess(request: Sender): boolean {
  return desktopOrigin(request) && (privateSocket(request) ||
    matches(request.headers['x-elevenex-code-access'], localDesktopAccess()));
}
/** A process that finds the Unix socket cannot approve its own app request. */
export function hasAppViewerAccess(request: Sender): boolean {
  return desktopOrigin(request) && (privateSocket(request)
    ? matches(request.headers['x-elevenex-app-access'], appAccess ?? process.env.ELEVENEX_APP_ACCESS)
    : matches(request.headers['x-elevenex-code-access'], localDesktopAccess()));
}

/** Only a daemon on the private transport can seal new app launches for an engine update. */
export function hasAppHandoffAccess(request: Sender): boolean {
  return desktopOrigin(request) && privateSocket(request) &&
    matches(request.headers['x-elevenex-app-handoff'], handoffAccess ?? process.env.ELEVENEX_APP_HANDOFF);
}
