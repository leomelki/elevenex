/** A persistent backend sees one stable socket; forwarded agents remain leased. */
import { chmod, rm } from 'node:fs/promises';
import { createServer, Socket } from 'node:net';

interface AgentLease { readonly path: string; readonly expires: number }
interface AgentClient { readonly socket: Socket; upstream?: Socket; leaseId?: string }

export class ForwardedAgentProxy {
  private readonly leases = new Map<string, AgentLease>();
  private readonly clients = new Set<AgentClient>();
  private sweep: ReturnType<typeof setInterval> | undefined;
  private readonly server = createServer({ pauseOnConnect: true, allowHalfOpen: true }, socket => this.accept(socket));
  constructor(private readonly path: string, private readonly now = Date.now) {}

  async listen(): Promise<void> {
    await rm(this.path, { force: true });
    await new Promise<void>((resolve, reject) => { this.server.once('error', reject); this.server.listen(this.path, resolve); });
    await chmod(this.path, 0o600);
    this.sweep = setInterval(() => {
      for (const [id, lease] of this.leases) if (lease.expires <= this.now()) this.renew(id, null);
    }, 5000);
  }

  renew(id: string, path: string | null): void {
    if (path !== null && (this.leases.has(id) || this.leases.size < 64)) this.leases.set(id, { path, expires: this.now() + 25_000 });
    else {
      this.leases.delete(id);
      for (const client of this.clients) if (client.leaseId === id) client.socket.destroy();
    }
  }

  async dispose(): Promise<void> {
    if (this.sweep) clearInterval(this.sweep);
    this.leases.clear(); for (const client of this.clients) client.socket.destroy();
    await new Promise<void>(resolve => this.server.close(() => resolve()));
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
