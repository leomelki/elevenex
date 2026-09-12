const test = require('node:test');
const assert = require('node:assert/strict');
const {
  isTrustedAppUrl,
  shouldGrantAppPermission,
} = require('../permission-policy.cjs');

test('recognizes packaged and local development app URLs', () => {
  assert.equal(isTrustedAppUrl('file:///Applications/Elevenex/app.html'), true);
  assert.equal(isTrustedAppUrl('http://127.0.0.1:4200/session'), true);
  assert.equal(isTrustedAppUrl('http://localhost:4200/session'), true);
  assert.equal(isTrustedAppUrl('https://localhost:4200/session'), true);
});

test('rejects malformed and non-local URLs', () => {
  assert.equal(isTrustedAppUrl('https://example.com'), false);
  assert.equal(isTrustedAppUrl('https://localhost.example.com'), false);
  assert.equal(isTrustedAppUrl('data:text/html,hello'), false);
  assert.equal(isTrustedAppUrl('not a url'), false);
  assert.equal(isTrustedAppUrl(''), false);
});

test('allows clipboard reads and writes only for trusted app URLs', () => {
  for (const permission of ['clipboard-read', 'clipboard-sanitized-write']) {
    assert.equal(shouldGrantAppPermission(permission, 'file:///app/index.html'), true);
    assert.equal(shouldGrantAppPermission(permission, 'http://127.0.0.1:4200'), true);
    assert.equal(shouldGrantAppPermission(permission, 'https://example.com'), false);
  }
});

test('keeps the microphone-only media policy and denies other permissions', () => {
  const appUrl = 'file:///app/index.html';

  assert.equal(shouldGrantAppPermission('media', appUrl, { mediaTypes: ['audio'] }), true);
  assert.equal(shouldGrantAppPermission('media', appUrl, { mediaTypes: ['video'] }), false);
  assert.equal(shouldGrantAppPermission('media', appUrl, { mediaTypes: ['audio', 'video'] }), false);
  assert.equal(shouldGrantAppPermission('geolocation', appUrl), false);
  assert.equal(shouldGrantAppPermission('notifications', appUrl), false);
});
