const { test } = require('node:test');
const assert = require('node:assert/strict');
const { rendererPath, isAppUrl, isExternalUrl, contentSecurityPolicy } = require('../dist/security');

test('protocol confines paths and provides history fallback without masking missing assets', () => {
  assert.equal(rendererPath('/renderer', 'app://elevenex/task/example'), '/renderer/index.html');
  assert.equal(rendererPath('/renderer', 'app://elevenex/chunk.js'), '/renderer/chunk.js');
  for (const url of ['app://other/index.html', 'app://elevenex/%2e%2e%2fsecret', 'app://elevenex/%00', 'app://elevenex/%5csecret', 'app://elevenex/%ZZ']) {
    assert.equal(rendererPath('/renderer', url), undefined, url);
  }
});

test('origins and external schemes are restricted', () => {
  assert.equal(isAppUrl('app://elevenex/'), true);
  assert.equal(isAppUrl('app://user@elevenex/'), false);
  assert.equal(isAppUrl('https://evil.test/'), false);
  assert.equal(isAppUrl('http://127.0.0.1:4300/', 'http://127.0.0.1:4300'), true);
  assert.equal(isAppUrl('http://127.0.0.1:4301/', 'http://127.0.0.1:4300'), false);
  for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'https://user:password@example.com']) assert.equal(isExternalUrl(url), false);
  assert.equal(isExternalUrl('https://example.com/docs'), true);
});

test('production CSP disallows inline scripts, eval, remote connections and frames', () => {
  const policy = contentSecurityPolicy();
  assert.ok(policy.includes("script-src 'self'"));
  assert.ok(!policy.includes('unsafe-inline'));
  assert.ok(!policy.includes('unsafe-eval'));
  assert.ok(policy.includes("connect-src 'self'"));
  assert.ok(policy.includes("frame-ancestors 'none'"));
});
