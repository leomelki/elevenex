const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { HtmlPreview, externalLinkUrl } = require('../dist/code/html-preview');
const { PREVIEW_BRIDGE, PREVIEW_BRIDGE_PATH, declaredCharset, withPreviewBridge } = require('../dist/code/html-preview-bridge');
const { previewViewDocument, readPreviewViewEvent } = require('../dist/code/web/html-preview-view');

const authority = 'w-a.b.code.elevenex.invalid';

function preview(files) {
  const reads = [];
  const client = {
    execute: async (_window, _scope, key) => {
      const path = key.slice(key.indexOf('.invalid:') + '.invalid:'.length);
      reads.push(path);
      return path in files ? { ok: true, value: Buffer.from(files[path]) } : { ok: false, error: { status: 404 } };
    },
  };
  const html = new HtmlPreview(client, authority, 'app://elevenex');
  const scope = { windowId: 1, scopeId: 's', taskId: 1, generation: 'g', current: () => true };
  const open = async path => {
    const response = await html.open(path, scope, new globalThis.Request('https://x.invalid/', { method: 'POST' }), {});
    return response.ok ? new URL((await response.json()).url) : response;
  };
  const get = url => html.handle(new globalThis.Request(url), new URL(url));
  return { html, reads, open, get };
}

test('HTML documents load the bridge first and allow only that script', async () => {
  const page = '<!DOCTYPE html>\n<html><head><meta charset="windows-1252"><script>alert(1)</script></head><body><h1>Hi</h1></body></html>';
  const { open, get } = preview({ '/site/index.html': page, '/site/a.css': 'h1{}' });
  const url = await open('/site/index.html');
  const response = await get(url.href);
  const body = await response.text();
  assert.ok(body.startsWith(`<!DOCTYPE html><script src="${url.origin}${PREVIEW_BRIDGE_PATH}"></script>\n<html>`), body);
  assert.equal(response.headers.get('content-type'), 'text/html; charset=windows-1252');
  const policy = response.headers.get('content-security-policy');
  assert.match(policy, new RegExp(`script-src ${url.origin.replaceAll('.', '\\.')}/\\.elevenex/preview-bridge\\.js;`));
  assert.doesNotMatch(policy, /unsafe-inline|unsafe-eval|'self' 'unsafe|script-src 'self'/);
  assert.match(policy, /sandbox allow-scripts allow-same-origin(;|$)/);
  for (const directive of ["connect-src 'none'", "form-action 'none'", "frame-src 'none'", "object-src 'none'"]) assert.ok(policy.includes(directive), directive);

  const css = await get(new URL('a.css', url).href);
  assert.equal(await css.text(), 'h1{}');
});

test('the bridge is served from a path no task file can occupy', async () => {
  const { open, get, reads } = preview({ '/site/index.html': '<p>x</p>', '/.elevenex/preview-bridge.js': 'evil()' });
  const url = await open('/site/index.html');
  const bridge = await get(new URL(PREVIEW_BRIDGE_PATH, url).href);
  assert.equal(bridge.status, 200);
  assert.equal(bridge.headers.get('content-type'), 'text/javascript; charset=utf-8');
  assert.equal(await bridge.text(), PREVIEW_BRIDGE);
  assert.ok(!reads.includes(PREVIEW_BRIDGE_PATH));
  assert.equal((await get(new URL('/.elevenex/other.js', url).href)).status, 404);
  // Another origin, or a closed preview, cannot fetch it.
  assert.equal((await get(`https://elevenex-preview-${'b'.repeat(32)}.invalid${PREVIEW_BRIDGE_PATH}`)).status, 403);
});

test('bridge injection preserves rendering mode and encodings it cannot amend', () => {
  const origin = 'https://elevenex-preview-0.invalid';
  const inject = text => withPreviewBridge(Buffer.from(text, 'latin1'), origin).toString('latin1');
  const tag = `<script src="${origin}${PREVIEW_BRIDGE_PATH}"></script>`;
  assert.equal(inject('<p>no doctype</p>'), tag + '<p>no doctype</p>');
  assert.equal(inject('\xEF\xBB\xBF<!-- a -->\n<!doctype html><p>'), `\xEF\xBB\xBF<!-- a -->\n<!doctype html>${tag}<p>`);
  const utf16 = Buffer.from('﻿<p>x</p>', 'utf16le');
  assert.equal(withPreviewBridge(utf16, origin), utf16);
  assert.equal(declaredCharset(Buffer.from('<meta http-equiv="Content-Type" content="text/html; charset=Shift_JIS">')), 'shift_jis');
  assert.equal(declaredCharset(Buffer.from('\xEF\xBB\xBF<p>', 'latin1')), 'utf-8');
  assert.equal(declaredCharset(Buffer.from(`${' '.repeat(1100)}<meta charset="utf-8">`)), undefined);
});

test('only ordinary web links can leave a preview', () => {
  assert.equal(externalLinkUrl('https://example.com/a?b#c'), 'https://example.com/a?b#c');
  assert.equal(externalLinkUrl('http://localhost:3000/'), 'http://localhost:3000/');
  for (const value of ['javascript:alert(1)', 'file:///etc/passwd', 'https://user:pass@example.com/', `https://elevenex-preview-${'a'.repeat(32)}.invalid/x.html`, 'https://' + 'a'.repeat(2050), 42, undefined]) {
    assert.equal(externalLinkUrl(value), undefined, String(value));
  }
});

test('serialized preview scripts compile and view events are validated', () => {
  assert.doesNotThrow(() => new vm.Script(PREVIEW_BRIDGE));
  const document = previewViewDocument('nonce123');
  const script = /<script nonce="nonce123">([\s\S]*)<\/script>/.exec(document)?.[1];
  assert.ok(script);
  assert.doesNotThrow(() => new vm.Script(script));
  assert.match(document, /script-src 'nonce-nonce123'; style-src 'nonce-nonce123'/);
  assert.doesNotMatch(document, /unsafe-inline|unsafe-eval/);

  assert.deepEqual(readPreviewViewEvent({ type: 'loaded', path: '/a%20b.html', x: 0, y: 12.4 }), { type: 'loaded', path: '/a%20b.html', x: 0, y: 12 });
  assert.deepEqual(readPreviewViewEvent({ type: 'open-external', url: 'https://example.com' }), { type: 'open-external', url: 'https://example.com' });
  for (const value of [null, 'ready', { type: 'loaded', path: 'relative', x: 0, y: 0 }, { type: 'scroll', path: '/a', x: -1, y: 0 }, { type: 'scroll', path: '/a', x: Infinity, y: 0 }, { type: 'open-external', url: 'x'.repeat(2049) }, { type: 'run' }]) {
    assert.equal(readPreviewViewEvent(value), undefined, JSON.stringify(value));
  }
});

test('external preview links open only for a ready, active editor after validation', async () => {
  const { BackendClient } = require('../dist/backend-client/client');
  const { CodeProtocol } = require('../dist/code/protocol');
  const generation = 'a'.repeat(64), opened = [];
  let focused = true;
  const client = new BackendClient(() => null, () => {}); client.attach(1);
  const host = new CodeProtocol(client, 1, { taskId: 1, scopeId: 'a'.repeat(36) }, { version: 1, taskId: 1, identity: generation, storageIdentity: generation, name: 'task', branch: 'branch' }, '', '', () => false, () => {}, () => {}, 'app://elevenex', generation, () => {}, undefined, url => { if (focused) opened.push(url); return focused; });
  const call = (operation, body) => host.handle(new globalThis.Request(`https://${host.authority}/api/${operation}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ generation, transportRevision: 0, ...body }) }));
  const open = async (url, extra) => (await (await call('html-preview-open-external', { url, ...extra })).json()).accepted;
  try {
    assert.equal(await open('https://example.com/'), false, 'inactive editor');
    host.active = true;
    assert.equal(await open('https://example.com/'), false, 'workbench not ready');
    await call('ready', { dirty: 0 });
    assert.equal(await open('javascript:alert(1)'), false);
    assert.equal(await open(`https://elevenex-preview-${'a'.repeat(32)}.invalid/`), false);
    assert.equal((await call('html-preview-open-external', { url: 'https://example.com/', generation: 'old' })).status, 409);
    focused = false;
    assert.equal(await open('https://example.com/'), false, 'unfocused window');
    focused = true;
    assert.equal(await open('https://example.com/a'), true);
    assert.deepEqual(opened, ['https://example.com/a']);
  } finally { host.dispose(); client.dispose(); }
});
