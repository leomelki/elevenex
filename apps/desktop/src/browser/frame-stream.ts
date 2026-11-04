import { randomUUID } from "node:crypto";
import type { TaskBrowserFrame } from "@elevenex/shared";
import type { WebContents } from "electron";

/** Display-only pixels: one delivered frame and one latest replacement, never a frame backlog. */
export class BrowserFrameStream {
  private readonly debuggerApi: Electron.Debugger;
  private readonly id = randomUUID();
  private sequence = 0;
  private outstanding?: { sequence: number; sent: number };
  private latest?: { jpeg: Uint8Array; width: number; height: number };
  private active = false;
  private disposed = false;
  private running = false;
  private revision = 0;
  private quality = 88;
  private maxWidth = 1920;
  private timer?: ReturnType<typeof setTimeout>;
  constructor(
    private readonly contents: WebContents,
    private readonly identity: Pick<
      TaskBrowserFrame,
      "scopeId" | "taskId" | "tabId"
    >,
    private readonly deliver: (frame: TaskBrowserFrame) => void,
  ) {
    this.debuggerApi = contents.debugger;
    this.debuggerApi.on("message", this.message);
  }
  private readonly message = (
    _event: Electron.Event,
    method: string,
    params: unknown,
  ) => {
    if (
      method !== "Page.screencastFrame" ||
      !params ||
      typeof params !== "object"
    )
      return;
    const frame = params as Record<string, unknown>;
    if (typeof frame["sessionId"] === "number")
      void this.command("Page.screencastFrameAck", {
        sessionId: frame["sessionId"],
      });
    if (
      !this.active ||
      this.disposed ||
      typeof frame["data"] !== "string" ||
      frame["data"].length > 4_000_000
    )
      return;
    const metadata = frame["metadata"];
    if (!metadata || typeof metadata !== "object") return;
    const { deviceWidth, deviceHeight } = metadata as Record<string, unknown>;
    if (
      typeof deviceWidth !== "number" ||
      typeof deviceHeight !== "number" ||
      !Number.isFinite(deviceWidth) ||
      !Number.isFinite(deviceHeight) ||
      deviceWidth < 1 ||
      deviceHeight < 1 ||
      deviceWidth > 16384 ||
      deviceHeight > 16384
    )
      return;
    this.latest = {
      jpeg: new Uint8Array(Buffer.from(frame["data"], "base64")),
      width: deviceWidth,
      height: deviceHeight,
    };
    this.flush();
  };
  setActive(active: boolean): void {
    if (this.disposed || active === this.active) return;
    this.active = active;
    this.revision++;
    if (!active) {
      clearTimeout(this.timer);
      this.outstanding = undefined;
      this.latest = undefined;
      void this.stop();
    } else void this.start();
  }
  acknowledge(stream: string, sequence: number): void {
    if (stream !== this.id || sequence !== this.outstanding?.sequence) return;
    const elapsed = performance.now() - this.outstanding.sent;
    this.outstanding = undefined;
    clearTimeout(this.timer);
    const quality = elapsed > 180 ? 65 : elapsed < 60 ? 88 : this.quality;
    const width = elapsed > 180 ? 1280 : elapsed < 60 ? 1920 : this.maxWidth;
    if (quality !== this.quality || width !== this.maxWidth) {
      this.quality = quality;
      this.maxWidth = width;
      this.revision++;
      void this.stop().then(() => this.start());
    } else if (this.active && !this.running) void this.start();
    this.flush();
  }
  private flush(): void {
    if (!this.active || this.disposed || this.outstanding || !this.latest)
      return;
    const frame = this.latest;
    this.latest = undefined;
    this.outstanding = { sequence: ++this.sequence, sent: performance.now() };
    this.deliver({
      ...this.identity,
      ...frame,
      streamId: this.id,
      sequence: this.sequence,
    });
    // A frozen/disconnected viewer cannot make Chromium encode indefinitely.
    this.timer = setTimeout(() => {
      void this.stop();
      this.latest = undefined;
    }, 1000);
  }
  private async start(): Promise<void> {
    if (
      this.disposed ||
      !this.active ||
      this.running ||
      this.contents.isDestroyed()
    )
      return;
    const revision = this.revision;
    try {
      if (!this.contents.debugger.isAttached())
        this.contents.debugger.attach("1.3");
      this.running = true;
      await this.contents.debugger.sendCommand("Page.startScreencast", {
        format: "jpeg",
        quality: this.quality,
        maxWidth: this.maxWidth,
        maxHeight: 1440,
        everyNthFrame: 1,
      });
      if (this.disposed || !this.active || revision !== this.revision)
        await this.stop();
    } catch {
      this.running = false;
    }
  }
  private async stop(): Promise<void> {
    this.running = false;
    await this.command("Page.stopScreencast");
  }
  private async command(
    method: string,
    params?: Record<string, unknown>,
  ): Promise<void> {
    if (!this.contents.isDestroyed() && this.contents.debugger.isAttached())
      await this.contents.debugger
        .sendCommand(method, params)
        .catch(() => undefined);
  }
  destroy(): void {
    if (this.disposed) return;
    this.setActive(false);
    this.disposed = true;
    this.debuggerApi.removeListener("message", this.message);
  }
}
