import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import {
  APP_INPUT_GUIDANCE,
  APP_VIDEO_MAX_BYTES,
  validTaskAppInput,
} from '@elevenex/shared';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import { TaskAppHost } from './task-app-host.js';
import type { TaskAppController } from './task-app.controller.js';

const streamPath = /^\/api\/task-apps\/([1-9]\d*)\/([a-f0-9-]{36})\/stream$/;
const frameLimit = APP_VIDEO_MAX_BYTES;
const headerSize = 17;

/** ACKs are issued after renderer display. A slow viewer resumes at the next IDR. */
@Injectable()
export class TaskAppGateway implements OnModuleDestroy {
  private readonly server = new WebSocketServer({
    noServer: true,
    maxPayload: 8192,
    perMessageDeflate: false,
  });
  private detach?: () => void;
  constructor(private readonly apps: TaskAppHost) {}

  attach(http: Server, controller: TaskAppController): void {
    const upgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      const path = streamPath.exec(req.url ?? '');
      if (!path) return;
      const taskId = Number(path[1]),
        runId = path[2];
      if (
        !Number.isSafeInteger(taskId) ||
        this.server.clients.size >= 64 ||
        !controller.consume(req, taskId, runId)
      ) {
        socket.destroy();
        return;
      }
      this.server.handleUpgrade(req, socket, head, (ws) =>
        this.connect(ws, taskId, runId),
      );
    };
    http.on('upgrade', upgrade);
    this.detach = () => http.off('upgrade', upgrade);
  }

  private connect(ws: WebSocket, taskId: number, runId: string): void {
    const viewer = randomUUID();
    const sent = new Map<number, number>();
    let sequence = 0,
      inFlight = 0,
      awaitingKey = true,
      alive = true;
    let displayed = false;
    let lastAck = Date.now(),
      requestId = 0,
      queueSize = 0;
    let input = Promise.resolve();
    let stop: (() => void) | undefined;
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      stop?.();
      void this.apps.releaseInput(taskId, runId, viewer).catch(() => undefined);
    };
    const heartbeat = setInterval(() => {
      if (!alive || (sent.size && Date.now() - lastAck > 15000)) {
        ws.terminate();
        return;
      }
      alive = false;
      ws.ping();
    }, 5000);
    heartbeat.unref();
    ws.on('pong', () => {
      alive = true;
    });
    ws.on('error', () => ws.terminate());
    ws.once('close', close);
    try {
      stop = this.apps.watch(taskId, runId, {
        frame: (frame) => {
          if (closed || ws.readyState !== WebSocket.OPEN) return;
          if (!frame.data.length || frame.data.length > frameLimit) {
            awaitingKey = true;
            return;
          }
          if (
            sent.size >= 8 ||
            inFlight + frame.data.length > frameLimit ||
            ws.bufferedAmount > 524288
          ) {
            awaitingKey = true;
            return false;
          }
          if (awaitingKey && !frame.key) return;
          awaitingKey = false;
          if (!sent.size) lastAck = Date.now();
          sent.set(++sequence, frame.data.length);
          inFlight += frame.data.length;
          const packet = Buffer.allocUnsafe(headerSize + frame.data.length);
          packet.writeUInt32BE(sequence);
          packet.writeUInt16BE(frame.width, 4);
          packet.writeUInt16BE(frame.height, 6);
          packet.writeUInt8(Number(frame.key), 8);
          packet.writeDoubleBE(frame.timestamp, 9);
          packet.set(frame.data, headerSize);
          ws.send(packet);
          return true;
        },
        end: (_reason, disposition) => {
          // Close codes communicate fixed UI states without forwarding host diagnostics.
          if (disposition === 'permission') ws.close(4001);
          else if (disposition === 'window-changed') ws.close(4002);
          else if (disposition === 'window-missing') ws.close(4003);
          else if (disposition === 'capture-failed') ws.close(4004);
          else ws.close(1000, 'App display ended');
        },
      });
      ws.send(JSON.stringify({ ready: true }));
    } catch {
      ws.close(1011, 'App display unavailable');
      return;
    }
    ws.on('message', (raw, binary) => {
      try {
        if (binary || !Buffer.isBuffer(raw)) throw new Error();
        const value: unknown = JSON.parse(raw.toString('utf8'));
        if (!value || typeof value !== 'object') throw new Error();
        if (
          'ack' in value &&
          typeof value.ack === 'number' &&
          sent.has(value.ack)
        ) {
          for (const [id, bytes] of sent) {
            if (id > value.ack) break;
            sent.delete(id);
            inFlight -= bytes;
          }
          displayed = true;
          lastAck = Date.now();
          return;
        }
        if (!('id' in value) || value.id !== requestId + 1 || queueSize >= 32)
          throw new Error();
        const id = ++requestId;
        const event = 'input' in value ? value.input : undefined;
        const release = 'release' in value && value.release === true;
        if (!release && !validTaskAppInput(event)) throw new Error();
        queueSize++;
        input = input
          .then(async () => {
            if (closed || ws.readyState !== WebSocket.OPEN) return;
            if (release) await this.apps.releaseInput(taskId, runId, viewer);
            else if (validTaskAppInput(event)) {
              if (!displayed || (sent.size > 0 && Date.now() - lastAck > 3000))
                throw new Error('Waiting for a displayed app frame');
              this.apps.acquireInput(taskId, runId, viewer);
              await this.apps.input(taskId, runId, viewer, event);
            }
            if (ws.readyState === WebSocket.OPEN)
              ws.send(JSON.stringify({ id, ok: true }));
          })
          .catch((error: unknown) => {
            if (ws.readyState !== WebSocket.OPEN) return;
            const message = error instanceof Error ? error.message : undefined;
            const code = Object.entries(APP_INPUT_GUIDANCE).find(([, guidance]) => guidance === message)?.[0];
            ws.send(JSON.stringify({ id, ok: false, code }));
          })
          .finally(() => {
            queueSize--;
          });
      } catch {
        ws.terminate();
      }
    });
  }

  onModuleDestroy(): void {
    this.detach?.();
    for (const ws of this.server.clients) ws.terminate();
    this.server.close();
  }
}
