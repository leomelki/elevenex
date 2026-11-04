import { installRuntimeBrowser } from './runtime-install.js';
import { chromium, type Browser } from 'playwright-core';
import { mkdir } from 'node:fs/promises';
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

/** One supervised Chromium process, a private CDP pipe, and isolated contexts per task/tab. */
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
  private pending?: Promise<Browser>;
  private browser?: Browser;
  private readonly lifetime = new AbortController();
  private disposed = false;
  private readonly cache = join(getElevenexDataRoot(), 'browser-runtime');
  async acquire(): Promise<Browser> {
    if (unsafeLoggingAtLoad || privateBrowserLoggingEnabled(process.env))
      throw new Error(
        'Private browser streaming is unavailable while browser protocol debug logging is enabled.',
      );
    if (this.disposed) throw new Error('Browser runtime stopped');
    if (this.browser?.isConnected()) return this.browser;
    return (this.pending ??= this.launch().finally(() => {
      this.pending = undefined;
    }));
  }
  private async launch(): Promise<Browser> {
    // Install into application data, never a repository or a user browser profile.
    await mkdir(this.cache, { recursive: true, mode: 0o700 });
    if (this.disposed) throw new Error('Browser runtime stopped');
    const parts = chromium.executablePath().split(sep),
      index = parts.findIndex((part) => /^chromium-[0-9]+$/.test(part));
    if (index < 0)
      throw new Error('Browser distribution is not supported on this host');
    const executablePath = join(this.cache, ...parts.slice(index));
    const options = {
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
    let browser: Browser;
    try {
      browser = await chromium.launch(options);
    } catch {
      try {
        browser = await chromium.launch({
          ...options,
          executablePath: undefined,
          channel: 'chrome',
        });
      } catch {
        await this.install();
        if (this.disposed) throw new Error('Browser runtime stopped');
        try {
          browser = await chromium.launch(options);
        } catch {
          throw new Error(
            'This host cannot start sandboxed Chromium. Its browser system libraries or OS sandbox need setup. No sandbox bypass is used.',
          );
        }
      }
    }
    if (this.disposed) {
      await browser.close();
      throw new Error('Browser runtime stopped');
    }
    this.browser = browser;
    browser.once('disconnected', () => {
      if (this.browser === browser) this.browser = undefined;
    });
    return browser;
  }
  private install(): Promise<void> {
    return installRuntimeBrowser(this.cache, this.lifetime.signal);
  }
  async onModuleDestroy(): Promise<void> {
    this.disposed = true;
    this.lifetime.abort();
    await this.pending?.catch(() => undefined);
    await this.browser?.close();
  }
}
