import { describe, expect, it } from 'vitest';
import { buildMcpAuthPopupUrl } from './mcp-auth-url';

describe('buildMcpAuthPopupUrl', () => {
  it('leaves external auth URLs unchanged', () => {
    expect(buildMcpAuthPopupUrl('https://auth.example.com/authorize?client_id=abc')).toBe(
      'https://auth.example.com/authorize?client_id=abc',
    );
  });

  it('proxies localhost URLs', () => {
    expect(buildMcpAuthPopupUrl('http://localhost:49152/callback')).toBe(
      '/api/mcp-auth-proxy/49152/callback',
    );
  });

  it('preserves query strings and hash fragments', () => {
    expect(buildMcpAuthPopupUrl('http://localhost:49152/callback?code=abc&state=def#done')).toBe(
      '/api/mcp-auth-proxy/49152/callback?code=abc&state=def#done',
    );
  });

  it('proxies 127.0.0.1 URLs', () => {
    expect(buildMcpAuthPopupUrl('http://127.0.0.1:49152/callback?code=abc')).toBe(
      '/api/mcp-auth-proxy/49152/callback?code=abc',
    );
  });
});
