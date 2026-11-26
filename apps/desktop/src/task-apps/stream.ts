import { WebSocket } from "ws";
import {
  APP_INPUT_GUIDANCE,
  APP_SHARING_STOPPED,
  APP_VIDEO_MAX_AXIS,
  APP_VIDEO_MAX_PIXELS,
  APP_VIDEO_MAX_BYTES,
  type TaskAppFrame,
  type TaskAppInput,
} from "@elevenex/shared";
import {
  backendOperationUrl,
  invalidResponse,
  type BackendEndpoint,
} from "../backend-client/transport";
import { taskPath } from "./validation";

export interface AppPresentation {
  readonly taskId: number;
  readonly runId: string;
  readonly watchId: string;
  readonly scopeId: string;
}

/** One scoped viewer. The host's eight-frame window ends at renderer acknowledgement. */
export class TaskAppStream {
  private readonly ws: WebSocket;
  private lastFrame = 0;
  private lastAck = 0;
  private request = 0;
  private readonly pending = new Map<
    number,
    { done(ok: boolean, code?: keyof typeof APP_INPUT_GUIDANCE): void }
  >();
  readonly ready: Promise<void>;
  private opened = false;

  constructor(
    endpoint: BackendEndpoint,
    token: string,
    readonly target: AppPresentation,
    signal: AbortSignal,
    deliver: (frame: TaskAppFrame) => void,
    ended: (reason: string) => void,
  ) {
    const url = backendOperationUrl(
      endpoint,
      taskPath(target.taskId, target.runId) + "/stream",
    );
    url.protocol = "ws:";
    this.ws = new WebSocket(url, {
      headers: { ...endpoint.headers, "x-elevenex-app-view": token },
      perMessageDeflate: false,
      followRedirects: false,
      maxPayload: APP_VIDEO_MAX_BYTES + 17,
      handshakeTimeout: 7000,
    });
    this.ready = new Promise((resolve, reject) => {
      const deadline = setTimeout(() => this.close(), 10000);
      const abort = () => this.close();
      signal.addEventListener("abort", abort, { once: true });
      this.ws.once("close", (code) => {
        clearTimeout(deadline);
        signal.removeEventListener("abort", abort);
        reject(new Error("App display unavailable"));
        for (const entry of this.pending.values()) entry.done(false);
        this.pending.clear();
        const reason =
          code === 4001
            ? "The host screen is locked or capture permission changed."
            : code === 4002
              ? "App window changed. Reopen the stream."
              : code === 4003
                ? "No owned app window is visible on the host."
                : code === 4004
                  ? "The host could not capture or encode the app window."
                  : code === 4005
                    ? APP_SHARING_STOPPED
                    : "App stream disconnected";
        ended(reason);
      });
      this.ws.on("error", abort);
      this.ws.on("message", (raw, binary) => {
        try {
          if (!Buffer.isBuffer(raw) || signal.aborted) throw invalidResponse();
          if (!binary) {
            if (raw.length > 512) throw invalidResponse();
            const value: unknown = JSON.parse(raw.toString("utf8"));
            if (!value || typeof value !== "object") throw invalidResponse();
            if ("ready" in value && value.ready === true && !this.opened) {
              this.opened = true;
              clearTimeout(deadline);
              resolve();
              return;
            }
            if (
              !(
                "id" in value &&
                typeof value.id === "number" &&
                "ok" in value &&
                typeof value.ok === "boolean"
              )
            )
              throw invalidResponse();
            const pending = this.pending.get(value.id);
            if (!pending) throw invalidResponse();
            this.pending.delete(value.id);
            const code =
              "code" in value &&
              (value.code === "permission" || value.code === "foreground" || value.code === "window")
                ? value.code
                : undefined;
            pending.done(value.ok, code);
            return;
          }
          if (
            !this.opened ||
            raw.length <= 17 ||
            ++this.lastFrame !== raw.readUInt32BE() ||
            this.lastFrame - this.lastAck > 8
          )
            throw invalidResponse();
          const width = raw.readUInt16BE(4),
            height = raw.readUInt16BE(6),
            flag = raw.readUInt8(8),
            timestamp = raw.readDoubleBE(9);
          if (
            width < 16 ||
            width > APP_VIDEO_MAX_AXIS ||
            height < 16 ||
            height > APP_VIDEO_MAX_AXIS ||
            width * height > APP_VIDEO_MAX_PIXELS ||
            flag > 1 ||
            (this.lastFrame === 1 && !flag) ||
            !Number.isSafeInteger(timestamp) ||
            timestamp < 0
          )
            throw invalidResponse();
          // Never forward the WS packet header or expose unrelated bytes from pooled Buffers.
          deliver({
            ...target,
            sequence: this.lastFrame,
            codec: "avc1.42E02A",
            width,
            height,
            timestamp,
            key: flag === 1,
            data: Uint8Array.from(raw.subarray(17)),
          });
        } catch {
          abort();
        }
      });
      if (signal.aborted) abort();
    });
  }

  acknowledge(sequence: number): void {
    if (
      !Number.isSafeInteger(sequence) ||
      sequence < 1 ||
      sequence > this.lastFrame
    )
      throw new Error("Invalid app frame receipt");
    if (sequence <= this.lastAck || this.ws.readyState !== WebSocket.OPEN)
      return;
    this.lastAck = sequence;
    this.ws.send(JSON.stringify({ ack: sequence }));
  }

  control(input?: TaskAppInput): Promise<void> {
    if (
      !this.opened ||
      this.ws.readyState !== WebSocket.OPEN ||
      this.pending.size >= 32
    )
      return Promise.reject(new Error("App control unavailable"));
    if (input && !this.lastAck)
      return Promise.reject(new Error("Waiting for the first app frame"));
    const id = ++this.request;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.close(), 10000);
      this.pending.set(id, {
        done(ok, code) {
          clearTimeout(timer);
          if (ok) resolve();
          else
            reject(
              new Error(
                code
                  ? APP_INPUT_GUIDANCE[code]
                  : "App control interrupted. Select the app to take control.",
              ),
            );
        },
      });
      this.ws.send(
        JSON.stringify(input ? { id, input } : { id, release: true }),
        (error) => {
          if (error) this.close();
        },
      );
    });
  }

  async release(): Promise<void> {
    // Blur and teardown can race. A closed connection already revokes the host lease.
    // If a live release fails, closing the connection delegates key-up to host cleanup.
    try { await this.control(); }
    catch { this.close(); }
  }

  close(): void {
    if (
      this.ws.readyState === WebSocket.OPEN ||
      this.ws.readyState === WebSocket.CONNECTING
    )
      this.ws.terminate();
  }
}
