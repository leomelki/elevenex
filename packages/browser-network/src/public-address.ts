import { isIP } from 'node:net';

/** A public-page proxy must never turn DNS rebinding into desktop/LAN access.
 * Task loopback services take a separate, explicitly leased route. */
export function publicBrowserAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a = 0, b = 0, c = 0] = address.split('.').map(Number);
    if (a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)) || (b === 88 && c === 99))) || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113)) return false;
    return true;
  }
  if (isIP(address) !== 6) return false;
  const host = new URL(`http://[${address}]/`).hostname.slice(1, -1).toLowerCase();
  if (host.startsWith('::ffff:')) {
    const parts = host.slice(7).split(':');
    if (parts.length !== 2) return false;
    const first = parseInt(parts[0]!, 16), last = parseInt(parts[1]!, 16);
    return publicBrowserAddress(`${first >>> 8}.${first & 255}.${last >>> 8}.${last & 255}`);
  }
  const first = parseInt(host.split(':')[0] ?? '0', 16);
  return first >= 0x2000 && first <= 0x3fff && !host.startsWith('2001:db8:') && !host.startsWith('2001::') && !host.startsWith('2001:0:') && !host.startsWith('3fff:') && !host.startsWith('2002:');
}
