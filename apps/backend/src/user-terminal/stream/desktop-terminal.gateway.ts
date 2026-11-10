import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer } from 'ws';
import { DesktopTerminalService } from '../desktop-terminal.service.js';
import { DesktopTerminalConnection } from './desktop-terminal-connection.js';

/** Browser pages cannot acquire terminal authority by probing loopback. SSH
 * uses the existing authenticated desktop tunnel and remote Unix socket. */
export function terminalStreamAuthorized(request: IncomingMessage): boolean {
  if (request.headers.origin || request.headers['sec-fetch-site']) return false;
  if (process.env.ELEVENEX_DESKTOP_SOCKET && request.socket.remoteAddress === undefined) return true;
  const expected = process.env.ELEVENEX_CODE_ACCESS;
  const supplied = request.headers['x-elevenex-code-access'];
  if (expected) return typeof supplied === 'string' && /^[a-f\d]{64}$/.test(supplied) && Buffer.byteLength(supplied) === Buffer.byteLength(expected) &&
    timingSafeEqual(Buffer.from(supplied), Buffer.from(expected));
  return ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress ?? '');
}

@Injectable()
export class DesktopTerminalGateway implements OnModuleDestroy {
  private server?: WebSocketServer;
  private detach?: () => void;
  private heartbeat?: ReturnType<typeof setInterval>;
  private readonly connections = new Set<DesktopTerminalConnection>();
  private readonly owners = new Map<number, DesktopTerminalConnection>();
  constructor(private readonly service: DesktopTerminalService) {}

  attachToServer(server: Server): void {
    const wss = this.server = new WebSocketServer({ noServer: true, maxPayload: 65536, perMessageDeflate: false });
    const upgrade = (request: IncomingMessage, socket: Duplex, head: Buffer) => {
      let url: URL;
      try { url = new URL(request.url ?? '/', 'http://localhost'); } catch { return; }
      if (url.pathname !== '/desktop-terminal/v1') return;
      if (!terminalStreamAuthorized(request) || this.connections.size >= 128) { socket.destroy(); return; }
      const task = Number(url.searchParams.get('taskId')), id = Number(url.searchParams.get('terminalId'));
      const after = Number(url.searchParams.get('after')), generation = url.searchParams.get('generation');
      if (!Number.isSafeInteger(task) || task < 1 || !Number.isSafeInteger(id) || id < 1 ||
          !Number.isSafeInteger(after) || after < 0 || (generation !== null && !/^[a-f\d-]{36}$/.test(generation))) {
        socket.destroy(); return;
      }
      wss.handleUpgrade(request, socket, head, ws => {
        let alive = true;
        ws.on('pong', () => { alive = true; });
        const connection = new DesktopTerminalConnection(ws, task, id, generation, after, this.service,
          current => this.focus(current), current => this.depart(current));
        this.connections.add(connection);
        this.health.set(connection, () => { if (!alive) { ws.terminate(); connection.dispose(); } else { alive = false; ws.ping(); } });
        void connection.start();
      });
    };
    server.on('upgrade', upgrade); this.detach = () => server.off('upgrade', upgrade);
    this.heartbeat = setInterval(() => { for (const check of this.health.values()) check(); }, 15000);
    this.heartbeat.unref();
  }
  private readonly health = new Map<DesktopTerminalConnection, () => void>();
  private focus(connection: DesktopTerminalConnection): void {
    if (this.owners.get(connection.terminalId) === connection) return;
    this.owners.get(connection.terminalId)?.control(false);
    this.owners.set(connection.terminalId, connection); connection.control(true);
  }
  private depart(connection: DesktopTerminalConnection): void {
    this.connections.delete(connection); this.health.delete(connection);
    if (this.owners.get(connection.terminalId) === connection) {
      this.owners.delete(connection.terminalId);
      const next = [...this.connections].find(candidate => candidate.terminalId === connection.terminalId);
      if (next) this.focus(next);
    }
  }
  onModuleDestroy(): void {
    this.detach?.(); clearInterval(this.heartbeat);
    for (const connection of [...this.connections]) { connection.dispose(); connection.ws.terminate(); }
    this.server?.close(); this.owners.clear();
  }
}
