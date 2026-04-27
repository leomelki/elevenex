const DEFAULT_ELEVENEX_PROXY_PORT = 11111;

function parsePort(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function getElevenexProxyPort(): number {
  return parsePort(
    process.env.ELEVENEX_PROXY_PORT ?? process.env.FRONTEND_PORT,
    DEFAULT_ELEVENEX_PROXY_PORT,
  );
}

export function getEdgeProxyUpstreamOrigin(): string | undefined {
  const explicitOrigin = process.env.ELEVENEX_PROXY_UPSTREAM_ORIGIN?.trim();
  if (explicitOrigin) {
    return explicitOrigin;
  }

  return undefined;
}
