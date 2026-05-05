export const MCP_AUTH_PROXY_PREFIX = '/api/mcp-auth-proxy';

export function isLoopbackHostname(hostname: string): boolean {
  return hostname === 'localhost'
    || hostname === '127.0.0.1'
    || hostname === '::1'
    || hostname === '[::1]';
}

export function buildMcpAuthProxyPath(port: number | string, pathWithSearchAndHash = '/'): string {
  const normalizedPath = pathWithSearchAndHash.startsWith('/')
    ? pathWithSearchAndHash
    : `/${pathWithSearchAndHash}`;
  return `${MCP_AUTH_PROXY_PREFIX}/${port}${normalizedPath}`;
}

export function parseMcpAuthProxyRequestUrl(url: string): {
  port: number;
  upstreamPath: string;
} | null {
  const match = url.match(/^\/(\d+)(\/[^#]*)?$/);
  if (!match) {
    return null;
  }

  const port = Number.parseInt(match[1], 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return null;
  }

  return {
    port,
    upstreamPath: match[2] || '/',
  };
}

export function rewriteMcpAuthLocationHeader(
  location: string,
  currentPort: number,
  currentUpstreamPath: string,
): string {
  try {
    const parsed = new URL(location);
    if (isLoopbackHostname(parsed.hostname) && parsed.port) {
      return buildMcpAuthProxyPath(parsed.port, `${parsed.pathname}${parsed.search}${parsed.hash}`);
    }

    return location;
  } catch {
    // Relative redirects are resolved as if the browser were talking directly to
    // the local callback server, then remapped back under this proxy.
  }

  try {
    const base = new URL(currentUpstreamPath || '/', `http://127.0.0.1:${currentPort}`);
    const resolved = new URL(location, base);
    if (isLoopbackHostname(resolved.hostname)) {
      return buildMcpAuthProxyPath(
        resolved.port || currentPort,
        `${resolved.pathname}${resolved.search}${resolved.hash}`,
      );
    }
  } catch {
    // Keep malformed Location headers untouched.
  }

  return location;
}

export function buildMcpAuthProxyUnavailableHtml(port: number): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <title>MCP authentication unavailable</title>
    <style>
      body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 32px; line-height: 1.5; color: #1f2937; }
      code { background: #f3f4f6; border-radius: 4px; padding: 2px 5px; }
    </style>
  </head>
  <body>
    <h1>MCP authentication callback unavailable</h1>
    <p>Elevenex could not reach the local OAuth callback server on <code>127.0.0.1:${port}</code>.</p>
    <p>Restart the MCP authentication flow from Elevenex and keep this window open until the provider redirects back.</p>
  </body>
</html>`;
}
