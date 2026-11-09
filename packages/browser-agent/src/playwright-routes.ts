import type { BrowserContext, Page, Request, Route } from 'playwright-core';

type Routable = Page | BrowserContext;
type Matcher = string | RegExp | ((url: URL) => Promise<unknown>);
type Handler = (route: Route, request: Request) => Promise<unknown>;
interface Registration {
  readonly target: Routable;
  readonly matcher: Matcher;
  readonly handler: Handler;
  readonly url: string | RegExp;
  readonly wrapped: Handler;
  resource?: object;
}

/** Playwright's URL matcher is synchronous. Keep closures in the code realm by
 * testing callback matchers in an async route handler, then falling back to the
 * next real Playwright route. This also preserves matching-only `times`. */
export class PlaywrightRoutes {
  private readonly registrations = new Set<Registration>();
  constructor(
    private readonly failed: (error: unknown) => void,
    private readonly onRemoved: (resource: object) => void,
  ) {}
  private forget(row: Registration): void {
    this.registrations.delete(row);
    if (row.resource) this.onRemoved(row.resource);
  }
  has(resource: object): boolean {
    return [...this.registrations].some((row) => row.resource === resource);
  }
  disposed(resource: object): void {
    for (const row of this.registrations)
      if (row.resource === resource) this.registrations.delete(row);
  }
  async add(
    target: Routable,
    matcher: Matcher,
    handler: Handler,
    options?: { times?: number },
  ): ReturnType<Routable['route']> {
    if (
      typeof handler !== 'function' ||
      (typeof matcher !== 'string' &&
        typeof matcher !== 'function' &&
        !(matcher instanceof RegExp))
    )
      throw new Error('route requires a URL matcher and callback');
    if (
      options?.times !== undefined &&
      (!Number.isSafeInteger(options.times) || options.times < 1)
    )
      throw new Error('route times must be a positive integer');
    const url = typeof matcher === 'function' ? '**/*' : matcher;
    let remaining = options?.times;
    const wrapped: Handler = async (route, request) => {
      try {
        if (typeof matcher === 'function') {
          if (!(await matcher(new URL(request.url())))) {
            await route.fallback();
            return;
          }
        }
        if (remaining !== undefined && remaining <= 0) {
          await route.fallback();
          return;
        }
        if (remaining !== undefined && --remaining === 0) {
          this.forget(registration);
          await target.unroute(url, wrapped);
        }
        await handler(route, request);
      } catch (error) {
        await route.abort().catch(() => undefined);
        this.failed(error);
      }
    };
    const registration: Registration = {
      target,
      matcher,
      handler,
      url,
      wrapped,
    };
    this.registrations.add(registration);
    try {
      const resource = await target.route(url, wrapped);
      registration.resource = resource;
      return resource;
    } catch (error) {
      this.registrations.delete(registration);
      throw error;
    }
  }
  async remove(
    target: Routable,
    matcher: Matcher,
    handler?: Handler,
  ): Promise<void> {
    for (const row of [...this.registrations])
      if (
        row.target === target &&
        (row.matcher === matcher ||
          (row.matcher instanceof RegExp &&
            matcher instanceof RegExp &&
            String(row.matcher) === String(matcher))) &&
        (!handler || row.handler === handler)
      ) {
        this.forget(row);
        await target.unroute(row.url, row.wrapped);
      }
  }
  removedAll(target: Routable): void {
    for (const row of this.registrations)
      if (row.target === target) this.forget(row);
  }
}
