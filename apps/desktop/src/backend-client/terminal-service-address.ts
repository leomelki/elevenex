import { isIP } from 'node:net';
import type { TaskTerminalServiceAddress } from '@elevenex/shared';
import { integer, object, text } from './terminal-validation';

export function parseTerminalServiceAddress(raw: unknown): TaskTerminalServiceAddress {
  const value = object(raw);
  const port = integer(value['port'], 1, 65535);
  const host = text(value['host'], 45);
  const protocol = value['protocol'];
  const path = text(value['path'], 2048);
  if ((host !== '::1' && !(isIP(host) === 4 && host.startsWith('127.'))) ||
      (protocol !== 'http' && protocol !== 'https') || !path.startsWith('/') || path.startsWith('//') ||
      // eslint-disable-next-line no-control-regex -- Backend/output hints cannot control navigation authorities.
      /[\u0000-\u0020\u007f\\?#]/.test(path)) throw new Error('Invalid terminal service address');
  const url = new URL(path, 'http://localhost');
  if (url.origin !== 'http://localhost' || url.pathname !== path) throw new Error('Invalid service path');
  return { port, host, protocol, path };
}
