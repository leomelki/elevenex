import type { CDPSession } from 'patchright-core';
import { randomUUID } from 'node:crypto';

/** Runs in the private world; DOM reads only, bounded for human-facing metadata. */
const titleExpression =
  "({ url: location.href, title: document.title.replace(/\\s+/gu, ' ').trim().slice(0, 200) })";

/**
 * Owns a private CDP isolated world in one page target's top-level document.
 * Site scripts cannot see its globals or intercept its DOM reads, so passive
 * presentation work (title updates, cursor hit testing) leaves nothing a page
 * can enumerate.
 *
 * It never enables the CDP Runtime or Console domains: while a client listens
 * for console events Chromium serializes every logged value, which sites can
 * measure. Without Runtime events there are no context notifications or
 * binding callbacks, so `Page.createIsolatedWorld` resolves the world by name
 * for the current document and title changes are sampled.
 */
export class RuntimePageWorld {
  private readonly world = 'elevenex-page-' + randomUUID();
  private mainFrameId?: string;
  private context?: Promise<number>;
  private timer?: ReturnType<typeof setInterval>;
  private soon?: ReturnType<typeof setTimeout>;
  private reading = false;
  private readAgain = false;
  private published?: { url: string; title: string };
  private disposed = false;

  constructor(
    private readonly cdp: CDPSession,
    private readonly titleChanged: (url: string, title: string) => void,
    private readonly titleIntervalMs = 1000,
  ) {}

  private readonly navigated = ({
    frame,
  }: {
    frame: { id: string; parentId?: string };
  }) => {
    if (frame.parentId) return;
    this.mainFrameId = frame.id;
    this.context = undefined;
    void this.readTitle();
  };
  private readonly withinDocument = ({ frameId }: { frameId: string }) => {
    if (frameId === this.mainFrameId) void this.readTitle();
  };
  private readonly loaded = () => void this.readTitle();

  async start(): Promise<void> {
    this.cdp.on('Page.frameNavigated', this.navigated);
    this.cdp.on('Page.navigatedWithinDocument', this.withinDocument);
    this.cdp.on('Page.domContentEventFired', this.loaded);
    this.cdp.on('Page.loadEventFired', this.loaded);
    await this.cdp.send('Page.enable');
    const { frameTree } = await this.cdp.send('Page.getFrameTree');
    if (this.disposed) return;
    this.mainFrameId ??= frameTree.frame.id;
    // Same-document title changes have no protocol event without Runtime.
    this.timer = setInterval(() => void this.readTitle(), this.titleIntervalMs);
    this.timer.unref?.();
    void this.readTitle();
  }

  /** Interaction often retitles a page; sample shortly after, coalescing bursts. */
  titleMayChange(): void {
    if (this.disposed || this.soon) return;
    this.soon = setTimeout(() => {
      this.soon = undefined;
      void this.readTitle();
    }, 100);
  }

  /** Evaluates a self-contained expression against the current top-level document. */
  async evaluate(expression: string): Promise<unknown> {
    const read = async () =>
      this.cdp.send('Runtime.evaluate', {
        expression,
        contextId: await this.contextId(),
        returnByValue: true,
      });
    const reply = await read().catch(() => {
      // A navigation can retire the cached context before its event arrives.
      if (this.disposed) throw new Error('Page is unavailable');
      this.context = undefined;
      return read();
    });
    if (reply.exceptionDetails) throw new Error('Page read failed');
    return reply.result.value;
  }

  private contextId(): Promise<number> {
    const frameId = this.mainFrameId;
    if (this.disposed || !frameId)
      return Promise.reject(new Error('Page is unavailable'));
    // An existing world of this name is returned rather than recreated.
    const pending = (this.context ??= this.cdp
      .send('Page.createIsolatedWorld', { frameId, worldName: this.world })
      .then(({ executionContextId }) => executionContextId));
    pending.catch(() => {
      if (this.context === pending) this.context = undefined;
    });
    return pending;
  }

  private async readTitle(): Promise<void> {
    if (this.disposed) return;
    if (this.reading) {
      this.readAgain = true;
      return;
    }
    this.reading = true;
    try {
      const value: unknown = await this.evaluate(titleExpression);
      if (
        !this.disposed &&
        value &&
        typeof value === 'object' &&
        'url' in value &&
        typeof value.url === 'string' &&
        value.url.length <= 8192 &&
        'title' in value &&
        typeof value.title === 'string' &&
        value.title.length <= 200 &&
        (value.url !== this.published?.url ||
          value.title !== this.published.title)
      ) {
        this.published = { url: value.url, title: value.title };
        this.titleChanged(value.url, value.title);
      }
    } catch {
      // A busy or replaced document reports on the next sample.
    } finally {
      this.reading = false;
      if (this.readAgain) {
        this.readAgain = false;
        void this.readTitle();
      }
    }
  }

  /** Stops sampling synchronously; the world dies with its documents. */
  destroy(): void {
    if (this.disposed) return;
    this.disposed = true;
    clearInterval(this.timer);
    this.timer = undefined;
    clearTimeout(this.soon);
    this.soon = undefined;
    this.context = undefined;
    this.cdp.off('Page.frameNavigated', this.navigated);
    this.cdp.off('Page.navigatedWithinDocument', this.withinDocument);
    this.cdp.off('Page.domContentEventFired', this.loaded);
    this.cdp.off('Page.loadEventFired', this.loaded);
  }
}
