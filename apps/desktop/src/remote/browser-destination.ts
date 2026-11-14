import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { publicBrowserAddress } from '@elevenex/browser-network/dist/public-address';
import type { BrowserSocketTarget } from '@elevenex/browser-network';

/** SSH-side public egress. Loopback grants use the existing separate forward path. */
export class BrowserDestinations {
  private readonly pending = new Map<string, Promise<BrowserSocketTarget['addresses']>>();
  private closed = false;
  async resolve(host: string, port: number): Promise<BrowserSocketTarget> {
    if (this.closed) throw new Error('Browser connection closed');
    if (isIP(host)) {
      if (!publicBrowserAddress(host)) throw new Error('Private browser destination');
      return { host, port };
    }
    let pending = this.pending.get(host);
    if (!pending) {
      if (this.pending.size >= 32) throw new Error('Browser DNS limit reached');
      pending = lookup(host, { all: true, verbatim: true }).then(addresses => {
        // Pin every accepted answer; never resolve again during connect.
        if (!addresses.length || addresses.some(value => !publicBrowserAddress(value.address))) throw new Error('Private browser destination');
        return addresses.slice(0, 32);
      }).finally(() => { if (this.pending.get(host) === pending) this.pending.delete(host); });
      this.pending.set(host, pending);
    }
    const addresses = await pending;
    if (this.closed) throw new Error('Browser connection closed');
    return { host, port, addresses };
  }
  close(): void { this.closed = true; this.pending.clear(); }
}
