import { net, type Session } from 'electron';
import { isIP } from 'node:net';
import { browserSocks, publicBrowserAddress } from '@elevenex/browser-network';
import { browserUrl, loopback } from './validation';
export interface BrowserForwardLease { readonly port: number; close(): Promise<void> }
/** Task networking keeps logical origins intact, including CORS, cookies, TLS and WebSockets. */
export class TaskBrowserNetwork {
  private readonly forwards = new Map<number, Promise<BrowserForwardLease>>();
  private proxy?: ReturnType<typeof browserSocks>;
  private closed = false;
  private readonly lookups = new Map<string, Promise<string>>();
  constructor(readonly remote: boolean, private readonly forward: (port: number) => Promise<BrowserForwardLease>, private readonly current: () => boolean, private readonly active: () => boolean, private readonly applicationPort: (port: number) => boolean = () => false) {}
  async outside(value: string): Promise<string> {
    const url = new URL(browserUrl(value));
    if (!loopback(url)) return url.href;
    const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
    const lease = await this.service(port, true);
    if (!this.remote) return url.href;
    url.hostname = url.hostname === 'localhost' || url.hostname.endsWith('.localhost') ? url.hostname : '127.0.0.1';
    url.port = String(lease.port); return url.href;
  }
  async configure(session: Session): Promise<void> {
    this.assertCurrent();
    this.proxy ??= browserSocks(async (host, port) => {
      this.assertCurrent();
      if (!this.active()) throw new Error('This task is not active');
      if (this.applicationPort(port)) throw new Error('Application control ports are not browser destinations');
      const authority = host.includes(':') ? `[${host}]` : host;
      if (!loopback(new URL(`http://${authority}:${port}`))) return { host: await this.publicHost(host), port };
      const lease = await this.service(port, false);
      return { host: '127.0.0.1', port: lease.port };
    });
    const pending = this.proxy;
    let proxy: Awaited<ReturnType<typeof browserSocks>>;
    try { proxy = await pending; } catch (error) { if (this.proxy === pending) this.proxy = undefined; throw error; }
    if (this.closed || !this.current()) { await proxy.close(); throw new Error('Task browser transport changed'); }
    await session.setProxy({ mode: 'fixed_servers', proxyRules: `socks5://127.0.0.1:${proxy.port}`, proxyBypassRules: '<-loopback>' });
    // Chromium may still resolve against its previous configuration after setProxy.
    // Reused durable profiles must activate the task proxy before any navigation.
    await session.forceReloadProxyConfig();
    const route = await session.resolveProxy('http://localhost:40001/');
    if (route.trim() !== `SOCKS5 127.0.0.1:${proxy.port}`) throw new Error('This Chromium runtime cannot isolate remote loopback routing');
    this.assertCurrent();
  }
  authorizePorts(ports: readonly number[]): void { void ports; /* Discovery supplies UI suggestions, never network authority. */ }
  allowed(value: string): boolean {
    if (this.closed || !this.current() || !this.active()) return false;
    const url = new URL(value);
    const destination = Number(url.port || (url.protocol === 'https:' || url.protocol === 'wss:' ? 443 : 80));
    if (this.applicationPort(destination)) return false;
    if (!loopback(url)) return true;
    const port = Number(url.port || (url.protocol === 'https:' || url.protocol === 'wss:' ? 443 : 80));
    return this.forwards.has(port);
  }
  private async service(port: number, create: boolean): Promise<BrowserForwardLease> {
    this.assertCurrent();
    if (this.applicationPort(port)) throw new Error('Application control ports are not browser destinations');
    let pending = this.forwards.get(port);
    if (!pending) {
      if (!create) throw new Error('Open this task server explicitly before connecting to it');
      if (this.forwards.size >= 12) throw new Error('Task browser forwarding limit reached');
      pending = this.remote ? this.forward(port) : Promise.resolve({ port, close: async () => undefined }); this.forwards.set(port, pending);
      void pending.catch(() => { if (this.forwards.get(port) === pending) this.forwards.delete(port); });
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<never>((_yes, no) => { timer = setTimeout(() => no(new Error('The task server forward timed out. Retry explicitly.')), 5000); });
    try { const lease = await Promise.race([pending, expired]); this.assertCurrent(); return lease; }
    finally { clearTimeout(timer); }
  }
  private publicHost(host: string): Promise<string> {
    if (isIP(host)) return publicBrowserAddress(host) ? Promise.resolve(host) : Promise.reject(new Error('Private network destinations require a task server forward'));
    const existing = this.lookups.get(host); if (existing) return existing;
    if (this.lookups.size >= 32) return Promise.reject(new Error('Task browser name lookup limit reached'));
    // Chromium performs DNS off the main Node thread pool. Connect to the checked
    // address, rather than resolving again, to prevent a rebinding race.
    const pending = net.resolveHost(host).then(result => {
      this.assertCurrent();
      const addresses = result.endpoints.slice(0, 32).filter(endpoint => publicBrowserAddress(endpoint.address));
      const chosen = addresses.find(endpoint => endpoint.family === 'ipv4') ?? addresses[0];
      if (!chosen) throw new Error('Private network destinations require a task server forward');
      return chosen.address;
    }).finally(() => { if (this.lookups.get(host) === pending) this.lookups.delete(host); });
    this.lookups.set(host, pending); return pending;
  }
  private assertCurrent(): void { if (this.closed || !this.current()) throw new Error('Task browser transport changed'); }
  pause(): void { if (this.proxy) void this.proxy.then(proxy => proxy.disconnect()).catch(() => undefined); }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.proxy) void this.proxy.then(proxy => proxy.close()).catch(() => undefined);
    for (const pending of this.forwards.values()) void pending.then(lease => lease.close()).catch(() => undefined);
    this.forwards.clear(); this.lookups.clear();
  }
}
