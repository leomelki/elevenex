import { randomUUID } from "node:crypto";
import type {
  TaskBrowserFrame,
  TaskBrowserLayout,
  TaskBrowserState,
  TaskBrowserSurface,
} from "@elevenex/shared";

export interface RemotePresentationLayout {
  readonly width: number;
  readonly height: number;
  readonly visible: boolean;
  readonly interactive: boolean;
  readonly pixelRatio: number;
  readonly colorScheme: "dark" | "light";
}

export interface RemotePresentationHost {
  readonly scopeId: string;
  readonly taskId: number;
  state(): TaskBrowserState | undefined;
  ready(): boolean;
  changed(): void;
  layout(
    tabId: string | undefined,
    body: RemotePresentationLayout,
  ): Promise<void>;
  frame(
    tabId: string,
    after: number,
    requestId: string,
  ): Promise<Omit<
    TaskBrowserFrame,
    "scopeId" | "taskId" | "tabId" | "streamId"
  > | null>;
  cancel(requestId: string): void;
  deliver(frame: TaskBrowserFrame): void;
  failed(error: unknown): void;
}
export interface RemotePresentationWindow {
  visible(): boolean;
  zoom(): number;
  pixelRatio(): number;
  colorScheme(): "dark" | "light";
}

/** One display. No credentials, task polling, tab collection, network grants or viewer lease. */
export class RemoteBrowserPresentation {
  private readonly requestId = "browser-frame:" + randomUUID();
  private streamId = randomUUID();
  private after = 0;
  private waitingAck = 0;
  private frameRevision = 0;
  private framePending = false;
  private layoutPending = false;
  private layoutSent = "";
  private lastLayout = 0;
  private sequence = -1;
  private heartbeat = 0;
  private presentedTab: string | null = null;
  private disposed = false;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private layout?: TaskBrowserLayout;
  epoch = 0;
  constructor(
    private readonly host: RemotePresentationHost,
    private readonly window: RemotePresentationWindow,
    readonly tabId?: string,
  ) {}
  get active(): string | null {
    return this.tabId ?? this.host.state()?.active ?? null;
  }
  get visible(): boolean {
    return this.layout?.visible === true;
  }
  get interactive(): boolean {
    return this.visible && this.layout?.inputReady === true;
  }
  update(): void {
    if (this.presentedTab !== this.active) {
      this.presentedTab = this.active;
      this.reset();
    }
  }
  reset(): void {
    this.frameRevision++;
    this.streamId = randomUUID();
    this.waitingAck = 0;
    this.after = 0;
    this.layoutSent = "";
    clearTimeout(this.retryTimer);
    this.host.cancel(this.requestId);
  }
  surfaces(): readonly TaskBrowserSurface[] {
    const tab = this.host.state()?.tabs.find((tab) => tab.id === this.active),
      box = this.layout?.bounds;
    if (this.disposed || !tab?.url || !box) return [];
    const zoom = this.window.zoom();
    return [
      {
        scopeId: this.host.scopeId,
        taskId: this.host.taskId,
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
        visible:
          this.visible && this.host.ready() && !tab.error && !tab.loading,
        interactive: this.interactive && this.host.ready(),
        presentation: "stream",
      },
    ];
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
    this.host.changed();
    this.pump();
  }
  pump(): void {
    void this.pushLayout();
    void this.readFrame();
  }
  private async pushLayout(): Promise<void> {
    if (
      this.layoutPending ||
      !this.layout ||
      this.disposed ||
      !this.host.ready()
    )
      return;
    const box = {
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
      visible: this.visible,
      interactive: this.interactive,
      pixelRatio: this.window.pixelRatio(),
      colorScheme: this.window.colorScheme(),
    };
    const key = JSON.stringify(box);
    if (key === this.layoutSent && Date.now() - this.lastLayout < 1000) return;
    this.layoutPending = true;
    this.layoutSent = key;
    this.lastLayout = Date.now();
    try {
      await this.host.layout(this.tabId, box);
    } catch (error) {
      if (!this.disposed) this.host.failed(error);
    } finally {
      this.layoutPending = false;
    }
  }
  private async readFrame(): Promise<void> {
    const tabId = this.active,
      tab = this.host.state()?.tabs.find((tab) => tab.id === tabId);
    if (
      !tabId ||
      tab?.loading ||
      tab?.error ||
      this.framePending ||
      this.waitingAck ||
      !this.visible ||
      this.disposed ||
      !this.host.ready()
    )
      return;
    this.framePending = true;
    const revision = this.frameRevision;
    try {
      const frame = await this.host.frame(tabId, this.after, this.requestId);
      if (
        this.disposed ||
        revision !== this.frameRevision ||
        this.active !== tabId ||
        !this.visible ||
        !this.host.ready()
      )
        return;
      if (frame) {
        this.after = frame.sequence;
        this.waitingAck = frame.sequence;
        this.host.deliver({
          scopeId: this.host.scopeId,
          taskId: this.host.taskId,
          tabId,
          streamId: this.streamId,
          ...frame,
        });
      } else
        this.retryTimer = setTimeout(() => {
          void this.readFrame();
        }, 200);
    } catch (error) {
      if (!this.disposed && revision === this.frameRevision)
        this.host.failed(error);
    } finally {
      this.framePending = false;
    }
  }
  acknowledge(tabId: string, streamId: string, sequence: number): void {
    if (
      tabId !== this.active ||
      streamId !== this.streamId ||
      sequence !== this.waitingAck
    )
      return;
    this.waitingAck = 0;
    void this.readFrame();
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
    this.host.changed();
    void this.pushLayout();
  }
  maintain(): void {
    if (
      this.layout &&
      (Date.now() - this.heartbeat > 750 || !this.window.visible())
    )
      this.hide();
    else if (this.visible) this.pump();
  }
  hide(): void {
    const visible = this.visible;
    this.epoch++;
    this.layout = undefined;
    this.reset();
    if (visible && this.host.ready())
      void this.host
        .layout(this.tabId, {
          width: 800,
          height: 600,
          visible: false,
          interactive: false,
          pixelRatio: 1,
          colorScheme: this.window.colorScheme(),
        })
        .catch((error) => {
          if (!this.disposed) this.host.failed(error);
        });
    this.host.changed();
  }
  destroy(): void {
    if (this.disposed) return;
    this.hide();
    this.disposed = true;
  }
}
