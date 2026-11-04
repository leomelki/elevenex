import { remoteBrowserState } from "./remote-state";
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
/** Remote task transport. Child presentations share its private viewer connection;
 * only the root connects/polls, while each view owns its viewport and frame receipts. */
export class RemoteTaskBrowser {
  readonly isRemote = true;
  private readonly detached = new Map<string, RemoteTaskBrowser>();
  private get ownerId(): number { return this.parent?.browser.ownerId ?? this.window.webContents.id; }
  hasDetached(): boolean { return this.detached.size > 0; }
  detachTab(tabId: string, window: BrowserWindow): void {
    if (!this.state?.canDetach) throw new Error('Update this machine to open browser tabs in windows.');
    if (!this.state?.tabs.some(tab => tab.id === tabId) || this.detached.has(tabId)) throw new Error('Browser tab changed');
    const view = new RemoteTaskBrowser(this.scopeId, this.taskId, window, this.client,
      () => { this.revision++; this.changed(this.snapshot()); this.surfacesChanged(); }, this.selected, this.surfacesChanged, this.deliver, this.remote,
      { browser: this, tabId });
    view.reconnect = false; this.detached.set(tabId, view);
    view.accept({ ...this.state, active: tabId });
    this.epoch++; this.revision++; this.changed(this.snapshot()); this.surfacesChanged();
  }
  returnTab(tabId: string): void {
    const view = this.detached.get(tabId); if (!view) return;
    this.detached.delete(tabId); view.destroy();
    void this.request('layout', { tabId, detached: false, width: 800, height: 600, visible: false, interactive: false, pixelRatio: 1, sequence: ++this.remoteLayoutSequence }).catch(() => undefined);
    this.epoch++; this.revision++; this.changed(this.snapshot()); this.surfacesChanged();
  }
  positionDetached(tabId: string, input: TaskBrowserLayout): void { this.detached.get(tabId)?.position(input); }
  hideDetached(tabId: string): void { this.detached.get(tabId)?.hide(); }
  applicationInputDetached(tabId: string, x?: number, y?: number): void { this.detached.get(tabId)?.applicationInput(x, y); }
  detachedSurfaces(tabId: string): readonly TaskBrowserSurface[] { return this.detached.get(tabId)?.surfaces() ?? []; }
  detachedSnapshot(tabId: string, state = this.snapshot()): TaskBrowserState { const view = this.detached.get(tabId); return view ? { ...view.snapshot(), revision: state.revision } : state; }
  private state?: TaskBrowserState;
  private token = "";
  private revision = 0;
  private serverRevision = -1;
  private epoch = 0;
  private sequence = -1;
  private heartbeat = 0;
  private layout?: TaskBrowserLayout;
  private layoutPending = false;
  private layoutSent = "";
  private lastLayout = 0;
  private remoteLayoutSequence = 0;
  private frameRevision = 0;
  private disposed = false;
  private timer?: ReturnType<typeof setTimeout>;
  private framePending = false;
  private waitingAck = 0;
  private after = 0;
  private streamId = randomUUID();
  private connectionRevision = 0;
  private reconnect = true;
  private connection: NonNullable<TaskBrowserState["connection"]> = {
    phase: "idle",
  };
  private connecting?: Promise<void>;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private readonly network: TaskBrowserNetwork;
  private readonly clientId = randomUUID();
  private presentedTab: string | null = null;
  get closed(): boolean {
    return this.disposed;
  }
  constructor(
    readonly scopeId: string,
    readonly taskId: number,
    private readonly window: BrowserWindow,
    private readonly client: BackendClient,
    private readonly changed: (state: TaskBrowserState) => void,
    private readonly selected: () => boolean,
    private readonly surfacesChanged: () => void,
    private readonly deliver: (frame: TaskBrowserFrame) => void,
    private readonly remote: RemoteManager,
    private readonly parent?: { readonly browser: RemoteTaskBrowser; readonly tabId: string },
  ) {
    this.network = new TaskBrowserNetwork(
      true,
      (port) => remote.browserForward(this.ownerId, port),
      () =>
        !this.disposed &&
        client.state(this.ownerId).scope?.id === scopeId,
      selected,
    );
  }
  private endpoint(endpoint: BackendEndpoint): BackendEndpoint {
    if (this.parent) return this.parent.browser.endpoint(endpoint);
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
    if (this.parent) return this.parent.browser.request(path, body, timeout);
    const revision = this.connectionRevision;
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
      throw new Error(
        "Remote browser connection changed; reconcile before retrying",
      );
    if (
      !result.ok &&
      result.error.code === "http" &&
      result.error.status === 409
    )
      throw new RemoteBrowserConflict(result.error.message);
    if (!result.ok)
      throw new Error(
        result.error.code === "http" && result.error.status === 404
          ? "This remote host needs a browser runtime update."
          : "Remote browser connection interrupted. Inspect its state before retrying.",
      );
    return result.value;
  }
  async restore(): Promise<void> {
    this.accept(await this.request("initial"));
    this.schedule();
  }
  private connect(): Promise<void> {
    return (this.connecting ??= this.establish().finally(() => {
      this.connecting = undefined;
    }));
  }
  private async establish(): Promise<void> {
    this.connection = { phase: "connecting", message: "Connecting browser…" };
    const reply = record(
      await this.request("connect", { clientId: this.clientId }),
    );
    this.connectionRevision++;
    this.serverRevision = -1;
    this.token = browserId(reply["token"]);
    for (const view of this.detached.values()) { view.streamId = randomUUID(); view.after = 0; view.waitingAck = 0; view.layoutSent = ''; view.frameRevision++; view.serverRevision = -1; }
    this.streamId = randomUUID();
    this.waitingAck = 0;
    this.after = 0;
    this.reconnect = false;
    this.connection = { phase: "ready" };
    this.layoutSent = "";
    this.accept(reply["state"]);
  }
  async refresh(): Promise<void> {
    if (this.hasDetached() && !this.reconnect) { this.accept(await this.request('state')); return; }
    this.connection = { phase: "idle" };
    this.reconnect = true;
    this.accept(await this.request("initial"));
  }
  snapshot(): TaskBrowserState {
    if (!this.state) throw new Error("Remote browser is connecting");
    return {
      ...this.state,
      revision: this.revision,
      surfaceEpoch: this.epoch,
      connection: this.parent?.browser.connection ?? this.connection,
      tabs: (this.state?.tabs ?? []).map(tab => ({ ...tab, detached: this.detached.has(tab.id) })),
    };
  }
  private accept(value: unknown): void {
    if (this.disposed) return;
    if (record(value)["unchanged"] === true) return;
    const state = remoteBrowserState(value, this.scopeId, this.taskId);
    if (state.revision < this.serverRevision) return;
    this.serverRevision = state.revision;
    this.state = this.parent ? { ...state, active: this.parent.tabId } : state;
    this.revision++;
    if (this.presentedTab !== this.state.active) {
      this.presentedTab = this.state.active;
      this.after = 0;
      this.waitingAck = 0;
      this.layoutSent = "";
    }
    for (const [tabId, view] of this.detached) view.accept({ ...state, active: tabId });
    this.changed(this.snapshot());
    this.surfacesChanged();
  }
  surfaces(): readonly TaskBrowserSurface[] {
    const tab = this.state?.tabs.find((tab) => tab.id === this.state?.active),
      box = this.layout?.bounds;
    if (this.disposed || !tab?.url || !box || this.detached.has(tab.id)) return [];
    const zoom = this.window.webContents.getZoomFactor();
    return [
      {
        scopeId: this.scopeId,
        taskId: this.taskId,
        tabId: tab.id,
        partition: "",
        bootstrap: "",
        bounds: {
          x: box.x * zoom,
          y: box.y * zoom,
          width: box.width * zoom,
          height: box.height * zoom,
        },
        zoom,
        viewport: this.layout?.viewport,
        generation: tab.generation,
        driver: tab.driver,
        visible: this.layout?.visible === true && !tab.error && !tab.loading,
        interactive: this.layout?.inputReady === true,
        presentation: "stream",
      },
    ];
  }
  async command(input: TaskBrowserCommand): Promise<TaskBrowserState> {
    if (this.parent) return this.parent.browser.command(input);
    if (input.kind === "outside") {
      const tab = this.state?.tabs.find((tab) => tab.id === input.tabId);
      if (!tab) throw new Error("Browser tab closed");
      const actual = await this.network.outside(browserUrl(tab.url));
      if (!this.selected() || this.disposed || this.client.state(this.ownerId).scope?.id !== this.scopeId || !this.state?.tabs.some(item => item.id === tab.id)) throw new Error("Task changed");
      await shell.openExternal(actual);
      return this.snapshot();
    }
    this.frameRevision++;
    this.waitingAck = 0;
    this.accept(await this.request("command", input, 200000));
    this.layoutSent = "";
    void this.pushLayout();
    void this.readFrame();
    return this.snapshot();
  }
  presentation(_tabId: string, value: "embedded" | "stream"): void {
    if (value !== "stream")
      throw new Error("Remote browsers use streamed display");
  }
  async userInput(
    tabId: string,
    generation: number,
    input: TaskBrowserStreamInput,
  ): Promise<number> {
    const detached = this.detached.get(tabId); if (detached) return detached.userInput(tabId, generation, input);
    if (this.selected() && this.layout?.visible && this.state?.active === tabId && this.state.picked && input.kind === 'pointer' && input.type === 'up') return this.state.tabs.find(tab => tab.id === tabId)?.generation ?? generation;
    if (
      !this.selected() ||
      !this.layout?.visible ||
      !this.layout.inputReady ||
      tabId !== this.state?.active
    )
      throw new Error("Remote page is not interactive");
    if (input.kind === "clipboard" && input.operation === "paste")
      input = {
        kind: "text",
        text: (await clipboard.readText()).slice(0, 65536),
      };
    if (!this.selected() || !this.layout?.inputReady)
      throw new Error("Browser control changed");
    const reply = record(
      await this.request("input", { tabId, generation, input }, 4000),
    );
    if (
      this.selected() &&
      this.state?.active === tabId &&
      typeof reply["clipboard"] === "string" &&
      reply["clipboard"].length <= 65536
    )
      await clipboard.writeText(reply["clipboard"]);
    if (!Number.isSafeInteger(reply["generation"]))
      throw new Error("Invalid remote control receipt");
    if (this.parent) {
      this.parent.browser.accept(await this.parent.browser.request('state'));
      return Number(reply['generation']);
    }
    if (this.state && this.selected()) {
      const accepted = Number(reply["generation"]);
      if (Number.isSafeInteger(reply["revision"]))
        this.serverRevision = Math.max(
          this.serverRevision,
          Number(reply["revision"]),
        );
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
      this.revision++;
      this.changed(this.snapshot());
      this.surfacesChanged();
    }
    return Number(reply["generation"]);
  }
  acknowledge(tabId: string, streamId: string, sequence: number): void {
    const detached = this.detached.get(tabId); if (detached) { detached.acknowledge(tabId, streamId, sequence); return; }
    if (
      streamId === this.streamId &&
      tabId === this.state?.active &&
      sequence === this.waitingAck
    ) {
      this.waitingAck = 0;
      void this.readFrame();
    }
  }
  position(input: TaskBrowserLayout): void {
    if (
      this.disposed ||
      input.surfaceEpoch !== this.epoch ||
      input.sequence <= this.sequence
    )
      return;
    this.sequence = input.sequence;
    this.heartbeat = Date.now();
    this.layout = input;
    this.surfacesChanged();
    if (this.parent) { void this.pushLayout(); void this.readFrame(); return; }
    if (this.reconnect && this.connection.phase !== "blocked") {
      void this.connect()
        .then(() => {
          if (this.layout?.visible) {
            void this.pushLayout();
            void this.readFrame();
          } else void this.request("disconnect", {}).catch(() => undefined);
        })
        .catch((error) => this.fail(error));
    } else {
      void this.pushLayout();
      void this.readFrame();
    }
  }
  private async pushLayout(): Promise<void> {
    if (
      this.layoutPending ||
      !this.layout ||
      !this.selected() ||
      this.disposed ||
      this.reconnect
    )
      return;
    if (!this.parent && this.state?.active && this.detached.has(this.state.active)) return;
    const box = {
      ...(this.parent ? { tabId: this.parent.tabId } : {}),
      width: Math.max(
        100,
        Math.min(
          2560,
          Math.round(this.layout.viewport?.width ?? this.layout.bounds.width),
        ),
      ),
      height: Math.max(
        100,
        Math.min(
          1600,
          Math.round(this.layout.viewport?.height ?? this.layout.bounds.height),
        ),
      ),
      visible: this.layout.visible,
      colorScheme: nativeTheme.shouldUseDarkColors ? "dark" : "light",
      interactive: this.layout.inputReady,
      pixelRatio: Math.min(
        2,
        screen.getDisplayMatching(this.window.getBounds()).scaleFactor,
      ),
    };
    const key = JSON.stringify(box);
    if (key === this.layoutSent && Date.now() - this.lastLayout < 1000) return;
    this.layoutPending = true;
    this.layoutSent = key;
    this.lastLayout = Date.now();
    try {
      this.accept(
        await this.request("layout", {
          ...box,
          sequence: this.parent ? ++this.parent.browser.remoteLayoutSequence : ++this.remoteLayoutSequence,
        }),
      );
    } catch (error) {
      this.fail(error);
    } finally {
      this.layoutPending = false;
    }
  }
  private schedule(): void {
    if (this.disposed) return;
    this.timer = setTimeout(
      () => {
        void this.poll();
      },
      this.state?.tabs.some((tab) => tab.driver === "agent") ? 300 : 1200,
    );
  }
  private async poll(): Promise<void> {
    try {
      if (
        this.selected() &&
        (this.layout?.visible || this.hasDetached()) &&
        this.connection.phase !== "blocked"
      ) {
        if (this.reconnect) await this.connect();
        else
          this.accept(await this.request("state?after=" + this.serverRevision));
      }
    } catch (error) {
      this.fail(error);
    } finally {
      this.schedule();
    }
  }
  private fail(error?: unknown): void {
    if (this.parent) { this.parent.browser.fail(error); return; }
    this.connection =
      error instanceof RemoteBrowserConflict
        ? { phase: "blocked", message: error.message }
        : {
            phase: "connecting",
            message:
              "Browser connection interrupted. Reconnecting with user control…",
          };
    this.reconnect = true;
    for (const view of this.detached.values()) { view.waitingAck = 0; view.frameRevision++; view.layoutSent = ""; }
    this.waitingAck = 0;
    if (this.state) {
      this.state = {
        ...this.state,
        tabs: this.state.tabs.map((tab) => ({
          ...tab,
          driver: "you",
          ready: false,
          error:
            tab.error ??
            "The remote browser disconnected. Reconnecting with user control…",
        })),
      };
      this.revision++;
      this.changed(this.snapshot());
    }
  }
  private async readFrame(): Promise<void> {
    const tabId = this.state?.active;
    if (
      this.state?.tabs.find((tab) => tab.id === tabId)?.loading ||
      this.state?.tabs.find((tab) => tab.id === tabId)?.error ||
      this.framePending ||
      this.waitingAck ||
      !tabId ||
      this.detached.has(tabId) ||
      !this.layout?.visible ||
      !this.selected() ||
      this.disposed ||
      this.reconnect
    )
      return;
    this.framePending = true;
    const revision = this.parent?.browser.connectionRevision ?? this.connectionRevision,
      frameRevision = this.frameRevision;
    const result = await this.client.execute(
      this.ownerId,
      this.scopeId,
      "browser-frame:" + this.taskId + (this.parent ? ":" + this.parent.tabId : ""),
      false,
      async (endpoint, signal) => {
        const response = await fetch(
          new URL(
            "/api/desktop-browser/runtime/tasks/" +
              this.taskId +
              "/frame?tabId=" +
              encodeURIComponent(tabId) +
              "&after=" +
              this.after,
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
          Number(metadata["sequence"]) <= this.after ||
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
    this.framePending = false;
    if (
      this.disposed ||
      revision !== (this.parent?.browser.connectionRevision ?? this.connectionRevision) ||
      frameRevision !== this.frameRevision ||
      this.state?.active !== tabId ||
      !this.layout?.visible
    )
      return;
    if (result.ok && result.value) {
      this.after = result.value.sequence;
      this.waitingAck = result.value.sequence;
      this.deliver({
        scopeId: this.scopeId,
        taskId: this.taskId,
        tabId,
        streamId: this.streamId,
        ...result.value,
      });
    } else if (!result.ok) this.fail();
    else if (this.selected())
      this.retryTimer = setTimeout(() => {
        void this.readFrame();
      }, 200);
  }
  maintain(): void {
    for (const view of this.detached.values()) view.maintain();
    if (
      this.layout &&
      (Date.now() - this.heartbeat > 750 ||
        !this.window.isVisible() ||
        this.window.isMinimized())
    )
      this.hide();
    if (
      this.client.state(this.ownerId).scope?.id !== this.scopeId
    )
      this.destroy();
  }
  applicationInput(x?: number, y?: number): void {
    const layout = this.layout;
    if (!layout?.visible || !layout.inputReady) return;
    if (
      x !== undefined &&
      y !== undefined &&
      x >= layout.bounds.x &&
      x < layout.bounds.x + layout.bounds.width &&
      y >= layout.bounds.y &&
      y < layout.bounds.y + layout.bounds.height
    )
      return;
    this.epoch++;
    this.layout = { ...layout, inputReady: false, surfaceEpoch: this.epoch };
    this.revision++;
    this.changed(this.snapshot());
    this.surfacesChanged();
    void this.pushLayout();
  }
  hide(): void {
    clearTimeout(this.retryTimer);
    const visible = this.layout?.visible;
    this.epoch++;
    this.layout = undefined;
    this.waitingAck = 0;
    this.client.cancel(
      this.ownerId,
      this.scopeId,
      "browser-frame:" + this.taskId + (this.parent ? ":" + this.parent.tabId : ""),
    );
    if (this.state) {
      this.revision++;
      this.changed(this.snapshot());
    }
    this.surfacesChanged();
    if (visible && (this.parent || this.hasDetached())) {
      if (this.parent || !this.state?.active || !this.detached.has(this.state.active)) void this.request('layout', {
        ...(this.parent ? { tabId: this.parent.tabId } : {}), width: 800, height: 600, visible: false, interactive: false, pixelRatio: 1,
        sequence: this.parent ? ++this.parent.browser.remoteLayoutSequence : ++this.remoteLayoutSequence,
      }).catch(() => undefined);
      return;
    }
    if (visible) {
      this.connection = { phase: "idle" };
      this.reconnect = true;
      void this.request("disconnect", {}).catch(() => undefined);
    }
  }
  suspend(): void {
    this.hide();
    if (this.hasDetached() || this.parent) return;
    this.reconnect = true;
    void this.request("disconnect", {}).catch(() => undefined);
  }
  revoke(): void {
    this.suspend();
    this.fail();
  }
  destroy(): void {
    if (this.disposed) return;
    this.hide();
    for (const view of this.detached.values()) view.destroy(); this.detached.clear();
    clearTimeout(this.timer);
    if (!this.parent) void this.request("disconnect", {}).catch(() => undefined);
    this.disposed = true;
    this.network.close();
    this.surfacesChanged();
  }
}
