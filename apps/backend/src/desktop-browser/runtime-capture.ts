import type { CDPSession } from 'playwright-core';

export interface RuntimeFrame {
  readonly sequence: number;
  readonly width: number;
  readonly height: number;
  readonly pixelRatio?: number;
  readonly displayEpoch?: number;
  readonly jpeg: Buffer;
}
export interface RuntimeVideoCapture {
  readonly width: number;
  readonly height: number;
  readonly fps: number;
}
interface CaptureState {
  readonly width: number;
  readonly height: number;
  readonly pixelRatio: number;
  readonly displayEpoch: number;
  readonly visible: boolean;
  readonly ready: boolean;
}
interface Waiter {
  readonly after: number;
  resolve(frame: RuntimeFrame | null): void;
}
interface ScreencastFrame {
  readonly sessionId: number;
  readonly data: string;
  readonly metadata: {
    readonly deviceWidth: number;
    readonly deviceHeight: number;
  };
}

/** Tab-owned latest-image source. Capture lifecycle, waiters and watchdogs have
 * one owner; video pacing never samples Chromium's sparse damage events.
 */
export class RuntimeBrowserCapture {
  private cdp?: CDPSession;
  private removeListener?: () => void;
  private frame?: RuntimeFrame;
  private sequence = 0;
  private revision = 0;
  private streaming = false;
  private control: Promise<void> = Promise.resolve();
  private reading = false;
  private waiter?: Waiter;
  private refreshPending?: Promise<void>;
  private lastRefresh = -Infinity;
  private dirty = true;
  private outstanding = false;
  private frameSent = 0;
  private readonly quality = 95;
  private maxWidth = 1920;
  private maxHeight = 1440;
  constructor(private readonly state: () => CaptureState) {}

  attach(cdp: CDPSession): void {
    this.detach();
    this.cdp = cdp;
    const receive = (event: ScreencastFrame) => {
      void cdp
        .send('Page.screencastFrameAck', { sessionId: event.sessionId })
        .catch(() => undefined);
      const state = this.state();
      if (
        this.cdp !== cdp ||
        !this.streaming ||
        !state.visible ||
        !state.ready ||
        event.data.length > 4_000_000
      )
        return;
      const matches = (actual: number, expected: number) =>
        Math.abs(actual - expected) < 2 ||
        Math.abs(actual - expected * state.pixelRatio) < 2;
      if (
        !matches(event.metadata.deviceWidth, state.width) ||
        !matches(event.metadata.deviceHeight, state.height)
      )
        return;
      this.publish(Buffer.from(event.data, 'base64'), state);
      if (this.outstanding && Date.now() - this.frameSent > 1000)
        void this.stop();
    };
    cdp.on('Page.screencastFrame', receive);
    this.removeListener = () => cdp.off('Page.screencastFrame', receive);
  }
  detach(): void {
    this.invalidate();
    this.removeListener?.();
    this.removeListener = undefined;
    this.cdp = undefined;
  }
  invalidate(): void {
    this.revision++;
    this.frame = undefined;
    this.dirty = true;
    this.outstanding = false;
    this.complete(null);
    void this.stop();
  }
  changed(): void {
    this.dirty = true;
  }

  async start(): Promise<void> {
    const cdp = this.cdp,
      revision = this.revision;
    if (!cdp || this.streaming || !this.state().visible || !this.state().ready)
      return;
    const operation = this.control.then(async () => {
      if (
        cdp !== this.cdp ||
        revision !== this.revision ||
        this.streaming ||
        !this.state().visible ||
        !this.state().ready
      )
        return;
      // Events may arrive before the command reply. Accept them for this start.
      this.streaming = true;
      try {
        await cdp.send('Page.startScreencast', {
          format: 'jpeg',
          quality: this.quality,
          maxWidth: this.maxWidth,
          maxHeight: this.maxHeight,
          everyNthFrame: 1,
        });
      } catch {
        this.streaming = false;
      }
    });
    this.control = operation.catch(() => undefined);
    await this.control;
  }
  async stop(): Promise<void> {
    this.streaming = false;
    const cdp = this.cdp;
    const operation = this.control.then(async () => {
      if (cdp === this.cdp) this.streaming = false;
      await cdp?.send('Page.stopScreencast').catch(() => undefined);
    });
    this.control = operation;
    await operation;
  }

  async next(
    after: number,
    signal: AbortSignal,
    waitMs = 5000,
    video: boolean | RuntimeVideoCapture = false,
  ): Promise<RuntimeFrame | null> {
    signal.throwIfAborted();
    if (this.reading) throw new Error('A frame read is already pending');
    this.reading = true;
    try {
      if (this.outstanding || video) {
        const width = typeof video === 'object' ? video.width : 1920,
          height = typeof video === 'object' ? video.height : 1440;
        this.outstanding = false;
        if (
          width !== this.maxWidth ||
          height !== this.maxHeight
        ) {
          this.maxWidth = width;
          this.maxHeight = height;
          // Encoding resolution changes do not change the logical viewport epoch.
          this.frame = undefined;
          this.dirty = true;
          await this.stop();
        }
      }
      if (!this.state().visible) return null;
      const revision = this.revision;
      await this.start();
      signal.throwIfAborted();
      if (revision !== this.revision || !this.state().visible) return null;
      if (this.frame && this.frame.sequence > after)
        return this.sent(this.frame);
      return await new Promise<RuntimeFrame | null>((resolve) => {
        let fallback: ReturnType<typeof setTimeout>;
        const waiter: Waiter = {
          after,
          resolve: (frame) => {
            clearTimeout(timer);
            clearTimeout(fallback);
            signal.removeEventListener('abort', abort);
            resolve(frame);
          },
        };
        const abort = () => {
          if (this.waiter === waiter) this.complete(null);
        };
        const timer = setTimeout(abort, waitMs);
        // Refresh the same pixel source when damage events stop. Scaled
        // screenshots temporarily emulate another viewport and can leak
        // white/stale frames into a running screencast.
        const check = () => {
          if (this.waiter !== waiter) return;
          if (Date.now() - this.lastRefresh >= (this.dirty ? 100 : 1000))
            void this.refresh();
          fallback = setTimeout(check, 100);
        };
        this.waiter = waiter;
        fallback = setTimeout(check, 100);
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
        else this.flush();
      });
    } finally {
      this.reading = false;
    }
  }
  private sent(frame: RuntimeFrame): RuntimeFrame {
    this.outstanding = true;
    this.frameSent = Date.now();
    return frame;
  }
  private publish(jpeg: Buffer, state: CaptureState): void {
    this.dirty = false;
    // Idle refreshes should not re-encode an unchanged page.
    if (
      this.frame?.displayEpoch === state.displayEpoch &&
      this.frame.jpeg.equals(jpeg)
    )
      return;
    this.frame = {
      sequence: ++this.sequence,
      width: state.width,
      height: state.height,
      pixelRatio: state.pixelRatio,
      displayEpoch: state.displayEpoch,
      jpeg,
    };
    this.flush();
  }
  private flush(): void {
    if (this.waiter && this.frame && this.frame.sequence > this.waiter.after)
      this.complete(this.sent(this.frame));
  }
  private complete(frame: RuntimeFrame | null): void {
    const waiter = this.waiter;
    this.waiter = undefined;
    waiter?.resolve(frame);
  }
  private async refresh(): Promise<void> {
    if (this.refreshPending || !this.cdp || !this.state().visible || !this.state().ready) return;
    this.lastRefresh = Date.now();
    const waiter = this.waiter, revision = this.revision;
    // Restart emits the current viewport even without further damage. Use the
    // same control lane as navigation, viewport changes and teardown.
    const refresh = this.stop().then(async () => {
      if (waiter && this.waiter === waiter && revision === this.revision) await this.start();
    }).finally(() => {
      if (this.refreshPending === refresh) this.refreshPending = undefined;
    });
    this.refreshPending = refresh;
    await refresh;
  }
}
