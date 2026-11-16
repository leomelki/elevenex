import {
  browserSocks,
  publicBrowserAddress,
  browserLoopbackHost,
} from '@elevenex/browser-network';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { BrowserSocketTarget } from '@elevenex/browser-network';

export function runtimeUrl(value: unknown): URL {
  if (typeof value !== 'string' || value.length > 2048 || /\s/.test(value))
    throw new Error('Enter an HTTP or HTTPS address');
  const url = new URL(value);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw new Error(
      'Only HTTP and HTTPS addresses without credentials are supported',
    );
  return url;
}
/** The browser's task-local origin is preserved; no page can fall through to other server services. */
export class RuntimeBrowserNetwork {
  private readonly ports = new Set<number>();
  private lookups = 0;
  private readonly pending = new Map<string, Promise<BrowserSocketTarget>>();
  private proxy?: ReturnType<typeof browserSocks>;
  private closed = false;
  constructor(
    private readonly active: () => boolean,
    private readonly applicationPort: (port: number) => boolean = () => false,
  ) {}
  authorize(url: URL): void {
    if (browserLoopbackHost(url.hostname.replace(/\.$/, ''))) {
      if (this.ports.size >= 32 && !this.ports.has(Number(url.port)))
        throw new Error('Task server limit reached');
      this.ports.add(
        Number(url.port || (url.protocol === 'https:' ? 443 : 80)),
      );
    }
  }
  setPorts(ports: readonly number[]): void {
    for (const port of ports.slice(0, 32))
      if (this.ports.size < 32) this.ports.add(port);
  }
  async start(): Promise<string> {
    this.proxy ??= browserSocks(async (host, port) => {
      if (this.closed || !this.active())
        throw new Error('Browser task is not active');
      if (this.applicationPort(port))
        throw new Error(
          'Application control ports are not browser destinations',
        );
      host = host.toLowerCase().replace(/\.$/, '');
      if (browserLoopbackHost(host)) {
        if (!this.ports.has(port))
          throw new Error('Task port is not authorized');
        if (host === 'localhost' || host.endsWith('.localhost'))
          return { host, port, addresses: [{ address: '127.0.0.1', family: 4 }, { address: '::1', family: 6 }] };
        const canonical = host.includes(':') ? new URL(`http://[${host}]/`).hostname : host;
        return { host: canonical === '[::]' ? '::1' : host === '0.0.0.0' ? '127.0.0.1' : host, port };
      }
      if (isIP(host)) {
        if (!publicBrowserAddress(host)) throw new Error('Private browser destination');
        return { host, port };
      }
      let pending = this.pending.get(host);
      if (!pending) {
        if (this.lookups >= 32) throw new Error('Browser DNS limit reached');
        this.lookups++;
        // Honor the host's resolver/hosts file, then connect only to the checked
        // answers. A slow/broken family must not block a healthy destination.
        pending = lookup(host, { all: true, verbatim: true })
          .then((addresses) => {
            if (
              !addresses.length ||
              addresses.some(({ address }) => !publicBrowserAddress(address))
            )
              throw new Error('Private browser destination');
            return { host, port: 0, addresses: addresses.slice(0, 32) };
          })
          .finally(() => {
            this.lookups--;
            this.pending.delete(host);
          });
        this.pending.set(host, pending);
      }
      return { ...await pending, port };
    });
    const proxy = await this.proxy;
    if (this.closed) {
      await proxy.close();
      throw new Error('Browser network closed');
    }
    return 'socks5://127.0.0.1:' + proxy.port;
  }
  pause(): void {
    if (this.proxy)
      void this.proxy
        .then((proxy) => proxy.disconnect())
        .catch(() => undefined);
  }
  close(): void {
    this.closed = true;
    if (this.proxy)
      void this.proxy.then((proxy) => proxy.close()).catch(() => undefined);
    this.pending.clear();
  }
}
