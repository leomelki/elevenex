export function buildMcpAuthPopupUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (
      parsed.hostname === 'localhost'
      || parsed.hostname === '127.0.0.1'
      || parsed.hostname === '[::1]'
    ) {
      const port = parsed.port || (parsed.protocol === 'https:' ? '443' : '80');
      return `/api/mcp-auth-proxy/${port}${parsed.pathname}${parsed.search}${parsed.hash}`;
    }
  } catch {
    // Invalid or relative URLs should be opened as supplied.
  }

  return url;
}
