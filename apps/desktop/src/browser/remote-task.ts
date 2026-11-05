import { RemoteBrowserStream } from './remote-stream';
import type { MachineBrowserHost } from "./host";
import { remoteBrowserState } from "./remote-state";
import {
  RemoteBrowserPresentation,
  type RemotePresentationHost,
} from "./remote-presentation";
import { TaskBrowserNetwork } from "./network";
import type { RemoteManager } from "../remote/manager";
import { randomUUID } from "node:crypto";
import {
  clipboard,
  screen,
  nativeTheme,
  shell,
  type BrowserWindow,
} from "electron";
import type {
  TaskBrowserCommand,
  TaskBrowserFrame,
  TaskBrowserLayout,
  TaskBrowserState,
  TaskBrowserStreamInput,
  TaskBrowserSurface,
} from "@elevenex/shared";
import type { BackendClient } from "../backend-client/client";
import type { BackendEndpoint } from "../backend-client/transport";
import { requestBackendJson } from "../backend-client/transport";
import { browserId, browserUrl, record } from "./validation";

class RemoteBrowserConflict extends Error {}
/** One task connection and state owner; displays never own another task or viewer lease. */
export class RemoteTaskBrowser implements MachineBrowserHost {
  readonly engine = "machine";
  private readonly detached = new Map<string, RemoteBrowserPresentation>();
  private readonly panel: RemoteBrowserPresentation;
  private readonly layoutSequences = new Map<string, number>();
  private readonly ownerId: number;
  private readonly network: TaskBrowserNetwork;
  private readonly clientId = randomUUID();
  private state?: TaskBrowserState;
  private token = "";
  private stream?: RemoteBrowserStream;
  private lastHeartbeat = 0;
  private revision = 0;
  private serverRevision = -1;
  private connectionRevision = 0;
  private disposed = false;
  private reconnect = true;
  private connecting?: Promise<void>;
  private disconnecting?: Promise<void>;
  private timer?: ReturnType<typeof setTimeout>;
  private connection: NonNullable<TaskBrowserState["connection"]> = {
    phase: "idle",
  };
  get closed(): boolean {
    return this.disposed;
  }
  constructor(
    readonly scopeId: string,
    readonly taskId: number,
    window: BrowserWindow,
    private readonly client: BackendClient,
    private readonly changed: (state: TaskBrowserState) => void,
    private readonly selected: () => boolean,
    private readonly surfacesChanged: () => void,
    private readonly deliver: (frame: TaskBrowserFrame) => void,
    remote: RemoteManager,
    remoteNetwork = true,
  ) {
    this.ownerId = window.webContents.id;
    this.network = new TaskBrowserNetwork(
      remoteNetwork,
      (port) => remote.browserForward(this.ownerId, port),
      () => !this.disposed && client.state(this.ownerId).scope?.id === scopeId,
      selected,
    );
    this.panel = this.createPresentation(window);
  }
  private createPresentation(
    window: BrowserWindow,
    tabId?: string,
  ): RemoteBrowserPresentation {
    const host: RemotePresentationHost = {
      scopeId: this.scopeId,
      taskId: this.taskId,
      state: () => this.state,
      ready: () =>
        !this.disposed &&
        !this.reconnect &&
        this.selected() &&
        (tabId !== undefined || !this.detached.has(this.state?.active ?? "")),
      changed: () => this.emit(),
      layout: async (tab, box) => {
        const revision = this.connectionRevision;
        const key = this.state?.layoutLanes ? (tab ?? "panel") : "legacy",
          sequence = (this.layoutSequences.get(key) ?? 0) + 1;
        this.layoutSequences.set(key, sequence);
        try {
          this.accept(
            await this.request("layout", {
              ...box,
              ...(tab ? { tabId: tab } : {}),
              sequence,
            }),
          );
        } catch (error) {
          if (revision === this.connectionRevision) throw error;
        }
      },
      frame: (tab, after, requestId) => this.readFrame(tab, after, requestId),
      cancel: (requestId) => {
        this.stream?.cancel(requestId);
        this.client.cancel(this.ownerId, this.scopeId, requestId);
      },
      rejectVideo: requestId => this.stream?.video.fallback(requestId),
      deliver: this.deliver,
      failed: (error) => this.fail(error),
    };
    return new RemoteBrowserPresentation(
      host,
      {
        visible: () =>
          !window.isDestroyed() && window.isVisible() && !window.isMinimized(),
        zoom: () => window.webContents.getZoomFactor(),
        pixelRatio: () =>
          Math.min(
            2,
            screen.getDisplayMatching(window.getBounds()).scaleFactor,
          ),
        colorScheme: () => (nativeTheme.shouldUseDarkColors ? "dark" : "light"),
      },
      tabId,
    );
  }
  private emit(): void {
    if (this.state && !this.disposed) {
      this.revision++;
      this.changed(this.snapshot());
      this.surfacesChanged();
    }
  }
  hasDetached(): boolean {
    return this.detached.size > 0;
  }
  detachTab(tabId: string, window: BrowserWindow): void {
    if (!this.state?.canDetach)
      throw new Error("Update this machine to open browser tabs in windows.");
    if (
      !this.state.tabs.some((tab) => tab.id === tabId) ||
      this.detached.has(tabId)
    )
      throw new Error("Browser tab changed");
    // Hide the panel before transferring this tab's presentation authority.
    if (this.state.active === tabId) this.panel.hide();
    const view = this.createPresentation(window, tabId);
    this.detached.set(tabId, view);
    view.update();
    this.panel.epoch++;
    this.emit();
  }
  returnTab(tabId: string): void {
    const view = this.detached.get(tabId);
    if (!view) return;
    view.destroy();
    this.detached.delete(tabId);
    const key = this.state?.layoutLanes ? tabId : "legacy",
      sequence = (this.layoutSequences.get(key) ?? 0) + 1;
    this.layoutSequences.set(key, sequence);
    if (!this.reconnect && !this.disposed)
      void this.request("layout", {
        tabId,
        detached: false,
        width: 800,
        height: 600,
        visible: false,
        interactive: false,
        pixelRatio: 1,
        sequence,
      }).catch((error) => this.fail(error));
    this.panel.epoch++;
    this.panel.reset();
    this.emit();
  }
  positionDetached(tabId: string, input: TaskBrowserLayout): void {
    this.detached.get(tabId)?.position(input);
    this.ensureConnection();
  }
  hideDetached(tabId: string): void {
    this.detached.get(tabId)?.hide();
  }
  applicationInputDetached(tabId: string, x?: number, y?: number): void {
    this.detached.get(tabId)?.applicationInput(x, y);
  }
  detachedSurfaces(tabId: string): readonly TaskBrowserSurface[] {
    return this.detached.get(tabId)?.surfaces() ?? [];
  }
  detachedSnapshot(tabId: string, state = this.snapshot()): TaskBrowserState {
    return {
      ...state,
      active: tabId,
      picked: state.active === tabId ? state.picked : null,
      picking: state.active === tabId && state.picking,
      surfaceEpoch: this.detached.get(tabId)?.epoch ?? state.surfaceEpoch,
    };
  }
  private endpoint(endpoint: BackendEndpoint): BackendEndpoint {
    return {
      ...endpoint,
      headers: { ...endpoint.headers, "x-elevenex-browser-view": this.token },
    };
  }
  private async request(
    path: string,
    body?: unknown,
    timeout = 10000,
  ): Promise<unknown> {
    if (this.disposed) throw new Error("Remote browser closed");
    const revision = this.connectionRevision;
    if (this.stream && (path === 'command' || path === 'layout' || path === 'input')) {
      const value = await this.stream.request(path, body, timeout);
      if (revision !== this.connectionRevision) throw new Error('Browser connection changed');
      return value;
    }
    const result = await this.client.execute(
      this.ownerId,
      this.scopeId,
      null,
      body !== undefined,
      (endpoint, signal) =>
        requestBackendJson(
          this.endpoint(endpoint),
          {
            path:
              "/api/desktop-browser/runtime/tasks/" + this.taskId + "/" + path,
            ...(body === undefined ? {} : { method: "POST", body }),
            limit: 65536,
            conflictMessages: {
              "browser-viewer-in-use":
                "This task browser is active in another window. Close its browser panel, then reconnect here.",
            },
          },
          signal,
        ),
      timeout,
    );
    if (revision !== this.connectionRevision)
      throw new Error("Browser connection changed; reconcile before retrying");
    if (
      !result.ok &&
      result.error.code === "http" &&
      result.error.status === 409
    )
      throw new RemoteBrowserConflict(result.error.message);
    if (!result.ok)
      throw new Error(
        result.error.code === "http" && result.error.status === 404
          ? "This host needs a browser runtime update."
          : "Browser connection interrupted. Inspect its state before retrying.",
      );
    return result.value;
  }
  async restore(): Promise<void> {
    this.accept(await this.request("initial"));
    this.schedule();
  }
  async refresh(): Promise<void> {
    if (this.hasDetached() && !this.reconnect) {
      this.accept(await this.request("state"));
      return;
    }
    this.connection = { phase: "idle" };
    this.reconnect = true;
    this.accept(await this.request("initial"));
  }
  snapshot(): TaskBrowserState {
    if (!this.state) throw new Error("Browser is connecting");
    return {
      ...this.state,
      capabilities: {
        embedded: false,
        audio: false,
        accessibility: false,
        filePicker: false,
        downloads: false,
      },
      revision: this.revision,
      surfaceEpoch: this.panel.epoch,
      connection: this.connection,
      tabs: this.state.tabs.map((tab) => ({
        ...tab,
        detached: this.detached.has(tab.id),
      })),
    };
  }
  private accept(value: unknown): void {
    if (this.disposed || record(value)["unchanged"] === true) return;
    const state = remoteBrowserState(value, this.scopeId, this.taskId);
    if (state.revision < this.serverRevision) return;
    this.serverRevision = state.revision;
    this.state = state;
    for (const key of this.layoutSequences.keys())
      if (
        key !== "legacy" &&
        key !== "panel" &&
        !state.tabs.some((tab) => tab.id === key)
      )
        this.layoutSequences.delete(key);
    this.panel.update();
    for (const view of this.detached.values()) view.update();
    this.emit();
  }
  surfaces(): readonly TaskBrowserSurface[] {
    return this.detached.has(this.state?.active ?? "")
      ? []
      : this.panel.surfaces();
  }
  async command(input: TaskBrowserCommand): Promise<TaskBrowserState> {
    if (input.kind === 'move-tab') {
      if (!this.state?.canReorder) throw new Error('Update the task machine to reorder browser tabs.');
      // Ordering does not change any document, viewport or driver generation.
      this.accept(await this.request('command', input, 200000));
      return this.snapshot();
    }
    if (input.kind === "outside") {
      const tab = this.state?.tabs.find((tab) => tab.id === input.tabId);
      if (!tab) throw new Error("Browser tab closed");
      const actual = await this.network.outside(browserUrl(tab.url));
      if (
        !this.selected() ||
        this.disposed ||
        this.client.state(this.ownerId).scope?.id !== this.scopeId ||
        !this.state?.tabs.some((item) => item.id === tab.id)
      )
        throw new Error("Task changed");
      await shell.openExternal(actual);
      return this.snapshot();
    }
    this.panel.reset();
    for (const view of this.detached.values()) view.reset();
    this.accept(await this.request("command", input, 200000));
    this.pump();
    return this.snapshot();
  }
  presentation(_tabId: string, value: "embedded" | "stream"): void {
    if (value !== "stream")
      throw new Error("Machine browsers use streamed display");
  }
  async userInput(
    tabId: string,
    generation: number,
    input: TaskBrowserStreamInput,
  ): Promise<number> {
    const view = this.detached.get(tabId) ?? this.panel;
    if (
      view.visible &&
      view.active === tabId &&
      this.state?.picked &&
      input.kind === "pointer" &&
      input.type === "up"
    )
      return (
        this.state.tabs.find((tab) => tab.id === tabId)?.generation ??
        generation
      );
    const revision = this.connectionRevision;
    const valid = () =>
      this.selected() &&
      !this.reconnect &&
      view.interactive &&
      view.active === tabId &&
      revision === this.connectionRevision &&
      !this.disposed;
    if (!valid()) throw new Error("Page is not interactive");
    if (input.kind === "clipboard" && input.operation === "paste")
      input = {
        kind: "text",
        text: (await clipboard.readText()).slice(0, 65536),
      };
    if (!valid()) throw new Error("Browser control changed");
    const reply = record(
      await this.request("input", { tabId, generation, input }, 4000),
    );
    if (!valid()) throw new Error("Browser control changed");
    if (
      typeof reply["clipboard"] === "string" &&
      reply["clipboard"].length <= 65536
    )
      clipboard.writeText(reply["clipboard"]);
    if (!Number.isSafeInteger(reply["generation"]))
      throw new Error("Invalid control receipt");
    const accepted = Number(reply["generation"]);
    if (Number.isSafeInteger(reply["revision"]))
      this.serverRevision = Math.max(
        this.serverRevision,
        Number(reply["revision"]),
      );
    if (this.state)
      this.state = {
        ...this.state,
        tabs: this.state.tabs.map((tab) =>
          tab.id === tabId
            ? {
                ...tab,
                generation: accepted,
                driver: tab.driver === "needs" ? "needs" : "you",
                waiting: tab.waiting || tab.driver === "agent",
                target: undefined,
              }
            : tab,
        ),
      };
    this.emit();
    return accepted;
  }
  acknowledge(tabId: string, streamId: string, sequence: number, decoded = true): void {
    (this.detached.get(tabId) ?? this.panel).acknowledge(
      tabId,
      streamId,
      sequence,
      decoded,
    );
  }
  position(input: TaskBrowserLayout): void {
    this.panel.position(input);
    this.ensureConnection();
  }
  private pump(): void {
    this.panel.pump();
    for (const view of this.detached.values()) view.pump();
  }
  private visible(): boolean {
    return (
      this.panel.visible ||
      [...this.detached.values()].some((view) => view.visible)
    );
  }
  private ensureConnection(): void {
    if (
      this.disposed ||
      !this.visible() ||
      !this.selected() ||
      !this.reconnect ||
      this.connection.phase === "blocked"
    )
      return;
    if (!this.connecting)
      this.connecting = this.establish()
        .catch((error) => this.fail(error))
        .finally(() => {
          this.connecting = undefined;
        });
  }
  private async establish(): Promise<void> {
    await this.disconnecting;
    if (this.disposed || !this.visible()) return;
    this.connection = { phase: "connecting", message: "Connecting browser…" };
    const reply = record(
      await this.request("connect", { clientId: this.clientId }),
    );
    if (this.disposed) return;
    this.connectionRevision++;
    this.serverRevision = -1;
    this.token = browserId(reply["token"]);
    this.panel.reset();
    for (const view of this.detached.values()) view.reset();
    this.connection = { phase: "connecting", message: "Connecting browser…" };
    this.reconnect = true;
    this.accept(reply["state"]);
    if (this.state?.streamVersion === 1) await this.openStream();
    this.reconnect = false;
    this.connection = { phase: 'ready' };
    this.emit();
    if (this.visible()) this.pump();
    else this.disconnect();
  }
  private async openStream(): Promise<void> {
    const revision = this.connectionRevision;
    let opened!: () => void, rejected!: (error: Error) => void;
    const ready = new Promise<void>((resolve, reject) => { opened = resolve; rejected = reject; });
    void this.client.execute(this.ownerId, this.scopeId, 'browser-stream:' + this.taskId, false, async (endpoint, signal) => {
      const stream = new RemoteBrowserStream(endpoint, this.taskId, this.token, signal, value => {
        if (!this.disposed && revision === this.connectionRevision) this.accept(value);
      });
      this.stream = stream;
      await stream.opened;
      opened();
      await stream.closed;
    }, null).then(() => {
      rejected(new Error('Browser stream interrupted'));
      if (!this.disposed && revision === this.connectionRevision && !this.reconnect) this.fail();
    });
    await ready;
  }
  private schedule(): void {
    if (!this.disposed)
      this.timer = setTimeout(
        () => {
          void this.poll();
        },
        this.stream ? 3000 : this.state?.tabs.some((tab) => tab.driver === "agent") ? 300 : 1200,
      );
  }
  private async poll(): Promise<void> {
    const revision = this.connectionRevision;
    try {
      if (
        this.selected() &&
        this.visible() &&
        this.connection.phase !== "blocked"
      ) {
        if (this.reconnect) this.ensureConnection();
        else if (this.stream) {
          if (Date.now() - this.lastHeartbeat >= 3000) {
            this.lastHeartbeat = Date.now();
            await this.stream.request('ping');
          }
        } else this.accept(await this.request("state?after=" + this.serverRevision));
      }
    } catch (error) {
      if (revision === this.connectionRevision) this.fail(error);
    } finally {
      this.schedule();
    }
  }
  private fail(error?: unknown): void {
    if (this.disposed) return;
    this.connectionRevision++;
    this.stream?.destroy();
    this.stream = undefined;
    this.connection =
      error instanceof RemoteBrowserConflict
        ? { phase: "blocked", message: error.message }
        : {
            phase: "connecting",
            message:
              "Browser connection interrupted. Reconnecting…",
          };
    this.reconnect = true;
    this.panel.reset();
    for (const view of this.detached.values()) view.reset();
    if (this.state)
      this.state = {
        ...this.state,
        tabs: this.state.tabs.map((tab) => ({
          ...tab,
          ready: false,
          error:
            tab.error ??
            "Browser disconnected. Reconnecting…",
        })),
      };
    this.emit();
  }
  private async readFrame(
    tabId: string,
    after: number,
    requestId: string,
  ): Promise<Omit<
    TaskBrowserFrame,
    "scopeId" | "taskId" | "tabId" | "streamId"
  > | null> {
    const revision = this.connectionRevision;
    if (this.stream) {
      if (this.state?.videoStream === 'h264' && this.stream.video.available(requestId)) {
        const frame = await this.stream.video.next(tabId, after, requestId, this.state.videoWindow ?? 3);
        if (revision !== this.connectionRevision) return null;
        if (frame) return frame;
        if (this.stream.video.available(requestId)) return null;
      }
      const value = await this.stream.request('frame', { tabId, after }, 35000, requestId);
      if (revision !== this.connectionRevision) return null;
      if (value === null) return null;
      const frame = record(value);
      if (typeof frame['sequence'] !== 'number' || frame['sequence'] <= after || typeof frame['width'] !== 'number' || typeof frame['height'] !== 'number' || !(frame['jpeg'] instanceof Uint8Array)) throw new Error('Invalid remote frame');
      return { sequence: frame['sequence'], width: frame['width'], height: frame['height'], jpeg: frame['jpeg'] };
    }
    const result = await this.client.execute(
      this.ownerId,
      this.scopeId,
      requestId,
      false,
      async (endpoint, signal) => {
        const response = await fetch(
          new URL(
            "/api/desktop-browser/runtime/tasks/" +
              this.taskId +
              "/frame?tabId=" +
              encodeURIComponent(tabId) +
              "&after=" +
              after,
            endpoint.url,
          ),
          {
            headers: this.endpoint(endpoint).headers,
            signal,
            redirect: "error",
            cache: "no-store",
          },
        );
        if (response.status === 204) return null;
        if (!response.ok || !response.body)
          throw new Error("Remote page frame unavailable");
        const chunks: Uint8Array[] = [];
        let size = 0;
        const reader = response.body.getReader();
        try {
          for (;;) {
            const part = await reader.read();
            if (part.done) break;
            size += part.value.byteLength;
            if (size > 3001024) throw new Error("Remote frame too large");
            chunks.push(part.value);
          }
        } finally {
          await reader.cancel().catch(() => undefined);
        }
        const body = Buffer.concat(chunks);
        if (body.length < 5) throw new Error("Invalid remote frame");
        const length = body.readUInt32BE(0);
        if (length > 1024 || length + 4 >= body.length)
          throw new Error("Invalid remote frame");
        const metadata = record(
          JSON.parse(body.subarray(4, 4 + length).toString("utf8")),
        );
        if (
          !Number.isSafeInteger(metadata["sequence"]) ||
          Number(metadata["sequence"]) <= after ||
          typeof metadata["width"] !== "number" ||
          !Number.isFinite(metadata["width"]) ||
          typeof metadata["height"] !== "number" ||
          !Number.isFinite(metadata["height"]) ||
          Number(metadata["width"]) < 1 ||
          Number(metadata["height"]) < 1 ||
          Number(metadata["width"]) > 16384 ||
          Number(metadata["height"]) > 16384
        )
          throw new Error("Invalid remote frame dimensions");
        return {
          sequence: Number(metadata["sequence"]),
          width: Number(metadata["width"]),
          height: Number(metadata["height"]),
          jpeg: new Uint8Array(body.subarray(4 + length)),
        };
      },
      7000,
    );
    if (revision !== this.connectionRevision || this.disposed) return null;
    if (!result.ok) throw new Error("Browser frame interrupted");
    return result.value;
  }
  maintain(): void {
    if (this.client.state(this.ownerId).scope?.id !== this.scopeId) {
      this.destroy();
      return;
    }
    this.panel.maintain();
    for (const view of this.detached.values()) view.maintain();
    if (!this.visible() && !this.reconnect && !this.connecting)
      this.disconnect();
  }
  applicationInput(x?: number, y?: number): void {
    this.panel.applicationInput(x, y);
  }
  hide(): void {
    this.panel.hide();
  }
  suspend(): void {
    this.hide();
    if (!this.visible()) this.disconnect();
  }
  revoke(): void {
    this.suspend();
    this.fail();
  }
  private disconnect(): void {
    if (this.reconnect) return;
    this.connection = { phase: "idle" };
    this.reconnect = true;
    this.stream?.destroy();
    this.stream = undefined;
    this.disconnecting = this.request("disconnect", {}).then(
      () => undefined,
      () => undefined,
    );
  }
  destroy(): void {
    if (this.disposed) return;
    this.disconnect();
    this.disposed = true;
    clearTimeout(this.timer);
    this.panel.destroy();
    for (const view of this.detached.values()) view.destroy();
    this.detached.clear();
    this.network.close();
    this.surfacesChanged();
  }
}
