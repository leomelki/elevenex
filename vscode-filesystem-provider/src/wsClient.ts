import {
  FileChangeType,
  FileChangeEvent,
  EventEmitter,
  Disposable,
} from "vscode";
import { toWorkspaceVfsUri } from "./workspaceUri";

/** One socket per editor. Connect and retry budgets also cover sockets stuck CONNECTING. */
export class WebSocketClient implements Disposable {
  private ws: WebSocket | null = null;
  private stopped = true;
  private attempts = 0;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private connectTimer?: ReturnType<typeof setTimeout>;
  private fileChanges = new EventEmitter<FileChangeEvent[]>();
  private status = new EventEmitter<"connected" | "error">();
  private rawChanges = new EventEmitter<
    Array<{ event: string; path: string }>
  >();
  readonly onDidChangeFile = this.fileChanges.event;
  readonly onStatus = this.status.event;
  readonly onRawChanges = this.rawChanges.event;

  constructor(
    private worktreePath: string,
    private baseUrl = `${globalThis.location?.protocol === "https:" ? "wss:" : "ws:"}//${globalThis.location?.host ?? "localhost:3000"}`,
  ) {}

  connect(): void {
    if (this.ws || this.retryTimer) return;
    this.stopped = false;
    let socket: WebSocket;
    try {
      socket = new WebSocket(
        `${this.baseUrl}/file-changes?worktreePath=${encodeURIComponent(this.worktreePath)}`,
      );
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = socket;
    this.connectTimer = setTimeout(() => this.closed(socket), 4000);
    socket.onopen = () => {
      if (this.ws !== socket || this.stopped) return;
      clearTimeout(this.connectTimer);
      // Do not reset attempts on open: an accept/close loop must also exhaust.
      this.fileChanges.fire([
        {
          type: FileChangeType.Changed,
          uri: toWorkspaceVfsUri(this.worktreePath),
        },
      ]);
      this.status.fire("connected");
    };
    socket.onmessage = (event) => {
      if (this.ws !== socket || this.stopped) return;
      try {
        const parsed = JSON.parse(event.data);
        const payload = Array.isArray(parsed) ? parsed : [parsed];
        const events: FileChangeEvent[] = [];
        const raw: Array<{ event: string; path: string }> = [];
        for (const item of payload.slice(0, 1024)) {
          if (item.worktreePath !== this.worktreePath) continue;
          if (item.type === "resync") {
            events.push({
              type: FileChangeType.Changed,
              uri: toWorkspaceVfsUri(this.worktreePath),
            });
            raw.push({ event: "resync", path: "" });
            continue;
          }
          const kind = item.event || item.type;
          if (kind === "git") {
            raw.push({ event: "git", path: "" });
            continue;
          }
          if (
            !["add", "change", "unlink", "addDir", "unlinkDir"].includes(
              kind,
            ) ||
            typeof item.path !== "string"
          )
            continue;
          events.push({
            type: kind.startsWith("unlink")
              ? FileChangeType.Deleted
              : kind.startsWith("add")
                ? FileChangeType.Created
                : FileChangeType.Changed,
            uri: toWorkspaceVfsUri(this.worktreePath, item.path),
          });
          raw.push({ event: kind, path: item.path });
        }
        if (events.length) this.fileChanges.fire(events);
        if (raw.length) this.rawChanges.fire(raw);
      } catch (error) {
        console.error("Invalid file-change payload", error);
      }
    };
    socket.onerror = () => this.closed(socket);
    socket.onclose = () => this.closed(socket);
  }

  private closed(socket: WebSocket): void {
    if (this.ws !== socket) return;
    clearTimeout(this.connectTimer);
    socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null;
    this.ws = null;
    socket.close();
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.retryTimer) return;
    if (this.attempts >= 4) {
      this.status.fire("error");
      return;
    }
    const delay = 500 * 2 ** this.attempts++;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      this.connect();
    }, delay);
  }

  retry(): void {
    this.disconnect();
    this.attempts = 0;
    this.connect();
  }
  disconnect(): void {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    clearTimeout(this.connectTimer);
    this.retryTimer = undefined;
    const socket = this.ws;
    this.ws = null;
    if (socket) {
      socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null;
      socket.close();
    }
  }
  isConnected(): boolean {
    return this.ws?.readyState === 1;
  }
  dispose(): void {
    this.disconnect();
    this.fileChanges.dispose();
    this.status.dispose();
    this.rawChanges.dispose();
  }
}
