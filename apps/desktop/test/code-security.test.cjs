const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, mkdir, rm, writeFile, symlink } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { BackendClient } = require('../dist/backend-client/client');
const { CodeProtocol } = require('../dist/code/protocol');
const { codePolicy, workbenchDocument } = require('../dist/code/document');
const validate = require('../dist/code/validation');
const vm = require('node:vm');
const { waitForCodeLayout } = require('../dist/code/layout-settlement');

function layoutFrame() {
  let now = 0, identity = 0, moving = false, animatedProperty = 'width';
  const frames = new Map(), timers = new Map(), listeners = new Map();
  const box = { x: 0, y: 0, width: 432, height: 700 };
  class Effect { getComputedTiming() { return {endTime:200}; } getKeyframes() { return [{[animatedProperty]:'432px'}]; } }
  const workbench = {
    querySelectorAll: () => [{ getBoundingClientRect: () => box }],
    getAnimations: () => moving ? [{playState:'running',effect:new Effect()}] : [],
  };
  const context = {
    innerWidth:432, KeyframeEffect:Effect, performance:{now:()=>now}, document:{querySelector:()=>workbench,addEventListener:(event,listener)=>listeners.set(event,listener),removeEventListener:event=>listeners.delete(event)},
    window:{addEventListener:(event,listener)=>listeners.set(event,listener),removeEventListener:event=>listeners.delete(event)},
    requestAnimationFrame:callback=>{frames.set(++identity,callback);return identity;}, cancelAnimationFrame:id=>frames.delete(id),
    setTimeout:callback=>{timers.set(++identity,callback);return identity;}, clearTimeout:id=>timers.delete(id),
  };
  const pending = vm.runInNewContext(`(${waitForCodeLayout.toString()})(1072)`,context);
  return {
    pending, context, box, moving:(value,property='width')=>{moving=value;animatedProperty=property;}, frames, timers, listeners,
    tick(time) { now=time;const callbacks=[...frames.values()];frames.clear();for(const callback of callbacks) callback(time); },
  };
}

test('Code layout acknowledgement requires the expected child viewport and settled workbench, then releases its observers',async()=>{
  const host=layoutFrame();let completed=false;void host.pending.then(()=>{completed=true;});
  host.tick(0);host.tick(200);await Promise.resolve();assert.equal(completed,false);
  host.context.innerWidth=1072;host.box.width=1072;host.tick(220);
  host.moving(true);host.tick(380);await Promise.resolve();assert.equal(completed,false);
  host.moving(false);host.box.x=240;host.tick(400);host.tick(500);await Promise.resolve();assert.equal(completed,false);
  host.tick(540);await host.pending;
  assert.equal(host.frames.size,0);assert.equal(host.timers.size,0);assert.equal(host.listeners.size,0);
});

test('Code layout barriers release resources on deadline and frame closure',async()=>{
  for(const reason of ['deadline','pagehide','cancel']) {
    const host=layoutFrame();
    const rejected=reason==='cancel'?host.pending:assert.rejects(host.pending,/editor.*(settle|closed)/);
    if(reason==='deadline') [...host.timers.values()][0](); else host.listeners.get(reason==='cancel'?'elevenex-code-layout-cancel':'pagehide')();
    await rejected;
    assert.equal(host.frames.size,0);assert.equal(host.timers.size,0);assert.equal(host.listeners.size,0);
  }
});

test('Code layout settlement ignores caret opacity animations that cannot move panes',async()=>{
  const host=layoutFrame();host.context.innerWidth=1072;host.box.width=1072;host.moving(true,'opacity');
  host.tick(0);host.tick(140);await host.pending;
  assert.equal(host.frames.size,0);assert.equal(host.timers.size,0);
});

test('Code controls accept resource identities and bounded file positions, never transport or shell inputs', () => {
  const target = { taskId: 1, scopeId: 'a'.repeat(36) };
  assert.deepEqual(validate.target(target), target);
  for (const input of [{ ...target, url: 'https://example.com' }, { ...target, taskId: -1 }, { ...target, scopeId: 'old' }]) assert.throws(() => validate.target(input));
  for (const path of ['/absolute', '../escape', 'file/../escape', '.git/config', 'a\0']) assert.throws(() => validate.file({ path }));
  assert.deepEqual(validate.file({ path: 'unicode é #?.ts', line: 10, column: 2 }), { path: 'unicode é #?.ts', line: 10, column: 2 });
  assert.throws(() => validate.file({ path: 'ok', line: 1.2 }));
  for (const action of ['browse-files', 'dismiss-files', 'find-file', 'search-text', 'save']) assert.equal(validate.action(action), action);
  for (const action of ['workbench.action.terminal.new', 'raw-shell', null, { action: 'save' }]) assert.throws(() => validate.action(action));
  assert.deepEqual(validate.presentation({visible:true,compact:false}),{visible:true,compact:false});
  assert.deepEqual(validate.presentation({visible:true,compact:false,viewportWidth:1072}),{visible:true,compact:false,viewportWidth:1072});
  for (const viewportWidth of [0,-1,1.5,NaN,Infinity,20001,'1072',null]) assert.throws(()=>validate.presentation({visible:true,compact:false,viewportWidth}));
  for (const value of [null,{visible:'yes',compact:false},{visible:true,compact:false,url:'https://example.com'}]) assert.throws(()=>validate.presentation(value));
  assert.throws(() => validate.bounds({ x: -1, y: 50, width: 600, height: 500 }));
  assert.throws(() => validate.reply('directory', { entries: Array(201).fill({ name: 'a', type: 1 }), next: null }));
  assert.throws(() => validate.reply('read', { content: '', revision: 'not a revision' }));
  assert.throws(() => validate.descriptor({ version: 1, taskId: 2, identity: 'a'.repeat(64), storageIdentity: 'a'.repeat(64), name: 'wrong', branch: '' }, 1));
});

test('Code HTTPS is confined to its task origin, rejects foreign origins, confines assets and stale scopes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'new-code-protocol-'));
  let exits = 0;
  const presentations = [];
  const client = new BackendClient(() => null, () => {}); client.attach(1);
  const host = new CodeProtocol(client, 1, { taskId: 1, scopeId: 'a'.repeat(36) }, { version: 1, taskId: 1, identity: 'a'.repeat(64), storageIdentity: 'a'.repeat(64), name: 'task', branch: 'branch' }, root, root, () => false, () => {}, () => exits++, 'app://elevenex', 'a'.repeat(64), (filesOpen,hasEditors)=>presentations.push({filesOpen,hasEditors}));
  try {
    assert.equal(host.allows('https://example.com'), false); assert.equal(host.allows(`https://user@${host.authority}/`), false);
    const request = (path, options = {}) => host.handle(new globalThis.Request(`https://${host.authority}${path}`, options));
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
    const presentation = body => request('/api/presentation',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    assert.equal((await presentation({generation:'a'.repeat(64),transportRevision:0,filesOpen:true,hasEditors:true})).status,200);
    assert.deepEqual(presentations,[{filesOpen:true,hasEditors:true}]);
    assert.equal((await presentation({generation:'a'.repeat(64),transportRevision:0,filesOpen:'yes',hasEditors:true})).status,400);
    assert.equal((await presentation({generation:'a'.repeat(64),transportRevision:0,filesOpen:true,hasEditors:true,path:'/secret'})).status,400);
    assert.equal((await (await presentation({generation:'old',transportRevision:0,filesOpen:false,hasEditors:false})).json()).accepted,false);
    assert.equal(presentations.length,1);

    host.bind({ taskId: 1, scopeId: 'b'.repeat(36) });
    assert.equal((await changes()).status, 503, 'A rebinding workbench must reconcile before idle polling can pause');
    const extension = await request('/extension-v2/extension.js');
    assert.equal(extension.status,200); assert.equal(extension.headers.get('Cache-Control'),'no-store');
    assert.equal((await request('/extension-v2/package.json')).status,200);
    await mkdir(join(root, 'out'));  await writeFile(join(root, 'out/safe.js'), 'export {};');
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
