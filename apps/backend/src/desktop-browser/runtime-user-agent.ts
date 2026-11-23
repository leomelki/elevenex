import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

/** Chrome's reduced User-Agent freezes the platform token per operating system,
 * independent of the actual OS release or CPU architecture, and always reports
 * `<major>.0.0.0`. https://www.chromium.org/updates/ua-reduction/ */
const reducedPlatformTokens: Partial<Record<NodeJS.Platform, string>> = {
  darwin: 'Macintosh; Intel Mac OS X 10_15_7',
  linux: 'X11; Linux x86_64',
  win32: 'Windows NT 10.0; Win64; x64',
};

/** The string a windowed Chrome of this major version sends on this platform. */
export function chromeUserAgent(
  major: number,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  const token = reducedPlatformTokens[platform];
  if (!token || !Number.isSafeInteger(major) || major <= 0) return undefined;
  return `Mozilla/5.0 (${token}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
}

export function chromeMajorVersion(
  version: string | undefined,
): number | undefined {
  const major = /^(\d+)\./.exec(version ?? '')?.[1];
  return major === undefined ? undefined : Number(major);
}

/** The Chromium build pinned by the locked Patchright driver, without starting it. */
export async function pinnedChromiumMajor(): Promise<number | undefined> {
  try {
    const root = dirname(
      createRequire(__filename).resolve('patchright-core/package.json'),
    );
    const catalog: unknown = JSON.parse(
      await readFile(join(root, 'browsers.json'), 'utf8'),
    );
    if (
      !catalog ||
      typeof catalog !== 'object' ||
      !('browsers' in catalog) ||
      !Array.isArray(catalog.browsers)
    )
      return undefined;
    for (const entry of catalog.browsers as unknown[])
      if (
        entry &&
        typeof entry === 'object' &&
        'name' in entry &&
        entry.name === 'chromium' &&
        'browserVersion' in entry &&
        typeof entry.browserVersion === 'string'
      )
        return chromeMajorVersion(entry.browserVersion);
  } catch {
    // A missing catalog only loses the initial guess; launch verification remains.
  }
  return undefined;
}

/**
 * Headless Chrome identifies itself as `HeadlessChrome` in every User-Agent it
 * sends, which sites treat as an automated client even when a person drives the
 * streamed page. `--user-agent` replaces it browser-wide, so documents, workers,
 * service workers and network requests agree. Per-target CDP overrides miss
 * service workers and replace Chrome's real client-hint brands.
 *
 * The switch must be chosen before launch, so this remembers each launch target's
 * actual major version. Installed Chrome can differ from the pinned build and
 * update in place; the launcher verifies the started version and relaunches once
 * on a mismatch.
 */
export class RuntimeUserAgents {
  private readonly majors = new Map<string, number>();
  private pinned?: Promise<number | undefined>;

  constructor(
    private readonly pinnedMajor: () => Promise<
      number | undefined
    > = pinnedChromiumMajor,
  ) {}

  async expected(target: string): Promise<number | undefined> {
    return (
      this.majors.get(target) ?? (await (this.pinned ??= this.pinnedMajor()))
    );
  }

  remember(target: string, major: number): void {
    // Bounded by the launcher's fixed target set: managed, configured and channel.
    if (this.majors.size < 8 || this.majors.has(target))
      this.majors.set(target, major);
  }
}

export function userAgentArgs(major: number | undefined): string[] {
  const userAgent = major === undefined ? undefined : chromeUserAgent(major);
  return userAgent ? ['--user-agent=' + userAgent] : [];
}
