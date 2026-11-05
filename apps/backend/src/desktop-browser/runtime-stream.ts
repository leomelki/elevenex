import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import type { Server, IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, WebSocket } from 'ws';
import { z } from 'zod';
import type { RuntimeBrowserController } from './runtime-browser.controller.js';
import { RuntimeBrowserService } from './runtime-browser.service.js';

const message = z
  .object({
    id: z.number().int().positive().safe(),
    method: z.enum(['command', 'layout', 'input', 'frame', 'ping', 'cancel']),
    body: z.unknown().optional(),
  })
  .strict();
const credit = z
  .object({ tabId: z.string().uuid(), after: z.number().int().min(0).safe() })
  .strict();

/** Private full-duplex transport. Existing HTTP routes remain compatible. */
@Injectable()
export class RuntimeBrowserStream implements OnModuleDestroy {
  private readonly server = new WebSocketServer({
    noServer: true,
    maxPayload: 512 * 1024,
    perMessageDeflate: false,
  });
  private readonly channels = new Map<
    number,
    { token: string; socket: WebSocket }
  >();
  private http?: Server;
  private routes?: RuntimeBrowserController;
  constructor(private readonly browsers: RuntimeBrowserService) {}
  attachToServer(server: Server, routes: RuntimeBrowserController): void {
    if (this.http) throw new Error('Browser stream transport already attached');
    this.routes = routes;
    this.http = server;
    server.on('upgrade', this.upgrade);
  }
  private readonly upgrade = (
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): void => {
    const match =
      /^\/api\/desktop-browser\/runtime\/tasks\/([1-9][0-9]*)\/stream$/.exec(
        request.url ?? '',
      );
    if (!match) return;
    // Upgrades bypass Express. Never infer UI authority from an originless TCP client.
    if (
      request.socket.remoteAddress ||
      request.socket.localAddress ||
      request.headers.origin ||
      request.headers['sec-fetch-site']
    ) {
      socket.destroy();
      return;
    }
    const taskId = Number(match[1]),
      token = request.headers['x-elevenex-browser-view'];
    if (!Number.isSafeInteger(taskId) || typeof token !== 'string') {
      socket.destroy();
      return;
    }
    try {
      this.browsers.viewer(taskId, token);
    } catch {
      socket.destroy();
      return;
    }
    const routes = this.routes;
    if (!routes) {
      socket.destroy();
      return;
    }
    const deadline = setTimeout(() => socket.destroy(), 5000);
    void routes
      .authorizeStream(request, taskId, token)
      .then(() => {
        if (this.channels.get(taskId)?.token === token) {
          socket.destroy();
          return;
        }
        if (!socket.destroyed)
          this.server.handleUpgrade(request, socket, head, (ws) =>
            this.connected(ws, request, taskId, token),
          );
      })
      .catch(() => socket.destroy())
      .finally(() => clearTimeout(deadline));
  };
  private connected(
    ws: WebSocket,
    request: IncomingMessage,
    taskId: number,
    token: string,
  ): void {
    const task = this.browsers.viewer(taskId, token);
    const routes = this.routes;
    if (!routes) {
      ws.terminate();
      return;
    }
    this.channels.get(taskId)?.socket.terminate();
    this.channels.set(taskId, { token, socket: ws });
    const pending = new Map<number, AbortController>();
    const frames = new Map<string, AbortController>();
    let lastId = 0,
      seen = Date.now(),
      stateRevision = -1;
    const send = (value: unknown): void => {
      if (ws.readyState !== WebSocket.OPEN) return;
      if (ws.bufferedAmount > 4 * 1024 * 1024) {
        ws.terminate();
        return;
      }
      ws.send(JSON.stringify(value));
    };
    const publish = (): void => {
      if (
        ws.readyState !== WebSocket.OPEN ||
        ws.bufferedAmount > 3 * 1024 * 1024
      )
        return;
      try {
        if (this.browsers.viewer(taskId, token) !== task) {
          ws.terminate();
          return;
        }
        const state = task.state();
        if (state.revision !== stateRevision) {
          stateRevision = state.revision;
          send({ event: 'state', state });
        }
      } catch {
        ws.terminate();
      }
    };
    const unsubscribe = task.subscribe(publish);
    const timer = setInterval(() => {
      if (Date.now() - seen > 9000) ws.terminate();
    }, 3000);
    timer.unref();
    ws.once('close', () => {
      if (this.channels.get(taskId)?.socket === ws)
        this.channels.delete(taskId);
      clearInterval(timer);
      unsubscribe();
      for (const controller of pending.values()) controller.abort();
      pending.clear();
      try {
        this.browsers.disconnect(taskId, token);
      } catch {
        /* Rotated leases belong to the new socket. */
      }
    });
    ws.on('error', () => ws.terminate());
    ws.on('message', (data, binary) => {
      if (binary) {
        ws.close(1008);
        return;
      }
      let parsed: z.infer<typeof message>;
      try {
        const bytes = Array.isArray(data)
          ? Buffer.concat(data)
          : Buffer.isBuffer(data)
            ? data
            : Buffer.from(data);
        parsed = message.parse(JSON.parse(bytes.toString('utf8')));
      } catch {
        ws.close(1008);
        return;
      }
      if (parsed.id <= lastId || pending.size >= 32) {
        ws.close(1008);
        return;
      }
      lastId = parsed.id;
      seen = Date.now();
      const controller = new AbortController();
      pending.set(parsed.id, controller);
      // Frame waits and navigation cannot block input/takeover. The domain still
      // validates driver generations and presentation lanes at every await.
      void (async () => {
        try {
          if (this.browsers.viewer(taskId, token) !== task) throw new Error();
          let result: unknown;
          const id = String(taskId);
          if (parsed.method === 'command')
            result = await routes.command(request, id, token, parsed.body);
          else if (parsed.method === 'layout')
            result = await routes.layout(request, id, token, parsed.body);
          else if (parsed.method === 'input')
            result = await routes.input(request, id, token, parsed.body);
          else if (parsed.method === 'ping') {
            // Recheck durable task eligibility and server suggestions at heartbeat
            // cadence; no per-frame task/database/HTTP request is necessary.
            await routes.state(request, id, token, String(stateRevision));
            result = null;
          } else if (parsed.method === 'cancel') {
            const target = z
              .number()
              .int()
              .positive()
              .safe()
              .parse(parsed.body);
            const read = pending.get(target);
            if (read && [...frames.values()].includes(read)) read.abort();
            result = null;
          } else {
            const { tabId, after } = credit.parse(parsed.body);
            if (
              (frames.has(tabId) && !frames.get(tabId)!.signal.aborted) ||
              !task.isPresented(tabId)
            )
              throw new Error();
            frames.set(tabId, controller);
            try {
              const frame = await task
                .page(tabId)
                .nextFrame(after, controller.signal, 30000);
              if (controller.signal.aborted) return;
              if (
                this.browsers.viewer(taskId, token) !== task ||
                !task.isPresented(tabId)
              )
                throw new Error();
              if (frame) {
                if (
                  frame.jpeg.length > 3000000 ||
                  ws.bufferedAmount > 1024 * 1024
                )
                  throw new Error();
                const header = Buffer.from(
                  JSON.stringify({
                    id: parsed.id,
                    sequence: frame.sequence,
                    width: frame.width,
                    height: frame.height,
                  }),
                );
                const length = Buffer.alloc(4);
                length.writeUInt32BE(header.length);
                if (ws.readyState === WebSocket.OPEN)
                  ws.send(Buffer.concat([length, header, frame.jpeg]));
                return;
              }
              result = null;
            } finally {
              if (frames.get(tabId) === controller) frames.delete(tabId);
            }
          }
          if (
            controller.signal.aborted ||
            this.browsers.viewer(taskId, token) !== task
          )
            return;
          send({ id: parsed.id, result });
          publish();
        } catch {
          if (!controller.signal.aborted) send({ id: parsed.id, failed: true });
        } finally {
          pending.delete(parsed.id);
        }
      })();
    });
    publish();
  }
  onModuleDestroy(): void {
    this.http?.off('upgrade', this.upgrade);
    for (const ws of this.server.clients) ws.terminate();
    this.server.close();
  }
}
