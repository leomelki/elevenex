import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildAugmentedEnvAsync,
  findBinaryAsync,
} from '../config/system-paths.js';
import { acpObject, AcpRequestError, AcpStdio } from './acp-stdio.js';
import {
  ANTIGRAVITY_CATALOG_SIGN_IN,
  ANTIGRAVITY_INSTALL,
  antigravityEnvironment,
  initializeAntigravity,
  sessionOptions,
} from './antigravity-acp.js';

interface Catalog {
  options: ReturnType<typeof sessionOptions>;
  unavailableReason?: string;
}

/** One short-lived, metadata-only ACP connection for concurrent catalog reads. */
export class AntigravityCatalog {
  private readonly lifetime = new AbortController();
  /** Receives the discovery session result so account facts such as tier are not discarded. */
  constructor(
    private readonly observeSession: (
      opened: Record<string, unknown>,
    ) => void = () => undefined,
  ) {}
  private cached?: { value: Catalog; expiresAt: number };
  private pending?: Promise<void>;

  current() {
    return this.cached && this.cached.expiresAt > Date.now()
      ? this.cached.value
      : undefined;
  }

  /** Keep the last advertised choices visible after the discovery TTL elapses. */
  get mode() {
    return this.cached?.value.options.mode;
  }

  observe(options: Catalog['options']): void {
    if (options.model?.values.length) this.cache({ options });
  }

  async load(refresh: boolean): Promise<Catalog | undefined> {
    if (this.lifetime.signal.aborted) return undefined;
    const cached = this.current();
    if (!refresh && cached) return cached;
    this.pending ??= this.probe().finally(() => {
      this.pending = undefined;
    });
    await this.pending;
    return this.current();
  }

  async close(): Promise<void> {
    this.lifetime.abort();
    await this.pending;
  }

  private cache(value: Catalog): void {
    this.cached = {
      value,
      expiresAt: Date.now() + (value.unavailableReason ? 10_000 : 5 * 60_000),
    };
  }

  private async probe(): Promise<void> {
    const before = this.cached;
    const signal = AbortSignal.any([
      this.lifetime.signal,
      AbortSignal.timeout(7_500),
    ]);
    let cwd: string | undefined;
    let transport: AcpStdio | undefined;
    const abort = () => transport?.close();
    let result: Catalog;
    try {
      const binary = await findBinaryAsync('agy');
      signal.throwIfAborted();
      if (!binary) {
        result = { options: {}, unavailableReason: ANTIGRAVITY_INSTALL };
      } else {
        const env = await buildAugmentedEnvAsync(process.env, undefined, {
          signal,
        });
        cwd = await mkdtemp(join(tmpdir(), 'elevenex-agy-catalog-'));
        signal.throwIfAborted();
        transport = new AcpStdio(binary, cwd, antigravityEnvironment(env), {
          notification: () => undefined,
          request: () => undefined,
        });
        signal.addEventListener('abort', abort, { once: true });
        const capabilities = await initializeAntigravity(transport);
        const opened = await transport.request('session/new', {
          cwd,
          mcpServers: [],
        });
        const options = sessionOptions(opened);
        this.observeSession(opened);
        const close = acpObject(capabilities.sessionCapabilities).close;
        if (close != null && typeof opened.sessionId === 'string') {
          await transport
            .request('session/close', { sessionId: opened.sessionId }, 500)
            .catch(() => undefined);
        }
        result = options.model?.values.length
          ? { options }
          : {
              options: {},
              unavailableReason: 'Antigravity returned no available models.',
            };
      }
    } catch (error) {
      result = {
        options: {},
        unavailableReason:
          error instanceof AcpRequestError && error.code === -32000
            ? ANTIGRAVITY_CATALOG_SIGN_IN
            : 'Could not reach Antigravity to list its models.',
      };
    } finally {
      signal.removeEventListener('abort', abort);
      transport?.close();
      if (cwd)
        await rm(cwd, { recursive: true, force: true, maxRetries: 2 }).catch(
          () => undefined,
        );
    }
    // A conversation may have reported newer options while discovery was running.
    if (!this.lifetime.signal.aborted && this.cached === before)
      this.cache(result);
  }
}
