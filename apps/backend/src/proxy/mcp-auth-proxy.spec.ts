import {
  buildMcpAuthProxyUnavailableHtml,
  parseMcpAuthProxyRequestUrl,
  rewriteMcpAuthLocationHeader,
} from './mcp-auth-proxy.js';

describe('MCP auth proxy helpers', () => {
  it('parses proxied request URLs with path and query intact', () => {
    expect(parseMcpAuthProxyRequestUrl('/49152/callback?code=abc&state=def')).toEqual({
      port: 49152,
      upstreamPath: '/callback?code=abc&state=def',
    });
  });

  it('rewrites absolute localhost redirects and preserves query and hash', () => {
    expect(
      rewriteMcpAuthLocationHeader(
        'http://localhost:49152/callback?code=abc&state=def#done',
        3000,
        '/',
      ),
    ).toBe('/api/mcp-auth-proxy/49152/callback?code=abc&state=def#done');
  });

  it('rewrites IPv6 loopback redirects', () => {
    expect(
      rewriteMcpAuthLocationHeader(
        'http://[::1]:49152/callback?code=abc',
        3000,
        '/',
      ),
    ).toBe('/api/mcp-auth-proxy/49152/callback?code=abc');
  });

  it('rewrites relative redirects against the current upstream callback path', () => {
    expect(
      rewriteMcpAuthLocationHeader(
        '../complete?ok=1#closed',
        49152,
        '/oauth/callback?code=abc',
      ),
    ).toBe('/api/mcp-auth-proxy/49152/complete?ok=1#closed');
  });

  it('leaves non-local absolute redirects untouched', () => {
    expect(
      rewriteMcpAuthLocationHeader(
        'https://provider.example.com/consent',
        49152,
        '/callback',
      ),
    ).toBe('https://provider.example.com/consent');
  });

  it('renders a clear unavailable callback response', () => {
    expect(buildMcpAuthProxyUnavailableHtml(49152)).toContain('127.0.0.1:49152');
  });
});
