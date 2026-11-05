import { WebSocket } from "ws";
import type { BackendEndpoint } from "../backend-client/transport";
import { record } from "./validation";
import { RemoteBrowserVideo } from './remote-video';

interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly key?: string;
}
/** One private socket per task, owned by the window/backend scope. No replay queue. */
export class RemoteBrowserStream {
  private readonly socket: WebSocket;
  private readonly pending = new Map<number, Pending>();
  private sequence = 0;
  private stopped = false;
  readonly opened: Promise<void>;
  readonly closed: Promise<void>;
  readonly video = new RemoteBrowserVideo(body => this.request('video', body), body => this.notifyVideo(body));
  constructor(
    endpoint: BackendEndpoint,
    taskId: number,
    token: string,
    signal: AbortSignal,
    state: (value: unknown) => void,
  ) {
    const origin = new URL(endpoint.url);
    if (
      origin.protocol !== "http:" ||
      origin.hostname !== "127.0.0.1" ||
      !origin.port ||
      origin.username ||
      origin.password ||
      origin.pathname !== "/" ||
      origin.search ||
      origin.hash
    )
      throw new Error("Browser endpoint unavailable");
    origin.protocol = "ws:";
    origin.pathname = `/api/desktop-browser/runtime/tasks/${taskId}/stream`;
    this.socket = new WebSocket(origin, {
      headers: { ...endpoint.headers, "x-elevenex-browser-view": token },
      followRedirects: false,
      perMessageDeflate: false,
      maxPayload: 3100000,
      handshakeTimeout: 10000,
    });
    this.opened = new Promise((resolve, reject) => {
      this.socket.once("open", resolve);
      this.socket.once("error", () =>
        reject(new Error("Browser stream unavailable")),
      );
      this.socket.once("close", () =>
        reject(new Error("Browser stream closed")),
      );
    });
    const abort = () => this.destroy();
    this.closed = new Promise((resolve) => {
      this.socket.once("close", () => {
        this.stopped = true;
        signal.removeEventListener("abort", abort);
        for (const entry of this.pending.values()) {
          clearTimeout(entry.timer);
          entry.reject(
            new Error(
              "Browser stream interrupted; outcome may be unknown. Inspect state before retrying.",
            ),
          );
        }
        this.pending.clear();
        this.video.destroy();
        resolve();
      });
    });
    this.socket.on("error", () => this.destroy());
    this.socket.on("message", (data, binary) => {
      try {
        const bytes = Array.isArray(data)
          ? Buffer.concat(data)
          : Buffer.isBuffer(data)
            ? data
            : Buffer.from(data);
        let value: Record<string, unknown>;
        if (binary) {
          if (bytes.length < 5) throw new Error();
          const length = bytes.readUInt32BE();
          if (
            length > 1024 ||
            length + 4 >= bytes.length ||
            bytes.length - length - 4 > 3000000
          )
            throw new Error();
          value = record(
            JSON.parse(bytes.subarray(4, 4 + length).toString("utf8")),
          );
          if (
            !Number.isSafeInteger(value["sequence"]) ||
            Number(value["sequence"]) < 1 ||
            !Number.isInteger(value["width"]) ||
            Number(value["width"]) < 1 ||
            Number(value["width"]) > 2560 ||
            !Number.isInteger(value["height"]) ||
            Number(value["height"]) < 1 ||
            Number(value["height"]) > 1600
          )
            throw new Error();
          const payload = new Uint8Array(bytes.buffer, bytes.byteOffset + 4 + length, bytes.length - 4 - length);
          if (value['event'] === 'video') { this.video.receive(value, payload); return; }
          value = {
            id: value["id"],
            result: {
              sequence: value["sequence"],
              width: value["width"],
              height: value["height"],
              jpeg: new Uint8Array(
                bytes.buffer,
                bytes.byteOffset + 4 + length,
                bytes.length - 4 - length,
              ),
            },
          };
        } else {
          if (bytes.length > 512 * 1024) throw new Error();
          value = record(JSON.parse(bytes.toString("utf8")));
        }
        if (value["event"] === "state") {
          state(value["state"]);
          return;
        }
        if (value['event'] === 'video-ended') { this.video.end(value['subscription']); return; }
        if (!Number.isSafeInteger(value["id"]) || Number(value["id"]) < 1)
          throw new Error();
        const entry = this.pending.get(Number(value["id"]));
        if (!entry) return; // Cancelled reads can race a frame already on the wire.
        this.pending.delete(Number(value["id"]));
        clearTimeout(entry.timer);
        if (value["failed"] === true)
          entry.reject(
            new Error(
              "Browser action interrupted. Inspect state before retrying.",
            ),
          );
        else entry.resolve(value["result"]);
      } catch {
        this.destroy();
      }
    });
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) this.destroy();
  }
  private notifyVideo(body: unknown): void {
    if (this.stopped || this.socket.readyState !== WebSocket.OPEN || this.socket.bufferedAmount > 512 * 1024)
      throw new Error('Browser stream unavailable');
    const data = JSON.stringify({ id: ++this.sequence, method: 'video', body });
    if (Buffer.byteLength(data) > 1024) throw new Error('Invalid video receipt');
    this.socket.send(data, error => { if (error) this.destroy(); });
  }
  request(
    method: "command" | "layout" | "input" | "frame" | "ping" | 'video',
    body?: unknown,
    timeout = 10000,
    key?: string,
  ): Promise<unknown> {
    if (
      this.stopped ||
      this.socket.readyState !== WebSocket.OPEN ||
      this.pending.size >= 32 ||
      this.socket.bufferedAmount > 512 * 1024
    )
      return Promise.reject(new Error("Browser stream unavailable"));
    const id = ++this.sequence;
    const data = JSON.stringify({ id, method, body });
    if (Buffer.byteLength(data) > 512 * 1024)
      return Promise.reject(new Error("Browser request too large"));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.destroy();
      }, timeout);
      this.pending.set(id, { resolve, reject, timer, ...(key ? { key } : {}) });
      this.socket.send(data);
    });
  }
  cancel(key: string): void {
    this.video.cancel(key);
    for (const [id, entry] of this.pending)
      if (entry.key === key) {
        this.pending.delete(id);
        clearTimeout(entry.timer);
        entry.resolve(null);
        if (this.socket.readyState === WebSocket.OPEN)
          this.socket.send(
            JSON.stringify({ id: ++this.sequence, method: "cancel", body: id }),
          );
      }
  }
  destroy(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.socket.terminate();
  }
}
