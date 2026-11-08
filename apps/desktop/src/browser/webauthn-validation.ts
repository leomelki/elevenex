import type { BrowserWebAuthnOptions, BrowserWebAuthnRequest } from '@elevenex/shared';
import { browserId, exact, record } from './validation';

export function webAuthnRequest(value: unknown): BrowserWebAuthnRequest {
  const raw = record(value), origin = raw['origin'];
  if (typeof origin !== 'string' || origin.length > 2048) throw new Error('Invalid authentication origin');
  const url = new URL(origin);
  const local = url.hostname === 'localhost' || url.hostname.endsWith('.localhost') || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) || url.origin !== origin || url.username || url.password || (raw['operation'] !== 'create' && raw['operation'] !== 'get')) throw new Error('Invalid authentication request');
  return { id: browserId(raw['id']), origin, operation: raw['operation'] };
}

export function webAuthnOptions(value: unknown, expected: BrowserWebAuthnRequest): BrowserWebAuthnOptions {
  const raw = record(value), parsed = webAuthnRequest(raw);
  exact(raw, ['id', 'origin', 'operation', 'optionsJson']);
  if (parsed.id !== expected.id || parsed.origin !== expected.origin || parsed.operation !== expected.operation || typeof raw['optionsJson'] !== 'string' || raw['optionsJson'].length > 65536) throw new Error('Authentication changed');
  const options = record(JSON.parse(raw['optionsJson'])), extensions = record(options['extensions']);
  const override = record(extensions['remoteDesktopClientOverride']);
  if (override['origin'] !== expected.origin || override['sameOriginWithAncestors'] !== true || extensions['remoteClientDataJSON'] !== undefined) throw new Error('Invalid authentication delegation');
  // The local browser independently enforces RP ID / origin binding. Never let
  // remotely supplied extension fields turn off that enforcement in the broker.
  delete extensions['remoteDesktopClientOverride'];
  return { ...parsed, optionsJson: JSON.stringify(options) };
}
