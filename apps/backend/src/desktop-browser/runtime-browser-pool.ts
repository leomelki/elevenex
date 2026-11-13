import { installRuntimeBrowser } from './runtime-install.js';
import {
  type BrowserContext,
  type BrowserContextOptions,
  type Page,
} from 'playwright-core';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { installDownloadPolicy } from './runtime-download-policy.js';
import { join } from 'node:path';
import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { getElevenexDataRoot } from '../config/app-data-paths.js';
import { prepareWebAuthnExtension } from './runtime-webauthn-extension.js';
import { launchRuntimeBrowser, browserLaunchOptions } from './runtime-launch.js';
import { browserStartError } from './runtime-start-error.js';

export function privateBrowserLoggingEnabled(
  environment: NodeJS.ProcessEnv,
): boolean {
  if (environment['PWDEBUG'] && environment['PWDEBUG'] !== '0') return true;
  const patterns = (environment['DEBUG'] ?? '').split(/[,\s]+/).filter(Boolean);
  const matches = (pattern: string, name: string) => {
    try {
      return new RegExp(
        '^' +
          pattern.replace(/[|\\{}()[\]^$+?.]/g, '\\$&').replace(/\*/g, '.*') +
          '$',
      ).test(name);
    } catch {
      return true;
    }
  };
  return ['pw:api', 'pw:protocol', 'pw:browser'].some(
    (name) =>
      patterns.some(
        (pattern) => !pattern.startsWith('-') && matches(pattern, name),
      ) &&
      !patterns.some(
        (pattern) => pattern.startsWith('-') && matches(pattern.slice(1), name),
      ),
  );
}
const unsafeLoggingAtLoad = privateBrowserLoggingEnabled(process.env);

/** At most four sandboxed Chromium profiles, each owned by one task over a private pipe. */
@Injectable()
export class RuntimeBrowserPool implements OnModuleDestroy {
  private readonly logger = new Logger(RuntimeBrowserPool.name);
  private readonly windowAnchors = new WeakSet<Page>();
  isWindowAnchor(page: Page): boolean { return this.windowAnchors.has(page) && !page.isClosed(); }
  private readonly applicationPorts = new Set<number>();
  reservePort(port: number | undefined): void {
    if (
      port &&
      Number.isInteger(port) &&
      port > 0 &&
      port <= 65535 &&
      this.applicationPorts.size < 16
    )
      this.applicationPorts.add(port);
  }
  isApplicationPort(port: number): boolean {
    return this.applicationPorts.has(port);
  }
  private readonly pending = new Map<string, Promise<BrowserContext>>();
  private readonly contexts = new Map<string, BrowserContext>();
  private readonly lifetime = new AbortController();
  private disposed = false;
  private readonly cleanup = new Set<Promise<void>>();
  private installation?: Promise<void>;
  private extension?: Promise<string>;
  private readonly cache = join(getElevenexDataRoot(), 'browser-runtime');
  async acquire(identity: string, contextOptions: BrowserContextOptions): Promise<BrowserContext> {
    if (!/^[a-f0-9]{64}$/.test(identity)) throw new Error('Invalid browser profile identity');
    if (unsafeLoggingAtLoad || privateBrowserLoggingEnabled(process.env))
      throw new Error(
        'Private browser streaming is unavailable while browser protocol debug logging is enabled.',
      );
    if (this.disposed) throw new Error('Browser runtime stopped');
    if (this.contexts.has(identity) || this.pending.has(identity)) throw new Error('Browser profile is already open');
    if (this.contexts.size + this.pending.size >= 4) throw new Error('Browser profile limit reached');
    const opening = this.launch(identity, contextOptions)
      .catch((error) => {
        if (this.disposed) throw new Error('Browser runtime stopped');
        const failure = browserStartError(error);
        this.logger.warn(
          `Browser startup failed: ${failure.reason}. ${failure.message}`,
        );
        if (failure.setupCommand) this.logger.warn(`Browser host recovery: ${failure.setupCommand}`);
        throw failure;
      })
      .finally(() => this.pending.delete(identity));
    this.pending.set(identity, opening);
    return opening;
  }
  private async launch(identity: string, contextOptions: BrowserContextOptions): Promise<BrowserContext> {
    // Install into application data, never a repository or a user browser profile.
    await mkdir(this.cache, { recursive: true, mode: 0o700 });
    if (this.disposed) throw new Error('Browser runtime stopped');
    const profile = join(
      getElevenexDataRoot(),
      'task-browser-profiles',
      identity,
    );
    await mkdir(profile, { recursive: true, mode: 0o700 });
    const extension = await (this.extension ??= prepareWebAuthnExtension(
      this.cache,
    ).catch((error) => {
      this.extension = undefined;
      throw error;
    }));
    const downloadsPath = await mkdtemp(join(tmpdir(), 'elevenex-downloads-'));
    const options = {
      downloadsPath,
      ...contextOptions,
      ...browserLaunchOptions(extension),
    };
    let context: BrowserContext;
    try {
      context = await launchRuntimeBrowser(
        this.cache,
        profile,
        options,
        () => this.install(),
        this.lifetime.signal,
      );
    } catch (error) {
      await rm(downloadsPath, { recursive: true, force: true });
      throw error;
    }
    context.once('close', () => {
      const operation = rm(downloadsPath, {
        recursive: true,
        force: true,
      }).catch(() => undefined);
      this.cleanup.add(operation);
      void operation.finally(() => this.cleanup.delete(operation));
    });
    try {
      if (this.disposed) throw new Error('Browser runtime stopped');
      if (contextOptions.acceptDownloads)
        await installDownloadPolicy(context, downloadsPath);
      const initialPages = context.pages();
      // macOS headless Chrome loses native pointer-lock eligibility if its last
      // window is closed. Keep one inert tab in the task-owned context so later
      // page creation/closure never tears down that native window. DOM focus
      // emulation cannot replace this platform precondition.
      const anchor =
        process.platform === 'darwin'
          ? (initialPages.find((page) => page.url() === 'about:blank') ??
            (await context.newPage()))
          : undefined;
      if (anchor) this.windowAnchors.add(anchor);
      await Promise.all(
        initialPages
          .filter((page) => page !== anchor)
          .map((page) => page.close()),
      );
      this.contexts.set(identity, context);
      context.once('close', () => {
        if (this.contexts.get(identity) === context)
          this.contexts.delete(identity);
      });
      return context;
    } catch (error) {
      await context.close().catch(() => undefined);
      await rm(downloadsPath, { recursive: true, force: true });
      throw error;
    }
  }
  private install(): Promise<void> {
    return this.installation ??= installRuntimeBrowser(this.cache, this.lifetime.signal)
      .finally(() => { this.installation = undefined; });
  }
  async onModuleDestroy(): Promise<void> {
    this.disposed = true;
    this.lifetime.abort();
    await Promise.allSettled(this.pending.values());
    await Promise.allSettled([...this.contexts.values()].map(context => context.close()));
    await Promise.all(this.cleanup);
  }
}
