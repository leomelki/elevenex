const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const { rewriteLocalhostToProxy } = require('../mcp-proxy-url.cjs');

const LOCAL_BACKEND = 'http://127.0.0.1:54321';
const REMOTE_BACKEND = 'http://127.0.0.1:49876';

describe('rewriteLocalhostToProxy', () => {
  it('routes a loopback callback through the given backend', () => {
    assert.equal(
      rewriteLocalhostToProxy('http://localhost:3000/callback?code=abc#frag', LOCAL_BACKEND),
      `${LOCAL_BACKEND}/api/mcp-auth-proxy/3000/callback?code=abc#frag`,
    );
  });

  it('sends each window callback to its own backend', () => {
    // Regression: a single process-wide origin used to send the SSH window's
    // OAuth callback to the local window's backend, which knows nothing about
    // the remote's MCP server.
    const url = 'http://127.0.0.1:7777/oauth/callback';
    assert.notEqual(
      rewriteLocalhostToProxy(url, LOCAL_BACKEND),
      rewriteLocalhostToProxy(url, REMOTE_BACKEND),
    );
    assert.ok(rewriteLocalhostToProxy(url, REMOTE_BACKEND).startsWith(REMOTE_BACKEND));
  });

  it('covers every loopback spelling', () => {
    for (const host of ['localhost', '127.0.0.1', '[::1]']) {
      assert.ok(
        rewriteLocalhostToProxy(`http://${host}:8080/cb`, LOCAL_BACKEND).includes('/api/mcp-auth-proxy/8080'),
        host,
      );
    }
  });

  it('leaves non-loopback and portless URLs alone', () => {
    for (const url of [
      'https://example.com/callback',
      'http://localhost/callback',
      'https://127.0.0.1.evil.test:9000/callback',
    ]) {
      assert.equal(rewriteLocalhostToProxy(url, LOCAL_BACKEND), url);
    }
  });

  it('passes through anything that is not a URL', () => {
    assert.equal(rewriteLocalhostToProxy('about:blank', LOCAL_BACKEND), 'about:blank');
    assert.equal(rewriteLocalhostToProxy('not a url', LOCAL_BACKEND), 'not a url');
  });

  it('does nothing without a backend origin', () => {
    const url = 'http://localhost:3000/callback';
    assert.equal(rewriteLocalhostToProxy(url, ''), url);
    assert.equal(rewriteLocalhostToProxy(url, undefined), url);
  });

  it('tolerates a trailing slash on the backend origin', () => {
    assert.equal(
      rewriteLocalhostToProxy('http://localhost:3000/cb', `${LOCAL_BACKEND}/`),
      `${LOCAL_BACKEND}/api/mcp-auth-proxy/3000/cb`,
    );
  });
});
