import { createHmac } from 'node:crypto';
import { connect } from 'node:tls';

/** Derive a distinct channel key for every backend incarnation. Unlike a Unix
 * socket, the name of a Windows pipe is public and cannot authenticate a peer. */
export function windowsPipeKey(token: string, instance: string): string {
  return createHmac('sha256', token).update('elevenex-windows-backend:' + instance).digest('hex');
}

export function connectWindowsPipe(path: string, key: string) {
  if (!/^[a-f0-9]{64}$/.test(key)) throw new Error('Invalid backend pipe credential');
  return connect({
    path, minVersion: 'TLSv1.2', maxVersion: 'TLSv1.2',
    ciphers: 'PSK-AES128-GCM-SHA256',
    // Both peers prove possession of the instance key through the TLS PSK
    // handshake. This suite does not use certificates or anonymous ciphers.
    rejectUnauthorized: false,
    pskCallback: () => ({ identity: 'elevenex-bridge', psk: Buffer.from(key, 'hex') }),
  });
}
