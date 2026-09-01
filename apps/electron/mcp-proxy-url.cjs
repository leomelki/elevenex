// MCP OAuth callbacks are served on a localhost port of the machine the
// *backend* runs on. Over SSH that machine is the remote host, so the URL has
// to be funnelled through that backend's proxy endpoint instead of being opened
// against this machine's localhost.
//
// Extracted from main.cjs so the per-window routing can be tested: with two
// windows on two backends, resolving the origin from a single process-wide
// value would send one window's OAuth callback to the other window's backend.

const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

function rewriteLocalhostToProxy(url, backendOrigin) {
  if (!backendOrigin) {
    return url;
  }

  try {
    const parsed = new URL(url);
    // A loopback URL without a port is this app's own frontend, not a callback
    // server — leave it alone.
    if (LOOPBACK_HOSTNAMES.has(parsed.hostname) && parsed.port) {
      const origin = `${backendOrigin}`.replace(/\/+$/, '');
      return `${origin}/api/mcp-auth-proxy/${parsed.port}${parsed.pathname}${parsed.search}${parsed.hash}`;
    }
  } catch {
    // Not a valid URL, return as-is.
  }

  return url;
}

module.exports = { rewriteLocalhostToProxy };
