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

/**
 * Interface the edge proxy binds.
 *
 * Loopback by default: the backend has no authentication of its own — every
 * gateway accepts an unauthenticated upgrade, `/user-terminal` included, which
 * hands out a PTY — so a wildcard bind puts a shell on the machine within reach
 * of anyone on the same network. Locally the only client is this machine's own
 * Electron app, and an SSH remote is reached through a tunnel whose far end is
 * `127.0.0.1`, so neither needs more than this.
 *
 * `ELEVENEX_BIND_HOST` opts back out. The remote runtime start scripts set it to
 * `0.0.0.0` because WSL2's localhost forwarding does not reach a loopback-only
 * listener inside the distro.
 */
export function getElevenexBindHost(): string {
  const configured = process.env.ELEVENEX_BIND_HOST?.trim();
  return configured || '127.0.0.1';
}

export function getEdgeProxyUpstreamOrigin(): string | undefined {
  const explicitOrigin = process.env.ELEVENEX_PROXY_UPSTREAM_ORIGIN?.trim();
  if (explicitOrigin) {
    return explicitOrigin;
  }

  return undefined;
}
