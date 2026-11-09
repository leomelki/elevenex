/** Privileged adapters implement these operations; agent code only receives JSON RPC handles. */
export interface BrowserAgentTarget {
  readonly id: string;
  /** Must reject closed/replaced targets and every intervening human takeover. */
  assert(): void;
  send(
    method: string,
    params: Record<string, unknown>,
    sessionId?: string,
  ): Promise<unknown>;
  subscribe(
    listener: (method: string, params: unknown, sessionId?: string) => void,
  ): () => void;
  /** Grants the destination without navigating; the scoped Playwright connection owns navigation. */
  authorize?(url: string, signal: AbortSignal): Promise<void>;
  dispose?(): void | Promise<void>;
  playwright?(): void | Promise<void>;
  subscribeDownloads?(
    listener: (download: BrowserAgentDownload) => void,
  ): () => void;
  goto(url: string, signal: AbortSignal): Promise<void>;
  close(): Promise<void>;
  /** Cancel page execution and release input without killing the browser connection. */
  interrupt(): void;
}
export interface BrowserAgentDownload {
  readonly url: string;
  readonly filename: string;
  path(): Promise<string>;
  cancel(): Promise<void>;
  dispose(): Promise<void>;
}
export interface BrowserAgentHost {
  readonly playwright?: true;
  watch?(listener: () => void): () => void;
  profile?: {
    cookies(): Promise<import('playwright-core').Cookie[]>;
    addCookies(
      cookies: Parameters<
        import('playwright-core').BrowserContext['addCookies']
      >[0],
    ): Promise<void>;
    clearCookies(): Promise<void>;
  };
  version?(): Promise<string>;
  proxy?(): Promise<string>;
  authorizeUrl?(url: string, signal: AbortSignal): Promise<void>;
  interact?(
    sessionId: number,
    command: import('@elevenex/shared').BrowserHumanCommand,
  ): Promise<import('@elevenex/shared').BrowserHumanRequest>;
  document?(tabId: string): string | undefined;
  newPage?(sessionId: number, signal: AbortSignal): Promise<BrowserAgentTarget>;
  list(
    sessionId: number,
  ): readonly {
    id: string;
    owned: boolean;
    url?: string;
    populated?: boolean;
  }[];
  open(
    sessionId: number,
    url: string,
    signal: AbortSignal,
  ): Promise<BrowserAgentTarget>;
  get(sessionId: number, tabId: string): Promise<BrowserAgentTarget>;
}
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Expected an object');
  return value as Record<string, unknown>;
}
export function integer(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  if (value === undefined) return fallback;
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < min ||
    value > max
  )
    throw new Error(`Expected an integer between ${min} and ${max}`);
  return value;
}
export async function delay(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(new Error('Browser execution cancelled'));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, ms);
    signal.addEventListener('abort', abort, { once: true });
  });
}
