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
  private snapshotPending?: Promise<void>;
  private lastSnapshot = -Infinity;
  private dirty = true;
  private outstanding = false;
  private frameSent = 0;
  private quality = 85;
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
        const elapsed = Date.now() - this.frameSent,
          quality = video ? 95 : elapsed > 250 ? 65 : 85,
          width =
            typeof video === 'object'
              ? video.width
              : video
                ? 1920
                : elapsed > 250
                  ? 1280
                  : 1920,
          height = typeof video === 'object' ? video.height : 1440;
        this.outstanding = false;
        if (
          quality !== this.quality ||
          width !== this.maxWidth ||
          height !== this.maxHeight
        ) {
          this.quality = quality;
          this.maxWidth = width;
          this.maxHeight = height;
          // Encoding quality changes do not change the logical viewport epoch.
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
        // Damage events can stop on static pages, navigation or compositor stalls.
        // A bounded, coalesced screenshot watchdog ensures eventual freshness.
        const check = () => {
          if (this.waiter !== waiter) return;
          if (this.dirty || Date.now() - this.lastSnapshot >= 1000)
            void this.snapshot();
          fallback = setTimeout(check, 100);
        };
        this.waiter = waiter;
        fallback = setTimeout(check, this.dirty ? 0 : 100);
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
    // Idle watchdogs should not re-encode an unchanged page.
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
  private async snapshot(): Promise<void> {
    const cdp = this.cdp,
      state = this.state(),
      revision = this.revision,
      sequence = this.sequence;
    if (this.snapshotPending || !cdp || !state.visible || !state.ready) return;
    this.lastSnapshot = Date.now();
    const capture = cdp
      .send('Page.captureScreenshot', {
        format: 'jpeg',
        quality: this.quality,
        captureBeyondViewport: false,
        fromSurface: true,
        clip: {
          x: 0,
          y: 0,
          width: state.width,
          height: state.height,
          scale: Math.min(
            1,
            this.maxWidth / (state.width * state.pixelRatio),
            this.maxHeight / (state.height * state.pixelRatio),
          ),
        },
      })
      .then((reply) => {
        if (
          cdp !== this.cdp ||
          revision !== this.revision ||
          !this.state().visible ||
          !this.state().ready ||
          sequence !== this.sequence ||
          reply.data.length > 4_000_000
        )
          return;
        this.publish(Buffer.from(reply.data, 'base64'), state);
      })
      .catch(() => undefined)
      .finally(() => {
        if (this.snapshotPending === capture) this.snapshotPending = undefined;
      });
    this.snapshotPending = capture;
    await capture;
  }
}
