import { installRuntimeBrowser } from './runtime-install.js';
import { chromium, type BrowserContext, type BrowserContextOptions } from 'playwright-core';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { installDownloadPolicy } from './runtime-download-policy.js';
import { join, sep } from 'node:path';
import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { getElevenexDataRoot } from '../config/app-data-paths.js';

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
    const opening = this.launch(identity, contextOptions).finally(() => this.pending.delete(identity));
    this.pending.set(identity, opening);
    return opening;
  }
  private async launch(identity: string, contextOptions: BrowserContextOptions): Promise<BrowserContext> {
    // Install into application data, never a repository or a user browser profile.
    await mkdir(this.cache, { recursive: true, mode: 0o700 });
    if (this.disposed) throw new Error('Browser runtime stopped');
    const parts = chromium.executablePath().split(sep),
      index = parts.findIndex((part) => /^chromium-[0-9]+$/.test(part));
    if (index < 0)
      throw new Error('Browser distribution is not supported on this host');
    const executablePath = join(this.cache, ...parts.slice(index));
    const profile = join(getElevenexDataRoot(), 'task-browser-profiles', identity);
    await mkdir(profile, { recursive: true, mode: 0o700 });
    const downloadsPath = await mkdtemp(join(tmpdir(), 'elevenex-downloads-'));
    const options = {
      downloadsPath,
      ...contextOptions,
      executablePath,
      headless: true,
      chromiumSandbox: true,
      // The Nest application owns shutdown; Playwright must not replace its process signals.
      handleSIGINT: false,
      handleSIGTERM: false,
      handleSIGHUP: false,
      timeout: 30000,
      args: [
        '--proxy-bypass-list=<-loopback>',
        '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
      ],
    };
    let context: BrowserContext;
    try {
      context = await chromium.launchPersistentContext(profile, options);
    } catch {
      try {
        context = await chromium.launchPersistentContext(profile, {
          ...options,
          executablePath: undefined,
          channel: 'chrome',
        });
      } catch {
        try { await this.install(); }
        catch (error) { await rm(downloadsPath, { recursive: true, force: true }); throw error; }
        if (this.disposed) { await rm(downloadsPath, { recursive: true, force: true }); throw new Error('Browser runtime stopped'); }
        try {
          context = await chromium.launchPersistentContext(profile, options);
        } catch {
          await rm(downloadsPath, { recursive: true, force: true });
          throw new Error(
            'This host cannot start sandboxed Chromium. Its browser system libraries or OS sandbox need setup. No sandbox bypass is used.',
          );
        }
      }
    }
    if (contextOptions.acceptDownloads) {
      try { await installDownloadPolicy(context, downloadsPath); }
      catch (error) { await context.close(); await rm(downloadsPath, { recursive: true, force: true }); throw error; }
    }
    context.once('close', () => {
      const operation = rm(downloadsPath, { recursive: true, force: true }).catch(() => undefined);
      this.cleanup.add(operation);
      void operation.finally(() => this.cleanup.delete(operation));
    });
    if (this.disposed) {
      await context.close();
      throw new Error('Browser runtime stopped');
    }
    // Persistent Chromium starts with about:blank. Only task-owned pages may stay alive.
    await Promise.all(context.pages().map(page => page.close()));
    this.contexts.set(identity, context);
    context.once('close', () => {
      if (this.contexts.get(identity) === context) this.contexts.delete(identity);
    });
    return context;
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
