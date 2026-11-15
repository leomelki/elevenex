/** A persistent backend sees one stable socket; forwarded agents remain leased. */
import { chmod, rename, rm, writeFile } from 'node:fs/promises';
import { createServer, Socket } from 'node:net';

interface AgentLease { readonly path: string; readonly expires: number }
interface AgentClient { readonly socket: Socket; upstream?: Socket; leaseId?: string }

export class ForwardedAgentProxy {
  private readonly leases = new Map<string, AgentLease>();
  private readonly clients = new Set<AgentClient>();
  private sweep: ReturnType<typeof setInterval> | undefined;
  private published: boolean | undefined;
  private pending: boolean | undefined;
  private publishing?: Promise<void>;
  private disposed = false;
  private disposal?: Promise<void>;
  private readonly server = createServer({ pauseOnConnect: true, allowHalfOpen: true }, socket => this.accept(socket));
  constructor(private readonly path: string, private readonly now = Date.now) {}

  async listen(): Promise<void> {
    await rm(this.path, { force: true });
    await new Promise<void>((resolve, reject) => { this.server.once('error', reject); this.server.listen(this.path, resolve); });
    await chmod(this.path, 0o600);
    this.publish();
    await this.flush();
    this.sweep = setInterval(() => {
      for (const [id, lease] of this.leases) if (lease.expires <= this.now()) this.renew(id, null);
    }, 5000);
  }

  renew(id: string, path: string | null): void {
    if (this.disposed) return;
    if (path !== null && (this.leases.has(id) || this.leases.size < 64)) this.leases.set(id, { path, expires: this.now() + 25_000 });
    else {
      this.leases.delete(id);
      for (const client of this.clients) if (client.leaseId === id) client.socket.destroy();
    }
    this.publish();
  }

  /** Health replies wait for transitions, never for unchanged heartbeat writes. */
  async flush(): Promise<void> { await this.publishing; }

  private publish(): void {
    const now = this.now();
    let available = false;
    for (const lease of this.leases.values()) if (lease.expires > now) { available = true; break; }
    if (available === this.published && this.pending === undefined) return;
    this.pending = available;
    if (this.publishing) return;
    this.publishing = (async () => {
      while (this.pending !== undefined) {
        const next = this.pending;
        this.pending = undefined;
        if (next === this.published) continue;
        // The private daemon owns this file and its backend's lifetime. Publish
        // presence only: renewing a lease never causes disk I/O or key probes.
        const temporary = this.path + '.state.tmp';
        try {
          await writeFile(temporary, next ? '1' : '0', { mode: 0o600 });
          await rename(temporary, this.path + '.state');
          this.published = next;
        } finally { await rm(temporary, { force: true }); }
      }
    })().finally(() => { this.publishing = undefined; });
    // Socket clients still fail closed if publication fails. flush surfaces the
    // failure to startup/health; keep background expiry failures handled too.
    void this.publishing.catch(() => undefined);
  }

  dispose(): Promise<void> { return this.disposal ??= this.close(); }

  private async close(): Promise<void> {
    this.disposed = true;
    if (this.sweep) clearInterval(this.sweep);
    this.leases.clear(); for (const client of this.clients) client.socket.destroy();
    await new Promise<void>(resolve => this.server.close(() => resolve()));
    await this.flush().catch(() => undefined);
    await rm(this.path + '.state', { force: true });
  }

  private accept(socket: Socket): void {
    if (this.clients.size >= 64) { socket.destroy(); return; }
    const client: AgentClient = { socket }; this.clients.add(client);
    const deadline = setTimeout(() => socket.destroy(), 5000);
    socket.on('error', () => socket.destroy());
    socket.once('close', () => { clearTimeout(deadline); this.clients.delete(client); client.upstream?.destroy(); });
    const candidates = [...this.leases.entries()].filter(([, lease]) => lease.expires > this.now()).sort((a, b) => b[1].expires - a[1].expires);
    const next = () => {
      if (socket.destroyed) return;
      const candidate = candidates.shift();
      if (!candidate) { socket.destroy(); return; }
      const [id, lease] = candidate;
      if (lease.expires <= this.now() || this.leases.get(id) !== lease) { next(); return; }
      const upstream = new Socket({ allowHalfOpen: true }); client.upstream = upstream; client.leaseId = id;
      let connected = false;
      upstream.setTimeout(2000, () => upstream.destroy(new Error('Agent connection timed out')));
      upstream.once('error', () => { if (connected) socket.destroy(); else next(); });
      upstream.once('connect', () => {
        connected = true; clearTimeout(deadline);
        // No request bytes were consumed until connect succeeded. Falling back
        // between dead agent sockets never replays a signing/authentication call.
        upstream.setTimeout(120_000, () => socket.destroy()); socket.setTimeout(120_000, () => socket.destroy());
        upstream.once('close', () => socket.destroy()); socket.pipe(upstream); upstream.pipe(socket); socket.resume();
      });
      upstream.connect(lease.path);
    };
    next();
  }
}
