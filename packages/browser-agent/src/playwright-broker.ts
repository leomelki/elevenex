import { PlaywrightRoutes } from './playwright-routes.js';
import { browserPresentationCommand } from './presentation.js';
import { browserCursorCommand } from './playwright-presentation.js';
import { selectedBrowserElement, validateBrowserSelection } from './element-selection.js';
import { PlaywrightHTTP } from './playwright-http.js';
import { Readable } from 'node:stream';
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
  type APIRequestContext,
} from 'playwright-core';
import { expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import type { BrowserCodeImage } from '@elevenex/shared';
import { object, delay, type BrowserAgentHost } from './host.js';
import { PlaywrightTransport } from './playwright-transport.js';
import { BrowserArtifacts, imageSize } from './artifacts.js';
import {
  assertMethod,
  PLAYWRIGHT_METHODS,
  PLAYWRIGHT_PROPERTIES,
} from './playwright-policy.js';

interface Entry {
  readonly id: string;
  readonly type: string;
  readonly value: object;
  readonly owner?: string;
}
type Callback = (...args: unknown[]) => unknown;
import type { PlaywrightCallback } from './playwright-channel.js';

/** Delegates to real Playwright objects. The code realm sees only opaque
 * descriptors; function closures are invoked back in that realm over JSON. */
export class PlaywrightBroker {
  private readonly transport: PlaywrightTransport;
  private readonly artifacts: BrowserArtifacts;
  private browser?: Browser;
  private context?: BrowserContext;
  private opening?: Promise<void>;
  private readonly http: PlaywrightHTTP;
  private readonly entries = new Map<string, Entry>();
  private readonly identities = new WeakMap<object, string>();
  private readonly metadataSent = new Map<string, string>();
  private revision = 0;
  private readonly pageIds = new WeakMap<Page, string>();
  private readonly cleanups = new Set<() => void>();
  private readonly finalizers = new WeakMap<object, () => void>();
  private readonly subscriptions = new Set<{
    target: object;
    event: unknown;
    handler: Callback;
    cleanup(): void;
  }>();
  private failed?: (message: string) => void;
  private readonly createdRequests: import('@elevenex/shared').BrowserHumanRequest[] =
    [];
  drainRequests(): import('@elevenex/shared').BrowserHumanRequest[] {
    return this.createdRequests.splice(0);
  }
  private stopped = false;
  private readonly streams = new Map<string, AsyncIterator<unknown>>();
  private callback?: PlaywrightCallback;
  private readonly callbackFunctions = new Map<
    string,
    (...args: unknown[]) => Promise<unknown>
  >();
  private readonly routes = new PlaywrightRoutes(
    (error) =>
      this.failed?.(
        'Browser route callback failed: ' +
          (error instanceof Error ? error.message : 'unknown error'),
      ),
    (resource) => this.finalizers.get(resource)?.(),
  );
  private notify?: (updates: unknown[]) => void;
  private signal = new AbortController().signal;
  constructor(
    private readonly host: BrowserAgentHost,
    private readonly sessionId: number,
    artifactsRoot?: string,
  ) {
    this.artifacts = new BrowserArtifacts(artifactsRoot);
    this.transport = new PlaywrightTransport(host, sessionId, this.artifacts);
    this.artifacts.onViolation = (message) => this.failed?.(message);
    this.http = new PlaywrightHTTP(host, sessionId, () => {
      if (!this.context) throw new Error('Task context unavailable');
      return this.context;
    });
  }
  bind(
    callback: PlaywrightCallback,
    notify: (updates: unknown[]) => void,
    failed?: (message: string) => void,
  ): void {
    this.callback = callback;
    this.notify = notify;
    this.failed = failed;
  }
  get retained(): boolean {
    return this.cleanups.size > 0;
  }
  private assertOwner(owner?: string): void {
    this.signal.throwIfAborted();
    if (this.stopped) throw new Error('Playwright scope closed');
    if (
      owner &&
      !this.host
        .list(this.sessionId)
        .some((row) => row.id === owner && row.owned)
    )
      throw new Error(
        'Page control changed. Acquire a fresh page; a user stop requires Hand back.',
      );
  }
  private async connect(): Promise<void> {
    this.assertOwner();
    return (this.opening ??= (async () => {
      this.browser = await chromium.connectOverCDP(this.transport, {
        noDefaults: true,
        artifactsDir: await this.artifacts.root(),
        timeout: 15000,
      });
      this.context = this.browser.contexts()[0];
      if (!this.context) throw new Error('Task browser context unavailable');
      this.register(this.browser, 'Browser', undefined, 'pw:browser');
      this.register(this.context, 'BrowserContext', undefined, 'pw:context');
      this.context.setDefaultTimeout(10000);
      this.context.setDefaultNavigationTimeout(15000);
      const update = () => {
        if (!this.stopped) {
          try {
            this.notify?.(this.updates());
          } catch {
            this.failed?.('Playwright metadata exceeded its resource budget');
          }
        }
      };
      this.context.on('page', (page) => {
        void this.encode(page)
          .then(() => update())
          .catch(() => undefined);
        page.on('close', update);
        page.on('framenavigated', update);
        page.on('frameattached', update);
        page.on('framedetached', update);
      });
      for (const page of this.context.pages()) await this.encode(page);
    })());
  }
  async prepare(signal: AbortSignal): Promise<unknown[]> {
    signal.throwIfAborted();
    if (this.host.list(this.sessionId).some((row) => row.owned))
      await this.connect();
    return this.updates();
  }
  private register(
    value: object,
    type: string,
    owner?: string,
    fixedId?: string,
  ): Entry {
    const previous = this.identities.get(value);
    if (previous) {
      const old = this.entries.get(previous)!;
      if (owner && !old.owner) {
        const updated = { ...old, owner };
        this.entries.set(previous, updated);
        return updated;
      }
      return old;
    }
    if (this.entries.size >= 1024)
      throw new Error(
        'Playwright handle budget exhausted; dispose unused handles or reset code state',
      );
    const entry = { id: fixedId ?? randomUUID(), value, type, owner };
    this.entries.set(entry.id, entry);
    this.identities.set(value, entry.id);
    return entry;
  }
  private reference(value: object, type: string, owner?: string): unknown {
    const entry = this.register(value, type, owner);
    return { __pw: 'handle', id: entry.id, type };
  }
  private metadata(entry: Entry): Record<string, unknown> {
    const value = entry.value as Record<string, unknown>;
    const call = (method: string): unknown =>
      typeof value[method] === 'function'
        ? (Reflect.apply(value[method], entry.value, []) as unknown)
        : undefined;
    const ref = (object: unknown, type: string): unknown =>
      object && typeof object === 'object'
        ? this.reference(object, type, entry.owner)
        : null;
    if (entry.type === 'Page') {
      const page = entry.value as Page;
      return {
        url: page.url(),
        isClosed: page.isClosed(),
        context: { __pw: 'handle', id: 'pw:context', type: 'BrowserContext' },
        mainFrame: ref(page.mainFrame(), 'Frame'),
        frames: page.frames().map((frame) => ref(frame, 'Frame')),
      };
    }
    if (entry.type === 'BrowserContext')
      return {
        browser: { __pw: 'handle', id: 'pw:browser', type: 'Browser' },
        pages: (this.context?.pages() ?? []).map((page) => ref(page, 'Page')),
      };
    if (entry.type === 'Browser')
      return {
        isConnected: this.browser?.isConnected() ?? false,
        version: this.browser?.version() ?? '',
        contexts: [
          { __pw: 'handle', id: 'pw:context', type: 'BrowserContext' },
        ],
      };
    if (entry.type === 'Buffer')
      return {
        length: (entry.value as Buffer).length,
        byteLength: (entry.value as Buffer).length,
      };
    const result: Record<string, unknown> = {};
    const methods: Record<string, string[]> = {
      ConsoleMessage: ['type', 'text', 'location'],
      WebSocket: ['url', 'isClosed'],
      WebSocketRoute: ['url'],
      Frame: ['url', 'name', 'isDetached'],
      Request: [
        'url',
        'method',
        'headers',
        'postData',
        'resourceType',
        'isNavigationRequest',
        'failure',
      ],
      Response: [
        'url',
        'status',
        'statusText',
        'ok',
        'headers',
        'fromServiceWorker',
      ],
      Dialog: ['type', 'message', 'defaultValue'],
      Download: ['url', 'suggestedFilename'],
      APIResponse: [
        'url',
        'status',
        'statusText',
        'ok',
        'headers',
        'headersArray',
      ],
      Worker: ['url'],
      FileChooser: ['isMultiple'],
    };
    for (const method of methods[entry.type] ?? []) {
      try {
        result[method] = call(method);
      } catch {
        /* Closed resources retain their other immutable metadata. */
      }
    }
    if (entry.type === 'Frame') {
      result['page'] = ref(call('page'), 'Page');
      result['parentFrame'] = ref(call('parentFrame'), 'Frame');
      const children = call('childFrames');
      result['childFrames'] = Array.isArray(children)
        ? children.map((frame) => ref(frame, 'Frame'))
        : [];
    }
    if (entry.type === 'Request' || entry.type === 'Response') {
      try {
        result['frame'] = ref(call('frame'), 'Frame');
      } catch {
        result['frame'] = null;
      }
    }
    if (entry.type === 'Request') {
      result['redirectedFrom'] = ref(call('redirectedFrom'), 'Request');
      result['redirectedTo'] = ref(call('redirectedTo'), 'Request');
    }
    if (entry.type === 'ConsoleMessage') {
      const args = call('args');
      result['args'] = Array.isArray(args)
        ? args.map((arg) => ref(arg, 'JSHandle'))
        : [];
    }
    if (entry.type === 'Route' || entry.type === 'Response')
      result['request'] = ref(call('request'), 'Request');
    if (entry.type === 'Locator') result['page'] = ref(call('page'), 'Page');
    if (
      entry.type === 'Dialog' ||
      entry.type === 'FileChooser' ||
      entry.type === 'Download'
    )
      result['page'] = ref(call('page'), 'Page');
    if (entry.type === 'FileChooser')
      result['element'] = ref(call('element'), 'ElementHandle');
    return result;
  }
  updates(): unknown[] {
    const rows: unknown[] = [];
    for (const entry of this.entries.values()) {
      const meta = this.metadata(entry),
        serialized = JSON.stringify(meta);
      if (this.metadataSent.get(entry.id) === serialized) continue;
      this.metadataSent.set(entry.id, serialized);
      rows.push({
        __pw: 'handle',
        id: entry.id,
        type: entry.type,
        meta,
        revision: ++this.revision,
      });
    }
    if (!this.entries.has('pw:context'))
      rows.push({
        __pw: 'handle',
        id: 'pw:context',
        type: 'BrowserContext',
        meta: { pages: [] },
      });
    if (!this.entries.has('pw:browser'))
      rows.push({
        __pw: 'handle',
        id: 'pw:browser',
        type: 'Browser',
        meta: {
          contexts: [
            { __pw: 'handle', id: 'pw:context', type: 'BrowserContext' },
          ],
          isConnected: false,
        },
      });
    return rows;
  }
  private async encode(
    value: unknown,
    owner?: string,
    ancestors = new Set<object>(),
    depth = 0,
  ): Promise<unknown> {
    if (value === undefined) return { __pw: 'undefined' };
    if (typeof value === 'function')
      throw new Error('Host functions cannot cross the code boundary');
    if (value === null || typeof value !== 'object') return value;
    if (depth > 32 || ancestors.has(value))
      throw new Error(
        'Playwright data is cyclic or exceeds 32 levels; return a smaller JSON value',
      );
    const parents = new Set(ancestors);
    parents.add(value);
    const child = (item: unknown) =>
      this.encode(item, owner, parents, depth + 1);
    if (Array.isArray(value)) {
      if (value.length > 10000)
        throw new Error(
          'Playwright array exceeds 10000 items; filter in page code',
        );
      return Promise.all(value.map(child));
    }
    if (value instanceof RegExp)
      return { __pw: 'regexp', source: value.source, flags: value.flags };
    if (value instanceof URL) return { __pw: 'url', href: value.href };
    if (value instanceof Error)
      return {
        __pw: 'error',
        name: value.name,
        message: value.message,
        stack: value.stack,
      };
    if (value instanceof Date)
      return { __pw: 'date', value: value.toISOString() };
    if (Buffer.isBuffer(value) && value.length <= 65536)
      return { __pw: 'bytes', data: Array.from(value) };
    if (Object.keys(value).length > 10000)
      throw new Error('Playwright result has too many properties');
    if (
      Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null
    )
      return Object.fromEntries(
        await Promise.all(
          Object.entries(value).map(async ([key, item]) => [
            key,
            await child(item),
          ]),
        ),
      );
    const type = Buffer.isBuffer(value)
      ? 'Buffer'
      : value instanceof Readable
        ? 'Readable'
        : value.constructor?.name.replace(/^_+/u, '').replace(/\d+$/u, '');
    if (type && PLAYWRIGHT_METHODS[type]) {
      if (type === 'Page') {
        const page = value as Page;
        owner = this.pageIds.get(page) ?? (await this.transport.tabId(page));
        this.pageIds.set(page, owner);
      }
      owner = await this.owner(value, type, owner);
      return this.reference(value, type, owner);
    }
    if (value instanceof Map)
      return {
        __pw: 'map',
        entries: await Promise.all(
          [...value].map(async ([key, item]) => [key, await child(item)]),
        ),
      };
    if (
      Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null
    )
      throw new Error(`Unsupported Playwright result type ${type}`);
    return Object.fromEntries(
      await Promise.all(
        Object.entries(value).map(async ([key, item]) => [
          key,
          await child(item),
        ]),
      ),
    );
  }
  private async owner(
    value: object,
    type: string,
    inherited?: string,
  ): Promise<string | undefined> {
    if (inherited) return inherited;
    if (type === 'Page') {
      const page = value as Page;
      const id = this.pageIds.get(page) ?? (await this.transport.tabId(page));
      this.pageIds.set(page, id);
      return id;
    }
    let page: Page | undefined;
    if (
      [
        'Frame',
        'Locator',
        'FileChooser',
        'Download',
        'Dialog',
        'ConsoleMessage',
      ].includes(type)
    ) {
      const method = Reflect.get(value, 'page');
      if (typeof method === 'function')
        page = Reflect.apply(method, value, []) as Page | undefined;
    } else if (type === 'Request' || type === 'Response') {
      try {
        page = (value as import('playwright-core').Request).frame().page();
      } catch {
        /* A worker request may have no frame. */
      }
    } else if (type === 'Route') {
      try {
        page = (value as import('playwright-core').Route)
          .request()
          .frame()
          .page();
      } catch {
        /* Closed frame. */
      }
    } else if (type === 'ElementHandle')
      page = (
        await (value as import('playwright-core').ElementHandle).ownerFrame()
      )?.page();
    return page ? this.owner(page, 'Page') : undefined;
  }
  private async decode(
    value: unknown,
    owner?: string,
    depth = 0,
  ): Promise<unknown> {
    if (depth > 64) throw new Error('Playwright arguments exceed 64 levels');
    if (!value || typeof value !== 'object') return value;
    if (Array.isArray(value))
      return Promise.all(
        value.map((item) => this.decode(item, owner, depth + 1)),
      );
    const raw = object(value);
    if (raw['__pw'] === 'undefined') return undefined;
    if (raw['__pw'] === 'regexp')
      return new RegExp(String(raw['source']), String(raw['flags']));
    if (raw['__pw'] === 'date') return new Date(String(raw['value']));
    if (raw['__pw'] === 'url') return new URL(String(raw['href']));
    if (raw['__pw'] === 'bytes') {
      if (
        !Array.isArray(raw['data']) ||
        raw['data'].length > 1024 * 1024 ||
        raw['data'].some(
          (byte) =>
            typeof byte !== 'number' ||
            !Number.isInteger(byte) ||
            byte < 0 ||
            byte > 255,
        )
      )
        throw new Error('Invalid binary payload');
      return Buffer.from(raw['data'] as number[]);
    }
    if (raw['__pw'] === 'handle' || raw['__pw'] === 'plan')
      return (await this.resolve(raw)).value;
    if (raw['__pw'] === 'function') {
      if (typeof raw['id'] !== 'number' || raw['id'] < 1)
        throw new Error('Invalid callback');
      const id = raw['id'],
        key = String(id) + ':' + (owner ?? 'context');
      const cached = this.callbackFunctions.get(key);
      if (cached) return cached;
      const fn = async (...args: unknown[]) => {
        this.assertOwner(owner);
        if (!this.callback)
          throw new Error('Code callback channel unavailable');
        const encoded = await Promise.all(
          args.map((arg) => this.encode(arg, owner)),
        );
        const result = await this.callback(id, encoded, this.updates());
        this.assertOwner(owner);
        return this.decode(result, owner);
      };
      this.callbackFunctions.set(key, fn);
      return fn;
    }
    return Object.fromEntries(
      await Promise.all(
        Object.entries(raw).map(async ([key, item]) => [
          key,
          await this.decode(item, owner, depth + 1),
        ]),
      ),
    );
  }
  private async resolve(raw: Record<string, unknown>): Promise<Entry> {
    await this.connect();
    let entry = this.entries.get(String(raw['id']));
    if (!entry) throw new Error('Playwright handle expired');
    if (!entry.owner) {
      const owner = await this.owner(entry.value, entry.type);
      if (owner) {
        entry = { ...entry, owner };
        this.entries.set(entry.id, entry);
      }
    }
    this.assertOwner(entry.owner);
    if (raw['__pw'] !== 'plan') return entry;
    const steps = raw['steps'];
    if (!Array.isArray(steps) || steps.length > 64)
      throw new Error('Invalid Playwright call chain');
    let current = entry;
    for (const item of steps) {
      const step = object(item);
      if (typeof step['property'] === 'string') {
        const type = PLAYWRIGHT_PROPERTIES[current.type]?.[step['property']];
        if (!type) throw new Error('Private Playwright property');
        let value: unknown = Reflect.get(current.value, step['property']);
        if (step['property'] === 'request') value = await this.requestContext();
        if (!value || typeof value !== 'object')
          throw new Error('Playwright property unavailable');
        current = { id: '', value, type, owner: current.owner };
      } else {
        if (typeof step['method'] !== 'string' || !Array.isArray(step['args']))
          throw new Error('Invalid Playwright method');
        const result = await this.call(current, step['method'], step['args']);
        if (!result || typeof result !== 'object')
          throw new Error('Call chain does not refer to a Playwright object');
        current = {
          id: '',
          value: result,
          type:
            result.constructor?.name.replace(/^_+/u, '').replace(/\d+$/u, '') ??
            '',
          owner: current.owner,
        };
      }
    }
    return current;
  }
  private requestContext(): Promise<APIRequestContext> {
    return this.http.client();
  }
  private async fileOptions(
    type: string,
    method: string,
    args: unknown[],
  ): Promise<void> {
    const index = type === 'Page' && method === 'setInputFiles' ? 1 : 0;
    if (method === 'setInputFiles' || method === 'setFiles') {
      const files = Array.isArray(args[index])
        ? (args[index] as unknown[])
        : [args[index]];
      args[index] = await Promise.all(
        files.map(async (file) =>
          typeof file === 'string' ? this.artifacts.path(file) : file,
        ),
      );
    }
    if (method === 'routeFromHAR')
      throw new Error(
        'HAR import requires an artifact validation contract; use route handlers and fulfill data',
      );
    const optionIndex =
      method === 'fulfill' ||
      method === 'screenshot' ||
      method === 'pdf' ||
      method === 'storageState' ||
      method === 'stop' ||
      method === 'stopChunk' ||
      method === 'addScriptTag' ||
      method === 'addStyleTag' ||
      method === 'addInitScript'
        ? 0
        : -1;
    if (
      optionIndex >= 0 &&
      args[optionIndex] &&
      typeof args[optionIndex] === 'object'
    ) {
      const options = object(args[optionIndex]);
      for (const key of ['path', 'stylePath'])
        if (options[key] !== undefined)
          options[key] = await this.artifacts.path(
            options[key],
            !['fulfill', 'addScriptTag', 'addStyleTag'].includes(method),
          );
    }
    if (method === 'saveAs' || method === 'setStorageState')
      args[0] =
        typeof args[0] === 'string'
          ? await this.artifacts.path(args[0], method === 'saveAs')
          : args[0];
  }
  private async call(
    entry: Entry,
    method: string,
    encoded: unknown[],
  ): Promise<unknown> {
    assertMethod(entry.type, method);
    this.assertOwner(entry.owner);
    const source =
      encoded[0] && typeof encoded[0] === 'object' ? object(encoded[0]) : null;
    let args: unknown[];
    if (
      [
        'evaluate',
        'evaluateHandle',
        'evaluateAll',
        'waitForFunction',
        'addInitScript',
      ].includes(method) &&
      source?.['__pw'] === 'function'
    ) {
      const text = source['source'];
      if (typeof text !== 'string' || text.length > 65536)
        throw new Error('Invalid page function');
      const arg = await this.decode(encoded[1], entry.owner),
        payload = { source: text, arg };
      const run = (input: { source: string; arg: unknown }) => {
        const fn: unknown = (0, eval)('(' + input.source + ')');
        if (typeof fn !== 'function')
          throw new Error('Expected a page function');
        return Reflect.apply(fn, undefined, [input.arg]) as unknown;
      };
      const withElement = (
        element: unknown,
        input: { source: string; arg: unknown },
      ) => {
        const fn: unknown = (0, eval)('(' + input.source + ')');
        if (typeof fn !== 'function')
          throw new Error('Expected a page function');
        return Reflect.apply(fn, undefined, [element, input.arg]) as unknown;
      };
      // These trusted trampolines are serialized by Playwright and run in the
      // page, never executed against agent-provided source in the host realm.
      args = [
        entry.type === 'Locator' ||
        entry.type === 'ElementHandle' ||
        entry.type === 'JSHandle'
          ? withElement
          : run,
        payload,
        ...(await Promise.all(
          encoded.slice(2).map((item) => this.decode(item, entry.owner)),
        )),
      ];
    } else
      args = await Promise.all(
        encoded.map((item) => this.decode(item, entry.owner)),
      );
    await this.fileOptions(entry.type, method, args);
    if (entry.type === 'Tracing' && method === 'start') {
      const options = object(args[0] ?? {});
      options['sources'] = false;
      if (
        options['name'] !== undefined &&
        (typeof options['name'] !== 'string' ||
          !/^[a-zA-Z0-9_-]{1,80}$/u.test(options['name']))
      )
        throw new Error('Trace names must be simple identifiers');
      args[0] = options;
    }
    const value = Reflect.get(entry.value, method);
    if (typeof value !== 'function')
      throw new Error('Playwright member is not callable');
    if (
      ['waitForURL', 'routeWebSocket', 'toHaveURL'].includes(method) &&
      typeof args[0] === 'function'
    )
      throw new Error(
        method +
          ' requires a string or RegExp URL matcher across the code boundary. Use async waitForEvent predicates or route URL predicates instead.',
      );
    if (
      method === 'frame' &&
      args[0] &&
      typeof args[0] === 'object' &&
      typeof Reflect.get(args[0], 'url') === 'function'
    )
      throw new Error(
        'frame URL predicates require a string or RegExp; use page.frames().find() for a closure',
      );
    if (
      method === 'routeWebSocket' ||
      (entry.type === 'WebSocketRoute' &&
        ['onMessage', 'onClose'].includes(method))
    ) {
      const index = method === 'routeWebSocket' ? 1 : 0,
        handler = args[index];
      if (typeof handler !== 'function')
        throw new Error('WebSocket callbacks must be functions');
      args[index] = (...values: unknown[]) =>
        Promise.resolve(Reflect.apply(handler, undefined, values)).catch(
          async (error: unknown) => {
            if (method === 'routeWebSocket')
              await (values[0] as import('playwright-core').WebSocketRoute)
                .close()
                .catch(() => undefined);
            this.failed?.(
              'WebSocket callback failed: ' +
                (error instanceof Error ? error.message : 'unknown error'),
            );
          },
        );
    }
    if (['on', 'once'].includes(method) && typeof args[1] === 'function') {
      const handler = args[1],
        event = args[0];
      const cleanup = () => {
        Reflect.apply(
          Reflect.get(entry.value, 'off') as Callback,
          entry.value,
          [event, wrapped],
        );
        this.cleanups.delete(cleanup);
        this.subscriptions.delete(subscription);
      };
      const wrapped = (...values: unknown[]) => {
        if (method === 'once') cleanup();
        void Promise.resolve(Reflect.apply(handler, undefined, values)).catch(
          (error: unknown) => {
            if (
              !entry.owner ||
              this.host
                .list(this.sessionId)
                .some((row) => row.id === entry.owner && row.owned)
            )
              this.failed?.(
                'Browser event callback failed: ' +
                  (error instanceof Error ? error.message : 'unknown error'),
              );
          },
        );
      };
      const subscription = {
        target: entry.value,
        event,
        handler: handler as Callback,
        cleanup,
      };
      this.subscriptions.add(subscription);
      this.cleanups.add(cleanup);
      args[1] = wrapped;
    }
    if (['off', 'removeListener', 'removeAllListeners'].includes(method))
      for (const subscription of [...this.subscriptions]) {
        if (
          subscription.target === entry.value &&
          (args[0] === undefined || subscription.event === args[0]) &&
          (method === 'removeAllListeners' || subscription.handler === args[1])
        )
          subscription.cleanup();
      }
    if (entry.type === 'APIRequestContext')
      return this.http.invoke(method, args);
    if (entry.type === 'Route' && method === 'fetch') {
      const route = entry.value as import('playwright-core').Route;
      const headers = Object.fromEntries(
        Object.entries(
          object(
            object(args[0] ?? {})['headers'] ??
              (await route.request().allHeaders()),
          ),
        ).map(([key, value]) => {
          if (typeof value !== 'string')
            throw new Error('HTTP headers must be strings');
          return [key, value];
        }),
      );
      return this.http.fetch('fetch', route.request(), {
        ...object(args[0] ?? {}),
        headers,
      });
    }
    const target = entry.value as Page | BrowserContext;
    const result: unknown =
      method === 'route'
        ? await this.routes.add(
            target,
            args[0] as Parameters<PlaywrightRoutes['add']>[1],
            args[1] as Parameters<PlaywrightRoutes['add']>[2],
            args[2] as { times?: number } | undefined,
          )
        : method === 'unroute'
          ? await this.routes.remove(
              target,
              args[0] as Parameters<PlaywrightRoutes['remove']>[1],
              args[1] as Parameters<PlaywrightRoutes['remove']>[2],
            )
          : await Reflect.apply(value, entry.value, args);
    if (method === 'unrouteAll') this.routes.removedAll(target);
    if (!(entry.type === 'Page' && method === 'close'))
      this.assertOwner(entry.owner);
    if (
      result &&
      typeof result === 'object' &&
      (method !== 'route' || this.routes.has(result)) &&
      typeof Reflect.get(result, 'dispose') === 'function' &&
      /Disposable/u.test(result.constructor?.name ?? '')
    ) {
      const resource = result,
        dispose: unknown = Reflect.get(resource, 'dispose');
      const cleanup = () => {
        this.cleanups.delete(cleanup);
        this.finalizers.delete(resource);
        void Promise.resolve(
          Reflect.apply(dispose as () => Promise<void>, resource, []),
        ).catch(() => undefined);
      };
      this.cleanups.add(cleanup);
      this.finalizers.set(resource, cleanup);
    }
    if (method === 'dispose') {
      this.routes.disposed(entry.value);
      const cleanup = this.finalizers.get(entry.value);
      if (cleanup) {
        this.cleanups.delete(cleanup);
        this.finalizers.delete(entry.value);
      }
    }
    return result;
  }
  async invoke(
    raw: unknown,
    signal: AbortSignal,
    images: BrowserCodeImage[],
  ): Promise<unknown> {
    signal.throwIfAborted();
    this.assertOwner();
    const input = object(raw),
      op = input['op'];
    let result: unknown;
    if (op === 'bytes-read') {
      const bytes = await this.decode(input['value']);
      if (!Buffer.isBuffer(bytes)) throw new Error('Expected a Buffer');
      const offset = Number(input['offset'] ?? 0),
        length = Number(input['length'] ?? 65536);
      if (
        !Number.isSafeInteger(offset) ||
        offset < 0 ||
        !Number.isSafeInteger(length) ||
        length < 0 ||
        length > 65536
      )
        throw new Error('Invalid binary window');
      result = await this.encode(bytes.subarray(offset, offset + length));
    } else if (op === 'stream-next') {
      const entry = await this.resolve(object(input['target']));
      if (entry.type !== 'Readable')
        throw new Error('Expected a download stream');
      let iterator = this.streams.get(entry.id);
      if (!iterator) {
        if (this.streams.size >= 16)
          throw new Error('Download stream capacity reached');
        iterator = (entry.value as Readable)[Symbol.asyncIterator]();
        this.streams.set(entry.id, iterator);
      }
      const next = await iterator.next();
      if (next.done) this.streams.delete(entry.id);
      result = {
        done: next.done === true,
        value: await this.encode(next.value, entry.owner),
      };
    } else if (op === 'browser-step' || op === 'browser-cursor' || op === 'browser-cursor-hide') {
      const entry = await this.resolve(object(input['page']));
      if (entry.type !== 'Page' || !entry.owner) throw new Error('Browser feedback requires a controlled Playwright Page');
      const documentId = this.host.document?.(entry.owner);
      const generation = this.host.list(this.sessionId).find(row => row.id === entry.owner)?.generation;
      let command: import('@elevenex/shared').BrowserPresentationCommand;
      if (op === 'browser-step') command = browserPresentationCommand({ kind: 'step', step: await this.decode(input['step']) });
      else if (op === 'browser-cursor-hide') command = { kind: 'hide-cursor' };
      else {
        const rawTarget = object(input['target']);
        let target: { locator: import('playwright-core').Locator } | { point: unknown };
        if (rawTarget['__pw']) {
          const locator = await this.resolve(rawTarget);
          if (locator.type !== 'Locator' || locator.owner !== entry.owner) throw new Error('Cursor locator must belong to this page');
          target = { locator: locator.value as import('playwright-core').Locator };
        } else target = { point: rawTarget };
        command = await browserCursorCommand(entry.value as Page, target, await this.decode(input['options']));
      }
      this.assertOwner(entry.owner);
      await this.transport.present(entry.owner, command, documentId, generation);
      result = null;
    } else if (op === 'human-request') {
      if (!this.host.interact)
        throw new Error('This browser host does not support human requests');
      let tabId =
        typeof input['tabId'] === 'string' ? input['tabId'] : undefined;
      if (!tabId) {
        const entry = await this.resolve(object(input['page']));
        if (entry.type !== 'Page' || !entry.owner)
          throw new Error('A managed Playwright page is required');
        tabId = entry.owner;
      }
      if (input['kind'] !== 'action' && input['kind'] !== 'element')
        throw new Error('Unknown human request kind');
      if (typeof input['message'] !== 'string')
        throw new Error('Human request requires a message');
      const request = await this.host.interact(this.sessionId, {
        kind: 'request',
        tabId,
        requestKind: input['kind'],
        message: input['message'],
      });
      this.createdRequests.push(request);
      result = request;
    } else if (
      op === 'human-read' ||
      op === 'human-cancel' ||
      op === 'human-locator'
    ) {
      if (!this.host.interact || typeof input['id'] !== 'string')
        throw new Error('Human request unavailable');
      const request = await this.host.interact(this.sessionId, {
        kind: op === 'human-cancel' ? 'cancel' : 'read',
        requestId: input['id'],
      });
      const snapshot = request.status === 'completed' ? request.selection?.snapshot : undefined;
      if (snapshot?.jpeg) {
        if (images.length >= 8) throw new Error('Image output limit reached. Read the human result in a fresh browser_run call.');
        images.push({ data: snapshot.jpeg, mimeType: 'image/jpeg', width: snapshot.reference.image.width, height: snapshot.reference.image.height });
      }
      result = request.selection?.snapshot ? { ...request, selection: { ...request.selection, snapshot: { reference: request.selection.snapshot.reference, ...(request.selection.snapshot.error ? { error: request.selection.snapshot.error } : {}) } } } : request;
      if (op === 'human-locator') {
        if (request.status !== 'completed' || !request.selection)
          throw new Error('The human has not selected an element');
        if (
          this.host.document?.(request.tabId) !== request.selection.documentId
        )
          throw new Error(
            'The selected document changed; ask for a fresh selection',
          );
        const response = object(
          await this.invoke(
            { op: 'page', tabId: request.tabId },
            signal,
            images,
          ),
        );
        const entry = await this.resolve(object(response['value']));
        await validateBrowserSelection(
          await this.host.get(this.sessionId, request.tabId),
          request.selection,
        );
        result = await this.encode(await selectedBrowserElement(entry.value as Page, request.selection), request.tabId);
      }
    } else if (op === 'image') {
      const bytes = await this.decode(input['value']);
      if (!Buffer.isBuffer(bytes))
        throw new Error('emitImage requires a screenshot Buffer');
      const dimensions = imageSize(bytes);
      if (
        dimensions.width * dimensions.height > 16_000_000 ||
        bytes.length > 4 * 1024 * 1024 ||
        images.length >= 4 ||
        images.reduce((size, image) => size + image.data.length, 0) +
          Math.ceil(bytes.length / 3) * 4 >
          8 * 1024 * 1024
      )
        throw new Error(
          'Image budget exceeded; crop the screenshot or save an artifact',
        );
      images.push({ ...dimensions, data: bytes.toString('base64') });
      result = { image: images.length, ...dimensions };
    } else if (op === 'artifact-write') {
      const data = await this.decode(input['value']);
      if (typeof data !== 'string' && !Buffer.isBuffer(data))
        throw new Error('Artifact data must be text or a Buffer');
      result = await this.artifacts.write(input['name'], data);
    } else if (op === 'artifact-read')
      result = await this.artifacts.read(input['name']);
    else if (op === 'page') {
      await this.connect();
      const id = String(input['tabId']);
      await this.host.acquire?.(this.sessionId, id, signal);
      await this.transport.acquire(id);
      for (let attempts = 0; attempts < 400; attempts++) {
        for (const page of this.context!.pages()) {
          const owner =
            this.pageIds.get(page) ?? (await this.transport.tabId(page));
          this.pageIds.set(page, owner);
          if (owner === id) {
            result = page;
            break;
          }
        }
        if (result) break;
        await delay(25, signal);
      }
      if (!result) throw new Error('Page initialization timed out');
    } else if (op === 'expect') {
      const value = await this.decode(input['value']);
      result = input['poll']
        ? expect.poll(value as () => unknown)
        : expect(value);
      const entry = this.register(result as object, 'Assertion');
      result = { __pw: 'handle', id: entry.id, type: entry.type };
    } else {
      const entry = await this.resolve(object(input['target']));
      if (typeof input['method'] !== 'string' || !Array.isArray(input['args']))
        throw new Error('Invalid Playwright invocation');
      result = await this.call(entry, input['method'], input['args']);
      result = await this.encode(result, entry.owner);
    }
    if (op === 'page' || op === 'artifact-read')
      result = await this.encode(result);
    return { __pw: 'result', value: result, handles: this.updates() };
  }
  dispose(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.transport.close();
    for (const cleanup of this.cleanups) {
      try {
        cleanup();
      } catch {
        /* Already detached. */
      }
    }
    this.cleanups.clear();
    for (const entry of this.entries.values())
      if (entry.type === 'Readable') (entry.value as Readable).destroy();
    this.streams.clear();
    this.http.dispose();
    void this.browser
      ?.close()
      .catch(() => undefined)
      .finally(() => this.artifacts.dispose());
    if (!this.browser) void this.artifacts.dispose();
    this.entries.clear();
  }
}
