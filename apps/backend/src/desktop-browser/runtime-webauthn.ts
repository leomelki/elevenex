import { randomUUID } from 'node:crypto';
import type {
  BrowserContext,
  Worker,
  Page,
  Frame,
  Request,
} from 'playwright-core';
import { z } from 'zod';
import type {
  BrowserWebAuthnOptions,
  BrowserWebAuthnRequest,
  BrowserWebAuthnResult,
} from '@elevenex/shared';

const requests = z
  .array(
    z
      .object({
        requestId: z.number().int(),
        operation: z.enum(['create', 'get']),
        optionsJson: z.string().max(65536),
      })
      .strict(),
  )
  .max(1);
const denied: BrowserWebAuthnResult = {
  error: {
    name: 'NotAllowedError',
    message: 'Authentication was canceled or is unavailable.',
  },
};

/** Task-owned Chromium proxy. Only opaque handles enter state; no ceremony is
 * replayed after viewer loss, navigation, timeout or service-worker replacement. */
export class RuntimeWebAuthn {
  private worker?: Worker;
  private timer?: ReturnType<typeof setTimeout>;
  private pending?: BrowserWebAuthnOptions & { requestId: number };
  private disposed = false;
  private enabled = false;
  private platform = false;
  private generation = 0;
  private readonly consumed = new Set<number>();
  private polling?: Promise<void>;
  private context?: BrowserContext;
  private readonly pages = new Map<Page, () => void>();
  constructor(
    private readonly changed: () => void,
    private readonly presented: (origin: string) => boolean,
  ) {}
  get available(): boolean {
    return !!this.worker;
  }
  snapshot(): BrowserWebAuthnRequest | undefined {
    const item = this.pending;
    return item
      ? { id: item.id, origin: item.origin, operation: item.operation }
      : undefined;
  }
  async start(context: BrowserContext): Promise<void> {
    if (this.disposed) return;
    this.context?.off('page', this.observePage);
    for (const release of this.pages.values()) release();
    this.pages.clear();
    this.context = context;
    context.on('page', this.observePage);
    for (const page of context.pages()) this.observePage(page);
    clearTimeout(this.timer);
    await this.polling;
    const worker =
      context
        .serviceWorkers()
        .find((item) =>
          /^chrome-extension:\/\/[a-p]{32}\/relay\.js$/.test(item.url()),
        ) ??
      (await context
        .waitForEvent('serviceworker', {
          predicate: (item) =>
            /^chrome-extension:\/\/[a-p]{32}\/relay\.js$/.test(item.url()),
          timeout: 5000,
        })
        .catch(() => undefined));
    if (!worker || this.disposed) return;
    // Extension attach is asynchronous even after the worker target appears.
    for (let attempt = 0; attempt < 50; attempt++) {
      if (
        await worker
          .evaluate('globalThis.elevenexWebAuthn?.ready === true')
          .catch(() => false)
      )
        break;
      if (attempt === 49 || this.disposed) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    if (this.disposed) return;
    this.worker = worker;
    this.consumed.clear();
    await this.configure(this.enabled, this.platform);
    worker.once('close', () => {
      if (this.worker === worker) {
        this.worker = undefined;
        this.clear();
        this.changed();
      }
    });
    this.changed();
    this.schedule();
  }
  private readonly observePage = (page: Page): void => {
    if (this.disposed || this.pages.has(page)) return;
    const origins = new WeakMap<Frame, string>();
    const origin = (frame: Frame): string => {
      try {
        return new URL(frame.url()).origin;
      } catch {
        return '';
      }
    };
    for (const frame of page.frames()) origins.set(frame, origin(frame));
    const invalidate = (value: string | undefined) => {
      if (value && value === this.pending?.origin) this.clear();
    };
    const navigated = (frame: Frame) => {
      invalidate(origins.get(frame));
      origins.set(frame, origin(frame));
    };
    const detached = (frame: Frame) => invalidate(origins.get(frame));
    const navigation = (request: Request) => {
      if (request.isNavigationRequest() && request.frame() === page.mainFrame())
        invalidate(origins.get(page.mainFrame()));
    };
    const stopped = () => {
      invalidate(origins.get(page.mainFrame()));
      release();
      this.pages.delete(page);
    };
    const release = () => {
      page.off('request', navigation);
      page.off('framenavigated', navigated);
      page.off('framedetached', detached);
      page.off('close', stopped);
      page.off('crash', stopped);
    };
    page.on('request', navigation);
    page.on('framenavigated', navigated);
    page.on('framedetached', detached);
    page.on('close', stopped);
    page.on('crash', stopped);
    this.pages.set(page, release);
  };
  async configure(enabled: boolean, platform: boolean): Promise<void> {
    const changed = enabled !== this.enabled;
    this.enabled = enabled;
    this.platform = platform;
    if (!enabled) this.clear();
    await this.worker
      ?.evaluate(
        `globalThis.elevenexWebAuthn.configure(${JSON.stringify({ enabled, platform })})`,
      )
      .catch(() => undefined);
    if (changed && !this.polling) this.schedule();
  }
  clear(): void {
    this.generation++;
    const pending = this.pending;
    this.pending = undefined;
    if (pending) {
      void this.finish(pending.requestId, denied);
      this.changed();
    }
  }
  private schedule(): void {
    clearTimeout(this.timer);
    if (!this.disposed && this.worker)
      this.timer = setTimeout(
        () => {
          this.polling = this.poll()
            .catch(() => this.clear())
            .finally(() => {
              this.polling = undefined;
              this.schedule();
            });
          // Keep the MV3 worker alive with infrequent private heartbeats while no
          // viewer is attached; it must remain a rejecting proxy on remote hosts.
        },
        this.enabled ? 100 : 15000,
      );
    this.timer?.unref();
  }
  private async poll(): Promise<void> {
    const worker = this.worker;
    if (!worker) return;
    const generation = this.generation;
    await worker.evaluate(
      `globalThis.elevenexWebAuthn.configure(${JSON.stringify({ enabled: this.enabled, platform: this.platform })})`,
    );
    const items = requests.parse(
      await worker.evaluate('globalThis.elevenexWebAuthn.snapshot()'),
    );
    if (generation !== this.generation || this.disposed) return;
    if (
      this.pending &&
      (!items.some((item) => item.requestId === this.pending?.requestId) ||
        !this.presented(this.pending.origin))
    )
      this.clear();
    for (const item of items) {
      if (item.requestId === this.pending?.requestId) continue;
      if (this.consumed.has(item.requestId)) continue;
      this.consumed.add(item.requestId);
      if (this.consumed.size > 64) {
        const oldest = this.consumed.values().next();
        if (!oldest.done) this.consumed.delete(oldest.value);
      }
      try {
        const options = z
          .object({
            extensions: z.object({
              remoteDesktopClientOverride: z.object({
                origin: z.string().url().max(2048),
                sameOriginWithAncestors: z.literal(true),
              }),
            }),
          })
          .parse(JSON.parse(item.optionsJson));
        const origin = new URL(
          options.extensions.remoteDesktopClientOverride.origin,
        );
        const local =
          origin.hostname === 'localhost' ||
          origin.hostname.endsWith('.localhost') ||
          origin.hostname === '127.0.0.1' ||
          origin.hostname === '[::1]';
        if (
          (origin.protocol !== 'https:' &&
            !(origin.protocol === 'http:' && local)) ||
          origin.origin !==
            options.extensions.remoteDesktopClientOverride.origin ||
          !this.enabled ||
          !this.presented(origin.origin)
        )
          throw new Error('Unavailable origin');
        this.pending = { ...item, id: randomUUID(), origin: origin.origin };
        this.changed();
      } catch {
        await this.finish(item.requestId, denied);
      }
    }
  }
  read(id: string): BrowserWebAuthnOptions {
    const item = this.pending;
    if (
      !item ||
      item.id !== id ||
      !this.enabled ||
      !this.presented(item.origin)
    )
      throw new Error('Authentication expired');
    return {
      id: item.id,
      origin: item.origin,
      operation: item.operation,
      optionsJson: item.optionsJson,
    };
  }
  async complete(id: string, result: BrowserWebAuthnResult): Promise<void> {
    this.read(id);
    const item = this.pending!;
    // Consume before awaiting: uncertain completion is never retried.
    this.pending = undefined;
    this.changed();
    await this.finish(item.requestId, result);
  }
  private async finish(
    requestId: number,
    result: BrowserWebAuthnResult,
  ): Promise<void> {
    await this.worker
      ?.evaluate(
        `globalThis.elevenexWebAuthn.complete(${requestId}, ${JSON.stringify(result)})`,
      )
      .catch(() => undefined);
  }
  async destroy(): Promise<void> {
    this.disposed = true;
    this.context?.off('page', this.observePage);
    this.context = undefined;
    for (const release of this.pages.values()) release();
    this.pages.clear();
    this.enabled = false;
    clearTimeout(this.timer);
    this.clear();
    await this.polling;
    await this.worker
      ?.evaluate(
        'globalThis.elevenexWebAuthn.configure({enabled:false,platform:false})',
      )
      .catch(() => undefined);
    this.worker = undefined;
  }
}
