import { randomUUID } from 'node:crypto';
import type { ConnectOverCDPTransport } from 'playwright-core';
import {
  object,
  type BrowserAgentHost,
  type BrowserAgentTarget,
} from './host.js';
import type { BrowserAgentDownload } from './host.js';
import { BrowserArtifacts } from './artifacts.js';
import { copyFile, stat } from 'node:fs/promises';

interface Source {
  readonly target: BrowserAgentTarget;
  readonly targetId: string;
  readonly sessions: Set<string>;
  readonly childTargets: Set<string>;
  readonly originalInfo: Record<string, unknown>;
  unsubscribe(): void;
}
interface Session {
  readonly source: Source;
  readonly nativeId?: string;
  readonly parent?: string;
}
const PAGE_DOMAINS = new Set([
  'Accessibility',
  'Animation',
  'Audits',
  'CSS',
  'DOM',
  'DOMDebugger',
  'DOMSnapshot',
  'Emulation',
  'Fetch',
  'Input',
  'Inspector',
  'Log',
  'Network',
  'Overlay',
  'Page',
  'Performance',
  'Runtime',
  'Security',
]);
const DENIED = new Set([
  'Security.setIgnoreCertificateErrors',
  'Security.setOverrideCertificateErrors',
  'Security.handleCertificateError',
  'Page.crash',
  'Page.setWebLifecycleState',
  'Page.setDownloadBehavior',
  'Network.loadNetworkResource',
  'Network.setRequestInterception',
  'Network.continueInterceptedRequest',
  'Network.setCookie',
  'Network.setCookies',
  'Network.deleteCookies',
  'Network.getAllCookies',
  'Network.clearBrowserCookies',
  'Network.clearBrowserCache',
  'DOM.getFileInfo',
]);

/** A private, in-memory virtual browser. Chrome target/session identities never
 * confer authority: every command is resolved through this connection's map. */
export class PlaywrightTransport implements ConnectOverCDPTransport {
  onmessage?: (message: object) => void;
  onclose?: (reason?: string) => void;
  private readonly sources = new Map<string, Source>();
  private readonly sessions = new Map<string, Session>();
  private readonly browserSessions = new Set<string>();
  private readonly streams = new Map<string, string>();
  private readonly lifetime = new AbortController();
  private attaching = false;
  private creating = 0;
  private closed = false;
  private pending = 0;
  private readonly downloads = new Map<
    string,
    { source: Source; value: BrowserAgentDownload }
  >();
  private readonly opening = new Map<string, Promise<Source>>();
  private readonly stopWatching?: () => void;
  constructor(
    private readonly host: BrowserAgentHost,
    readonly sessionId: number,
    private readonly artifacts?: BrowserArtifacts,
  ) {
    this.stopWatching = host.watch?.(() => this.synchronize());
  }
  private synchronize(): void {
    if (this.closed || !this.attaching) return;
    try {
      for (const source of [...this.sources.values()]) {
        try {
          source.target.assert();
        } catch {
          this.remove(source);
        }
      }
      if (this.creating) return;
      for (const row of this.host.list(this.sessionId))
        if (
          row.owned &&
          ![...this.sources.values()].some(
            (source) => source.target.id === row.id,
          )
        )
          void this.attach(row.id).catch(() => undefined);
    } catch {
      this.close();
    }
  }
  send(message: object): void {
    const input = object(message);
    if (this.closed) return;
    if (this.pending >= 128) {
      this.respond(input, undefined, 'Protocol capacity exceeded');
      return;
    }
    this.pending++;
    void this.dispatch(input)
      .then(
        (result) => this.respond(input, result),
        (error: unknown) =>
          this.respond(
            input,
            undefined,
            error instanceof Error
              ? error.message
              : 'Protocol operation failed',
          ),
      )
      .finally(() => this.pending--);
  }
  private emit(method: string, params: unknown, sessionId?: string): void {
    if (!this.closed)
      this.onmessage?.({ method, params, ...(sessionId ? { sessionId } : {}) });
  }
  private respond(
    input: Record<string, unknown>,
    result?: unknown,
    error?: string,
  ): void {
    if (this.closed) return;
    if (Buffer.byteLength(JSON.stringify(result ?? null)) > 8 * 1024 * 1024) {
      error = 'Protocol reply exceeds 8 MiB; request a smaller result';
      result = undefined;
    }
    this.onmessage?.({
      id: input['id'],
      ...(input['sessionId'] ? { sessionId: input['sessionId'] } : {}),
      ...(error
        ? { error: { code: -32000, message: error } }
        : { result: result ?? {} }),
    });
  }
  private async attach(
    tabId: string,
    provided?: BrowserAgentTarget,
  ): Promise<Source> {
    const cached = [...this.sources.values()].find(
      (source) => source.target.id === tabId,
    );
    if (cached) {
      cached.target.assert();
      if (provided && provided !== cached.target) await provided.dispose?.();
      return cached;
    }
    const pending = this.opening.get(tabId);
    if (pending) {
      const source = await pending;
      if (provided && provided !== source.target) await provided.dispose?.();
      return source;
    }
    const operation = this.attachTarget(tabId, provided).finally(() =>
      this.opening.delete(tabId),
    );
    this.opening.set(tabId, operation);
    return operation;
  }
  private async attachTarget(
    tabId: string,
    provided?: BrowserAgentTarget,
  ): Promise<Source> {
    this.lifetime.signal.throwIfAborted();
    const target = provided ?? (await this.host.get(this.sessionId, tabId));
    try {
      target.assert();
      this.lifetime.signal.throwIfAborted();
      await target.playwright?.();
      const info = object(
        object(await target.send('Target.getTargetInfo', {}))['targetInfo'],
      );
      if (typeof info['targetId'] !== 'string')
        throw new Error('Missing task target identity');
      target.assert();
      this.lifetime.signal.throwIfAborted();
      const source: Source = {
        target,
        targetId: info['targetId'],
        sessions: new Set(),
        childTargets: new Set(),
        originalInfo: info,
        unsubscribe: () => undefined,
      };
      this.sources.set(source.targetId, source);
      const stop = target.subscribe((method, params, nativeId) =>
        this.event(source, method, params, nativeId),
      );
      const stopDownloads = this.artifacts
        ? target.subscribeDownloads?.((download) =>
            this.download(source, download),
          )
        : undefined;
      source.unsubscribe = () => {
        stop();
        stopDownloads?.();
      };
      if (this.attaching) this.rootSession(source);
      return source;
    } catch (error) {
      await target.dispose?.();
      throw error;
    }
  }
  private info(source: Source): object {
    const row = this.host
      .list(this.sessionId)
      .find((row) => row.id === source.target.id);
    return {
      targetId: source.targetId,
      type: 'page',
      title: '',
      url: row?.url || 'about:blank',
      attached: true,
      browserContextId: 'elevenex-task',
      canAccessOpener: !!source.originalInfo['canAccessOpener'],
      ...(typeof source.originalInfo['openerId'] === 'string' &&
      this.sources.has(source.originalInfo['openerId'])
        ? { openerId: source.originalInfo['openerId'] }
        : {}),
    };
  }
  private rootSession(source: Source, parent?: string): string {
    const id = randomUUID();
    this.sessions.set(id, { source, ...(parent ? { parent } : {}) });
    source.sessions.add(id);
    this.emit(
      'Target.attachedToTarget',
      {
        sessionId: id,
        targetInfo: this.info(source),
        waitingForDebugger: false,
      },
      parent,
    );
    return id;
  }
  private event(
    source: Source,
    method: string,
    raw: unknown,
    nativeId?: string,
  ): void {
    try {
      source.target.assert();
    } catch {
      this.remove(source);
      return;
    }
    if (method === 'Elevenex.controlRevoked') {
      this.remove(source);
      return;
    }
    for (const [id, session] of this.sessions) {
      if (session.source !== source || session.nativeId !== nativeId) continue;
      if (method === 'Target.attachedToTarget') {
        const params = object(raw),
          targetInfo = object(params['targetInfo']);
        if (
          typeof params['sessionId'] !== 'string' ||
          typeof targetInfo['targetId'] !== 'string' ||
          !['iframe', 'worker'].includes(String(targetInfo['type']))
        )
          continue;
        const childId = randomUUID();
        source.childTargets.add(targetInfo['targetId']);
        this.sessions.set(childId, {
          source,
          nativeId: params['sessionId'],
          parent: id,
        });
        source.sessions.add(childId);
        this.emit(
          method,
          {
            ...params,
            sessionId: childId,
            targetInfo: { ...targetInfo, browserContextId: 'elevenex-task' },
          },
          id,
        );
      } else if (method === 'Target.detachedFromTarget') {
        const params = object(raw);
        for (const [childId, child] of this.sessions)
          if (
            child.source === source &&
            child.nativeId === params['sessionId'] &&
            child.parent === id
          ) {
            this.sessions.delete(childId);
            source.sessions.delete(childId);
            this.emit(method, { ...params, sessionId: childId }, id);
          }
      } else this.emit(method, raw, id);
    }
  }
  private assertContext(): Source {
    const rows = this.host.list(this.sessionId);
    if (rows.some((row) => !row.owned && (row.populated ?? !!row.url)))
      throw new Error(
        'Task-wide profile operations require control of every populated task tab',
      );
    const source = [...this.sources.values()][0];
    if (!source) throw new Error('Open a task page first');
    source.target.assert();
    return source;
  }
  private download(source: Source, value: BrowserAgentDownload): void {
    if (!this.artifacts || this.closed || !this.sources.has(source.targetId)) {
      void value.cancel().catch(() => undefined);
      return;
    }
    const guid = randomUUID();
    this.downloads.set(guid, { source, value });
    this.emit('Browser.downloadWillBegin', {
      frameId: source.targetId,
      guid,
      url: value.url,
      suggestedFilename: value.filename,
    });
    void value
      .path()
      .then(async (path) => {
        source.target.assert();
        const size = (await stat(path)).size;
        if (size > 32 * 1024 * 1024) throw new Error('Download exceeds 32 MiB');
        await copyFile(path, await this.artifacts!.path(guid, true));
        source.target.assert();
        this.emit('Browser.downloadProgress', {
          guid,
          state: 'completed',
          totalBytes: size,
          receivedBytes: size,
        });
      })
      .catch(() => {
        this.emit('Browser.downloadProgress', {
          guid,
          state: 'canceled',
          totalBytes: 0,
          receivedBytes: 0,
        });
      })
      .finally(() => {
        this.downloads.delete(guid);
        void value.dispose().catch(() => undefined);
      });
  }
  private async dispatch(input: Record<string, unknown>): Promise<unknown> {
    if (typeof input['method'] !== 'string' || typeof input['id'] !== 'number')
      throw new Error('Invalid protocol message');
    const method = input['method'],
      params = object(input['params'] ?? {});
    if (Buffer.byteLength(JSON.stringify(params)) > 2 * 1024 * 1024)
      throw new Error('Protocol parameters exceed 2 MiB');
    if (
      input['sessionId'] &&
      !this.browserSessions.has(String(input['sessionId']))
    ) {
      const session = this.sessions.get(String(input['sessionId']));
      if (!session) throw new Error('Page authority expired');
      const { source, nativeId } = session;
      try {
        source.target.assert();
      } catch (error) {
        this.remove(source);
        throw error;
      }
      if (method === 'Target.getTargetInfo')
        return { targetInfo: this.info(source) };
      if (method === 'Target.setAutoAttach')
        return source.target.send(
          method,
          {
            ...params,
            filter: [{ type: 'iframe' }, { type: 'worker' }, { exclude: true }],
            flatten: true,
          },
          nativeId,
        );
      if (method === 'Target.setDiscoverTargets') return {};
      if (method === 'IO.read' || method === 'IO.close') {
        const handle = String(params['handle']);
        if (this.streams.get(handle) !== input['sessionId'])
          throw new Error(
            'Protocol stream does not belong to this page session',
          );
        if (method === 'IO.close') this.streams.delete(handle);
        else
          params['size'] = Math.min(
            65536,
            typeof params['size'] === 'number' && params['size'] > 0
              ? params['size']
              : 65536,
          );
        return source.target.send(method, params, nativeId);
      }
      if (
        method.startsWith('Target.') ||
        method.startsWith('Browser.') ||
        DENIED.has(method) ||
        !PAGE_DOMAINS.has(method.split('.')[0]!)
      )
        throw new Error(
          `Protocol method outside task-page authority: ${method}`,
        );
      if (method === 'Emulation.setDeviceMetricsOverride') {
        const width = Number(params['width']),
          height = Number(params['height']),
          dpr = Number(params['deviceScaleFactor']);
        if (
          ![width, height, dpr].every(Number.isFinite) ||
          width < 0 ||
          height < 0 ||
          width > 8192 ||
          height > 16384 ||
          width * height > 16000000 ||
          dpr < 0 ||
          dpr > 2
        )
          throw new Error('Viewport resource budget exceeded');
      }
      if (method === 'Page.captureScreenshot' && params['clip']) {
        const clip = object(params['clip']),
          width = Number(clip['width']),
          height = Number(clip['height']),
          scale = Number(clip['scale'] ?? 1);
        if (
          ![width, height, scale].every(Number.isFinite) ||
          width <= 0 ||
          height <= 0 ||
          scale <= 0 ||
          scale > 2 ||
          width * height * scale * scale > 16000000
        )
          throw new Error('Screenshot pixel budget exceeded; use a clip');
      }
      if (method === 'Network.enable') {
        params['maxTotalBufferSize'] = 8388608;
        params['maxResourceBufferSize'] = 4194304;
      }
      if (method === 'Network.getCookies') this.assertContext();
      if (method === 'DOM.setFileInputFiles') {
        if (
          !this.artifacts ||
          !Array.isArray(params['files']) ||
          params['files'].length > 32
        )
          throw new Error('Uploads require confined artifacts');
        params['files'] = await Promise.all(
          params['files'].map((file) => this.artifacts!.path(file)),
        );
      }
      if (method === 'Page.navigate') {
        if (typeof params['url'] !== 'string')
          throw new Error('Invalid navigation URL');
        if (params['url'] !== 'about:blank')
          await source.target.authorize?.(params['url'], this.lifetime.signal);
      }
      const result = await source.target.send(method, params, nativeId);
      if (method === 'Page.printToPDF') {
        const stream = object(result)['stream'];
        if (typeof stream === 'string')
          this.streams.set(stream, String(input['sessionId']));
      }
      source.target.assert();
      return result;
    }
    if (method === 'Browser.getVersion') {
      const version = (await this.host.version?.()) ?? '140.0.0.0';
      return {
        protocolVersion: '1.3',
        product: `Chrome/${version}`,
        revision: '',
        jsVersion: '',
        userAgent: `Mozilla/5.0 (${process.platform === 'darwin' ? 'Macintosh' : process.platform === 'win32' ? 'Windows' : 'Linux'}) Chrome/${version}`,
      };
    }
    if (method === 'Target.setAutoAttach') {
      this.attaching = true;
      for (const row of this.host.list(this.sessionId))
        if (row.owned) await this.attach(row.id);
      return {};
    }
    if (method === 'Target.getTargetInfo')
      return {
        targetInfo: {
          targetId: 'elevenex-browser',
          type: 'browser',
          title: '',
          url: '',
          attached: true,
        },
      };
    if (method === 'Target.attachToBrowserTarget') {
      const id = randomUUID();
      this.browserSessions.add(id);
      return { sessionId: id };
    }
    if (method === 'Target.getTargets')
      return {
        targetInfos: [...this.sources.values()].map((source) =>
          this.info(source),
        ),
      };
    if (method === 'Target.attachToTarget') {
      const source = this.sources.get(String(params['targetId']));
      if (!source)
        throw new Error('Target does not belong to this conversation');
      source.target.assert();
      return {
        sessionId: this.rootSession(
          source,
          typeof input['sessionId'] === 'string'
            ? input['sessionId']
            : undefined,
        ),
      };
    }
    if (method === 'Target.detachFromTarget') {
      const id = String(params['sessionId']),
        session = this.sessions.get(id);
      if (!session) throw new Error('Unknown session');
      this.sessions.delete(id);
      session.source.sessions.delete(id);
      this.emit(
        'Target.detachedFromTarget',
        { sessionId: id, targetId: session.source.targetId },
        session.parent,
      );
      return {};
    }
    if (method === 'Target.createTarget') {
      this.creating++;
      try {
        if (
          params['browserContextId'] !== undefined &&
          params['browserContextId'] !== 'elevenex-task'
        )
          throw new Error('Foreign browser context');
        const target = await (this.host.newPage
          ? this.host.newPage(this.sessionId, this.lifetime.signal)
          : this.host.open(
              this.sessionId,
              'about:blank',
              this.lifetime.signal,
            ));
        const source = await this.attach(target.id, target);
        if (params['url'] && params['url'] !== 'about:blank') {
          await source.target.authorize?.(
            String(params['url']),
            this.lifetime.signal,
          );
          await source.target.send('Page.navigate', { url: params['url'] });
        }
        return { targetId: source.targetId };
      } finally {
        this.creating--;
        this.synchronize();
      }
    }
    if (method === 'Target.closeTarget') {
      const source = this.sources.get(String(params['targetId']));
      if (!source) throw new Error('Foreign task target');
      source.target.assert();
      await source.target.close();
      this.remove(source);
      return { success: true };
    }
    if (method === 'Browser.getWindowForTarget') {
      const source = this.sources.get(String(params['targetId']));
      if (!source) throw new Error('Foreign task target');
      source.target.assert();
      return {
        windowId: [...this.sources.keys()].indexOf(source.targetId) + 1,
        bounds: {
          left: 0,
          top: 0,
          width: 1280,
          height: 800,
          windowState: 'normal',
        },
      };
    }
    if (
      method === 'Browser.setWindowBounds' ||
      method === 'Browser.setDownloadBehavior'
    )
      return {};
    if (method === 'Browser.cancelDownload') {
      const download = this.downloads.get(String(params['guid']));
      if (!download) return {};
      download.source.target.assert();
      await download.value.cancel();
      return {};
    }
    if (method === 'Browser.close') {
      queueMicrotask(() => this.close());
      return {};
    }
    if (
      [
        'Storage.getCookies',
        'Storage.setCookies',
        'Storage.clearCookies',
      ].includes(method)
    ) {
      const rows = this.host.list(this.sessionId);
      if (rows.some((row) => !row.owned && (row.populated ?? !!row.url)))
        throw new Error(
          'Task-wide profile operations require control of populated tabs',
        );
      const source = [...this.sources.values()][0];
      if (source) {
        source.target.assert();
        if (method === 'Storage.getCookies')
          return source.target.send('Network.getAllCookies', {});
        if (method === 'Storage.setCookies')
          return source.target.send('Network.setCookies', {
            cookies: params['cookies'],
          });
        return source.target.send('Network.clearBrowserCookies', {});
      }
      const profile = this.host.profile;
      if (!profile)
        throw new Error(
          'Open a managed task page before accessing its profile',
        );
      if (method === 'Storage.getCookies')
        return { cookies: await profile.cookies() };
      if (method === 'Storage.clearCookies') {
        await profile.clearCookies();
        return {};
      }
      if (!Array.isArray(params['cookies']))
        throw new Error('Invalid cookie list');
      await profile.addCookies(
        params['cookies'] as Parameters<
          NonNullable<BrowserAgentHost['profile']>['addCookies']
        >[0],
      );
      return {};
    }
    throw new Error(
      `Browser operation outside the Elevenex task scope: ${method}`,
    );
  }
  async tabId(page: import('playwright-core').Page): Promise<string> {
    const session = await page.context().newCDPSession(page);
    try {
      const info = object(
        object(await session.send('Target.getTargetInfo'))['targetInfo'],
      );
      const source = this.sources.get(String(info['targetId']));
      if (!source) throw new Error('Page authority expired');
      source.target.assert();
      return source.target.id;
    } finally {
      await session.detach();
    }
  }
  async acquire(tabId: string): Promise<string> {
    return (await this.attach(tabId)).targetId;
  }
  private remove(source: Source): void {
    if (this.sources.get(source.targetId) !== source) return;
    this.sources.delete(source.targetId);
    source.unsubscribe();
    for (const [handle, session] of this.streams)
      if (source.sessions.has(session)) this.streams.delete(handle);
    for (const download of this.downloads.values())
      if (download.source === source)
        void download.value.cancel().catch(() => undefined);
    for (const id of source.sessions) {
      const session = this.sessions.get(id);
      this.sessions.delete(id);
      this.emit(
        'Target.detachedFromTarget',
        { sessionId: id, targetId: source.targetId },
        session?.parent,
      );
    }
    source.sessions.clear();
    void Promise.resolve()
      .then(() => source.target.dispose?.())
      .catch(() => undefined);
  }
  close(): void {
    if (this.closed) return;
    this.stopWatching?.();
    for (const source of [...this.sources.values()]) this.remove(source);
    this.closed = true;
    this.lifetime.abort();
    this.onclose?.('Task Playwright connection closed');
  }
}
