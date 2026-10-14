import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import { ToolError } from '../tool-registry/tool.types.js';
import {
  desktopSchema,
  desktopMessageSchema,
  responseSchema,
  type DesktopForwardingContext,
  type ForwardOperation,
  type ForwardResponse,
} from './port-forwarding.protocol.js';

interface Client {
  ws: WebSocket;
  context: DesktopForwardingContext | null;
  alive: boolean;
  registrationTimer: ReturnType<typeof setTimeout>;
}
interface Pending {
  client: Client;
  resolve: (value: ForwardResponse) => void;
  reject: (error: Error) => void;
  cleanup: () => void;
}

/** Routes each request to exactly one desktop window. Never replays mutations. */
@Injectable()
export class DesktopPortForwardingGateway implements OnModuleDestroy {
  private wss: WebSocketServer | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private readonly clients = new Set<Client>();
  private readonly pending = new Map<string, Pending>();
  private detachUpgrade: (() => void) | null = null;

  attachToServer(server: Server): void {
    this.wss = new WebSocketServer({
      noServer: true,
      maxPayload: 1024 * 1024,
      perMessageDeflate: false,
    });
    const upgrade = (
      request: IncomingMessage,
      socket: Duplex,
      head: Buffer,
    ) => {
      if (
        new URL(request.url ?? '/', 'http://localhost').pathname !==
        '/desktop-port-forwarding'
      )
        return;
      // Electron uses file: (Origin null) or a loopback frontend. Reject unrelated
      // websites so they cannot impersonate the desktop using a browser socket.
      const origin = request.headers.origin;
      if (origin && origin !== 'null') {
        let allowed = false;
        try {
          allowed = ['localhost', '127.0.0.1', '[::1]'].includes(
            new URL(origin).hostname,
          );
        } catch {
          /* Invalid origin. */
        }
        if (!allowed) {
          socket.destroy();
          return;
        }
      }
      this.wss!.handleUpgrade(request, socket, head, (ws) => this.accept(ws));
    };
    server.on('upgrade', upgrade);
    this.detachUpgrade = () => server.off('upgrade', upgrade);
    this.heartbeat = setInterval(() => {
      for (const client of this.clients) {
        if (!client.alive) {
          client.ws.terminate();
          this.disconnect(client);
          continue;
        }
        client.alive = false;
        client.ws.ping();
      }
    }, 15_000);
    this.heartbeat.unref();
  }

  desktops(): DesktopForwardingContext[] {
    const unique = new Map<string, DesktopForwardingContext>();
    for (const client of this.clients) {
      if (
        client.context &&
        client.ws.readyState === WebSocket.OPEN &&
        !unique.has(client.context.desktopId)
      )
        unique.set(client.context.desktopId, client.context);
    }
    return [...unique.values()];
  }

  async request(
    operation: ForwardOperation,
    args: Record<string, unknown>,
    signal: AbortSignal,
    desktopId?: string,
  ): Promise<ForwardResponse & { desktop: DesktopForwardingContext }> {
    signal.throwIfAborted();
    const desktops = this.desktops();
    if (!desktopId && desktops.length > 1)
      throw new ToolError({
        code: 'desktop_required',
        message: 'Several desktops are connected to this backend.',
        remediation:
          'Use list_port_forwards and pass the chosen desktopId. Local ports exist on that desktop, not on the agent’s host.',
        details: { desktops },
      });
    const client = [...this.clients].find(
      (c) =>
        c.context &&
        c.ws.readyState === WebSocket.OPEN &&
        (!desktopId || c.context.desktopId === desktopId),
    );
    if (!client?.context)
      throw new ToolError({
        code: 'desktop_unavailable',
        message:
          'No matching Elevenex desktop is connected for port forwarding.',
        remediation:
          'Open the Elevenex desktop on this backend, then use list_port_forwards. Browser-only clients cannot manage desktop listeners.',
        retryable: true,
      });
    if (this.pending.size >= 100)
      throw new ToolError({
        code: 'forwarding_busy',
        message: 'Too many port-forwarding requests are pending.',
        retryable: true,
      });
    const desktop = client.context;
    const id = randomUUID();
    const result = await new Promise<ForwardResponse>((resolve, reject) => {
      const fail = (code: string, message: string) => {
        const entry = this.pending.get(id);
        if (!entry) return;
        entry.cleanup();
        // Cancel queued work on the renderer; already accepted runtime work may finish.
        if (client.ws.readyState === WebSocket.OPEN)
          client.ws.send(JSON.stringify({ type: 'cancel', id }));
        reject(
          new ToolError({
            code,
            message,
            remediation:
              'Inspect list_port_forwards before retrying; a saved or started forward may already exist.',
            retryable: true,
          }),
        );
      };
      const abort = () =>
        fail('cancelled', 'Port-forwarding request cancelled.');
      const timer = setTimeout(
        () =>
          fail(
            'desktop_timeout',
            'The desktop did not respond within 45 seconds.',
          ),
        45_000,
      );
      const cleanup = () => {
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
        this.pending.delete(id);
      };
      this.pending.set(id, { client, resolve, reject, cleanup });
      signal.addEventListener('abort', abort, { once: true });
      client.ws.send(
        JSON.stringify({ type: 'request', id, operation, args }),
        (error) => {
          if (error)
            fail('desktop_disconnected', 'The desktop connection was lost.');
        },
      );
    });
    if (result.forwards.some((forward) => forward.projectId !== args.projectId))
      throw new ToolError({
        code: 'invalid_desktop_response',
        message: 'The desktop returned forwards belonging to another project.',
      });
    return { ...result, desktop };
  }

  private accept(ws: WebSocket): void {
    const client: Client = {
      ws,
      context: null,
      alive: true,
      registrationTimer: setTimeout(
        () => ws.close(1008, 'Registration required'),
        5000,
      ),
    };
    this.clients.add(client);
    ws.on('pong', () => {
      client.alive = true;
    });
    ws.on('error', () => this.disconnect(client));
    ws.on('close', () => this.disconnect(client));
    ws.on('message', (raw) => {
      let payload: unknown;
      try {
        const value = Buffer.isBuffer(raw)
          ? raw
          : raw instanceof ArrayBuffer
            ? Buffer.from(raw)
            : Buffer.concat(raw);
        payload = JSON.parse(value.toString('utf8')) as unknown;
      } catch {
        return;
      }
      const inbound = desktopMessageSchema.safeParse(payload);
      if (!inbound.success) {
        ws.close(1008, 'Invalid desktop message');
        return;
      }
      const message = inbound.data;
      if (message?.type === 'register' && !client.context) {
        const parsed = desktopSchema.safeParse(message.context);
        if (!parsed.success) {
          ws.close(1008, 'Invalid desktop context');
          return;
        }
        client.context = parsed.data;
        clearTimeout(client.registrationTimer);
        ws.send(JSON.stringify({ type: 'ready' }));
        return;
      }
      if (message?.type !== 'response' || typeof message.id !== 'string')
        return;
      const entry = this.pending.get(message.id);
      // A reply from another window or a late reply cannot complete this call.
      if (!entry || entry.client !== client) return;
      entry.cleanup();
      if (message.error) {
        entry.reject(
          new ToolError({
            code: 'port_forward_failed',
            message: message.error,
            remediation:
              'Inspect list_port_forwards for saved definitions and errors; fix the connection or choose an unused localPort before retrying.',
          }),
        );
      } else {
        const parsed = responseSchema.safeParse(message.data);
        if (parsed.success) entry.resolve(parsed.data);
        else
          entry.reject(
            new ToolError({
              code: 'invalid_desktop_response',
              message:
                'The desktop returned an invalid port-forwarding response.',
            }),
          );
      }
    });
  }

  private disconnect(client: Client): void {
    clearTimeout(client.registrationTimer);
    this.clients.delete(client);
    for (const entry of [...this.pending.values()]) {
      if (entry.client !== client) continue;
      entry.cleanup();
      entry.reject(
        new ToolError({
          code: 'desktop_disconnected',
          message: 'The desktop disconnected during the request.',
          remediation:
            'Reconnect and inspect list_port_forwards before retrying; accepted work may have completed.',
          retryable: true,
        }),
      );
    }
  }

  onModuleDestroy(): void {
    this.detachUpgrade?.();
    if (this.heartbeat) clearInterval(this.heartbeat);
    for (const client of this.clients) {
      this.disconnect(client);
      client.ws.close(1001, 'Server shutting down');
    }
    this.wss?.close();
  }
}
