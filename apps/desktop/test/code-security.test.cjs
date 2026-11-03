const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, mkdir, rm, writeFile, symlink } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { BackendClient } = require('../dist/backend-client/client');
const { CodeProtocol } = require('../dist/code/protocol');
const { codePolicy, workbenchDocument } = require('../dist/code/document');
const validate = require('../dist/code/validation');

test('Code controls accept resource identities and bounded file positions, never transport or shell inputs', () => {
  const target = { taskId: 1, scopeId: 'a'.repeat(36) };
  assert.deepEqual(validate.target(target), target);
  for (const input of [{ ...target, url: 'https://example.com' }, { ...target, taskId: -1 }, { ...target, scopeId: 'old' }]) assert.throws(() => validate.target(input));
  for (const path of ['/absolute', '../escape', 'file/../escape', '.git/config', 'a\0']) assert.throws(() => validate.file({ path }));
  assert.deepEqual(validate.file({ path: 'unicode é #?.ts', line: 10, column: 2 }), { path: 'unicode é #?.ts', line: 10, column: 2 });
  assert.throws(() => validate.file({ path: 'ok', line: 1.2 }));
  assert.throws(() => validate.bounds({ x: -1, y: 50, width: 600, height: 500 }));
  assert.throws(() => validate.reply('directory', { entries: Array(201).fill({ name: 'a', type: 1 }), next: null }));
  assert.throws(() => validate.reply('read', { content: '', revision: 'not a revision' }));
  assert.throws(() => validate.descriptor({ version: 1, taskId: 2, identity: 'a'.repeat(64), storageIdentity: 'a'.repeat(64), name: 'wrong', branch: '' }, 1));
});

test('Code HTTPS is private to its native session, rejects foreign origins, confines assets and stale scopes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'new-code-protocol-'));
  let handler, filter, permission, exits = 0;
  const session = { protocol: { handle: async (scheme, fn) => { assert.equal(scheme, 'https'); handler = fn; }, unhandle: () => {} }, setPermissionRequestHandler: fn => { permission = fn; fn(null, 'camera', allowed => assert.equal(allowed, false)); }, setPermissionCheckHandler: fn => assert.equal(fn(), false), setDevicePermissionHandler: fn => assert.equal(fn(), false), webRequest: { onBeforeRequest: fn => { filter = fn; } } };
  const client = new BackendClient(() => null, () => {}); client.attach(1);
  const host = new CodeProtocol(session, client, 1, { taskId: 1, scopeId: 'a'.repeat(36) }, { version: 1, taskId: 1, identity: 'a'.repeat(64), storageIdentity: 'a'.repeat(64), name: 'task', branch: 'branch' }, root, root, () => false, () => {}, () => exits++);
  await host.register();
  permission({ getURL: () => `https://${host.authority}/`, isFocused: () => true }, 'persistent-storage', allowed => assert.equal(allowed, true), { isMainFrame: true });
  permission({ getURL: () => 'https://example.com', isFocused: () => true }, 'persistent-storage', allowed => assert.equal(allowed, false), { isMainFrame: true });
  try {
    assert.equal(host.allows('https://example.com'), false); assert.equal(host.allows(`https://user@${host.authority}/`), false);
    let result; filter({ url: 'https://example.com/exfiltrate' }, value => { result = value; }); assert.equal(result.cancel, true);
    const request = (path, options = {}) => handler(new globalThis.Request(`https://${host.authority}${path}`, options));
    const returnToChat = (generation = 'a'.repeat(64)) => request('/api/return-to-chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ generation, transportRevision: 0 }) }).then(response => response.json());
    assert.equal((await returnToChat()).accepted, false);
    host.active = true; assert.equal((await returnToChat('old')).accepted, false); assert.equal(exits, 0);
    assert.equal((await returnToChat()).accepted, true); assert.equal(exits, 1);
    host.embedded = false; assert.equal((await returnToChat()).accepted, false); assert.equal(exits, 1);
    host.embedded = true; host.active = false;
    assert.equal((await request('/api/write', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"path":"/file","generation":"old"}' })).status, 409);
    assert.equal((await request('/api/read', { method: 'POST', headers: { Origin: 'https://example.com', 'Content-Type': 'application/json' }, body: '{}' })).status, 403);
    assert.equal((await request('/api/raw-shell', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 404);
    assert.equal((await request('/api/write', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"path":"/file","generation":"old"}' })).status, 409);
    assert.equal((await request('/api/read', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"path":"/file"}' })).status, 503);
    const changes = () => request('/api/changes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ generation: 'a'.repeat(64), after: 0 }) });
    await request('/api/ready', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"transportRevision":0,"dirty":0}' });
    assert.equal((await (await changes()).json()).paused, true);
    host.bind({ taskId: 1, scopeId: 'b'.repeat(36) });
    assert.equal((await changes()).status, 503, 'A rebinding workbench must reconcile before idle polling can pause');
    await mkdir(join(root, 'out')); await writeFile(join(root, 'out/safe.js'), 'export {};');
    assert.equal((await request('/assets/out/safe.js')).status, 200);
    await symlink(join(root, '..'), join(root, 'out/escape'));
    assert.equal((await request('/assets/out/escape/not-a-runtime-file')).status, 404);
    assert.equal((await request('/assets/%2e%2e%2fsecret')).status, 403);
  } finally { host.dispose(); client.dispose(); await rm(root, { recursive: true, force: true }); }
});

test('upstream worker exceptions stay separate from the app/workbench policy and task text cannot inject HTML', () => {
  const authority = 'code.example.invalid';
  assert.ok(!codePolicy(authority, 'nonce').includes("'unsafe-eval'"));
  assert.ok(codePolicy(authority, 'nonce', true).includes("'unsafe-eval'"));
  assert.ok(!codePolicy(authority, 'nonce').includes("script-src 'unsafe-inline'"));
  const document = workbenchDocument({ version: 1, taskId: 1, identity: 'a'.repeat(64), storageIdentity: 'a'.repeat(64), name: '</script><script>alert(1)</script>', branch: '' }, authority, '', false);
  assert.ok(!document.html.includes('</script><script>alert(1)'));
  assert.ok(!document.policy.includes('https: '));
});

test('workbench configuration uses the pinned upstream theme IDs and authoritative palettes', async () => {
  const { readFile } = require('node:fs/promises');
  const tokens = await readFile(require.resolve('../../../docs/design-system/project/tokens.css'), 'utf8');
  const workspace = { version: 1, taskId: 1, identity: 'a'.repeat(64), storageIdentity: 'a'.repeat(64), name: 'Task', branch: '' };
  for (const dark of [false, true]) {
    const { html } = workbenchDocument(workspace, 'code.example.invalid', tokens, dark);
    assert.ok(html.includes(`"workbench.colorTheme":"${dark ? 'Dark' : 'Light'} Modern"`));
    assert.ok(html.includes('"workbench.layoutControl.enabled":false'));
    assert.ok(!html.includes('"window.customTitleBarVisibility"'));
    assert.ok(html.includes('"[Dark Modern]":{"editor.background":"#10151b"'));
    assert.ok(html.includes('"[Light Modern]":{"editor.background":"#f7f9fb"'));
    assert.ok(html.includes('"list.activeSelectionBackground":"#0e3532"'));
    assert.ok(html.includes('"list.activeSelectionBackground":"#dcf3f0"'));
    assert.ok(html.includes('"keywords":"#7a3f9e"'));
    assert.ok(html.includes('"keywords":"#cfa3f0"'));
  }
});
