import {
  request,
  type BrowserContext,
  type APIRequestContext,
  type Cookie,
  type APIResponse,
} from 'playwright-core';
import type { BrowserAgentHost } from './host.js';
import { object } from './host.js';

function key(cookie: Cookie): string {
  return JSON.stringify([
    cookie.name,
    cookie.domain,
    cookie.path,
    cookie.partitionKey ?? null,
  ]);
}
function equal(cookie: Cookie | undefined): string {
  return JSON.stringify(
    cookie
      ? [
          cookie.name,
          cookie.value,
          cookie.domain,
          cookie.path,
          cookie.expires,
          cookie.httpOnly,
          cookie.secure,
          cookie.sameSite,
          cookie.partitionKey ?? null,
        ]
      : null,
  );
}
function snapshot(cookies: readonly Cookie[]): string {
  return JSON.stringify(
    [...cookies].sort((a, b) => key(a).localeCompare(key(b))).map(equal),
  );
}

/** Node-side Playwright HTTP must use the task SOCKS policy, not the host's
 * unrestricted network. Cookie snapshots are reconciled without replacing
 * concurrent browser changes. Every response/context belongs to this scope. */
export class PlaywrightHTTP {
  private current?: { api: APIRequestContext; cookieHash: string };
  private readonly contexts = new Set<APIRequestContext>();
  private closed = false;
  constructor(
    private readonly host: BrowserAgentHost,
    private readonly sessionId: number,
    private readonly context: () => BrowserContext,
  ) {}
  private assertAuthority(): void {
    if (
      this.closed ||
      this.host
        .list(this.sessionId)
        .some((row) => !row.owned && (row.populated ?? !!row.url))
    )
      throw new Error(
        'Task-wide HTTP/cookie operations require control of populated task tabs',
      );
  }
  async client(): Promise<APIRequestContext> {
    this.assertAuthority();
    const cookies = await this.context().cookies(),
      hash = snapshot(cookies);
    if (this.current?.cookieHash === hash) return this.current.api;
    if (this.contexts.size >= 32)
      throw new Error(
        'HTTP context capacity reached; reset code state after disposing unused responses',
      );
    const proxy = await this.host.proxy?.();
    if (!proxy) throw new Error('Task-confined HTTP transport is unavailable');
    const api = await request.newContext({
      proxy: { server: proxy },
      storageState: { cookies, origins: [] },
      timeout: 15000,
      ignoreHTTPSErrors: false,
    });
    if (this.closed) {
      await api.dispose();
      throw new Error('HTTP scope closed');
    }
    this.contexts.add(api);
    this.current = { api, cookieHash: hash };
    return api;
  }
  async fetch(
    method: string,
    first: unknown,
    options: Record<string, unknown>,
  ): Promise<APIResponse> {
    this.assertAuthority();
    if (options['ignoreHTTPSErrors'] === true)
      throw new Error('TLS validation cannot be disabled');
    const url =
      typeof first === 'string'
        ? first
        : first &&
            typeof first === 'object' &&
            typeof Reflect.get(first, 'url') === 'function'
          ? Reflect.apply(Reflect.get(first, 'url') as () => string, first, [])
          : null;
    if (typeof url !== 'string')
      throw new Error(
        'HTTP request requires an absolute URL or a Playwright Request',
      );
    await this.host.authorizeUrl?.(url, new AbortController().signal);
    const before = await this.context().cookies(),
      api = await this.client();
    const fn: unknown = Reflect.get(api, method);
    if (typeof fn !== 'function') throw new Error('Unknown HTTP method');
    const result: APIResponse = (await Reflect.apply(fn, api, [
      first,
      options,
    ])) as APIResponse;
    this.assertAuthority();
    const after = (await api.storageState()).cookies,
      current = await this.context().cookies();
    const initial = new Map(before.map((cookie) => [key(cookie), cookie])),
      latest = new Map(current.map((cookie) => [key(cookie), cookie])),
      final = new Map(after.map((cookie) => [key(cookie), cookie]));
    const updates: Cookie[] = [];
    for (const [id, cookie] of final)
      if (
        equal(cookie) !== equal(initial.get(id)) &&
        equal(latest.get(id)) === equal(initial.get(id))
      )
        updates.push(cookie);
    for (const [id, cookie] of initial)
      if (!final.has(id) && equal(latest.get(id)) === equal(cookie))
        await this.context().clearCookies({
          name: cookie.name,
          domain: cookie.domain,
          path: cookie.path,
        });
    if (updates.length) await this.context().addCookies(updates);
    const merged = await this.context().cookies();
    if (this.current?.api === api && snapshot(merged) === snapshot(after))
      this.current.cookieHash = snapshot(merged);
    return result;
  }
  async invoke(method: string, args: unknown[]): Promise<unknown> {
    if (method === 'storageState')
      return (await this.client()).storageState(object(args[0] ?? {}));
    return this.fetch(method, args[0], object(args[1] ?? {}));
  }
  dispose(): void {
    this.closed = true;
    for (const api of this.contexts) void api.dispose().catch(() => undefined);
    this.contexts.clear();
    this.current = undefined;
  }
}
