const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { BrowserDriverLease } = require('../dist/browser/driver');
const { browserUrl, command, agentCommand, layout, intersect, loopback } = require('../dist/browser/validation');
const { BrowserPersistence } = require('../dist/browser/persistence');
const id = '11111111-1111-4111-8111-111111111111';

test('tab moves validate stable anchors and remain unavailable to agent commands', () => {
  for (const beforeTabId of [null, id]) assert.deepEqual(command({ kind: 'move-tab', tabId: id, beforeTabId }), { kind: 'move-tab', tabId: id, beforeTabId });
  for (const beforeTabId of [undefined, 0, 'missing', [], {}]) assert.throws(() => command({ kind: 'move-tab', tabId: id, beforeTabId }));
  assert.throws(() => command({ kind: 'move-tab', tabId: id, beforeTabId: null, tabs: [] }));
  assert.throws(() => agentCommand({ kind: 'move-tab', tabId: id, generation: 1, beforeTabId: null }));
});

test('tab input requires an agent lease; takeover invalidates every previously queued generation', () => {
  const lease = new BrowserDriverLease('you');
  assert.throws(() => lease.assert(1));
  lease.handBack(2); const generation = lease.generation; lease.assert(generation);
  lease.takeOver(); assert.equal(lease.waiting, true); assert.throws(() => lease.assert(generation));
  lease.handBack(2); assert.throws(() => lease.assert(generation)); lease.assert(lease.generation, 2); assert.throws(() => lease.assert(lease.generation, 3));
  lease.takeOver(true); assert.equal(lease.driver, 'needs'); assert.throws(() => lease.assert(lease.generation));
});
test('user Stop survives presentation revocation until explicit handoff', () => {
  const lease = new BrowserDriverLease('you');
  assert.equal(lease.agentPaused, false);
  lease.handBack(2);
  lease.takeOver(false, false);
  assert.equal(lease.agentPaused, false, 'A UI-only revocation allows fresh acquisition');
  lease.handBack(2);
  lease.stopAgent();
  lease.takeOver(false, false);
  assert.equal(lease.agentPaused, true);
  assert.equal(lease.waiting, true);
  lease.handBack(2);
  assert.equal(lease.agentPaused, false);
  lease.takeOver(true);
  assert.equal(lease.agentPaused, true, 'Human workflows cannot be reclaimed');
});
test('navigation and tools reject privileged protocols, credentials, unknown fields and invalid coordinates', () => {
  for (const url of ['javascript:alert(1)', 'file:///etc/passwd', 'app://elevenex', 'https://user:pass@example.com', 'https://example.com/\nsecret']) assert.throws(() => browserUrl(url));
  for (const value of ['http://127.1', 'http://2130706433', 'http://localhost.', 'http://x.localhost', 'http://[::ffff:127.0.0.1]', 'http://127.0.0.2']) assert.equal(loopback(new URL(value)), true);
  assert.equal(loopback(new URL('https://example.com')), false);
  assert.equal(browserUrl('https://example.com/'), 'https://example.com/');
  assert.deepEqual(command({ kind: 'new-tab' }), { kind: 'new-tab' });
  assert.deepEqual(command({ kind: 'forward', tabId: id }), { kind: 'forward', tabId: id });
  assert.throws(() => command({ kind: 'forward', tabId: id, url: 'https://example.com' }));
  assert.throws(() => command({ kind: 'forward', tabId: 'missing' }));
  assert.throws(() => command({ kind: 'new-tab', url: 'file:///etc/passwd' }));
  assert.throws(() => agentCommand({ kind: 'new-tab' }));
  assert.throws(() => command({ kind: 'open', url: 'https://example.com', preload: '/tmp/unsafe' }));
  assert.throws(() => agentCommand({ kind: 'type', tabId: id, generation: 1, text: 'secret' }));
  assert.throws(() => agentCommand({ kind: 'click', tabId: id, generation: 1, x: NaN, y: 2, step: 'Click' }));
  assert.throws(() => command({ kind: 'theme', tabId: id, theme: 'custom-css' }));
  assert.throws(() => layout({ sequence: 1, visible: true, reducedMotion: false, bounds: { x: 1, y: 1, width: Infinity, height: 1 } }));
  assert.deepEqual(intersect({ x: 90.2, y: 5, width: 200, height: 100 }, 120, 80), { x: 91, y: 5, width: 29, height: 75 });
});
test('task navigation persistence bounds tabs and strips credential-bearing query/fragment on restore', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ex-browser-test-'));
  try {
    const store = new BrowserPersistence(root);
    store.save('machine:task:1', { active: 0, tabs: [{ url: 'https://example.com/account?token=private#code', width: 'phone' }] });
    await store.flush();
    assert.deepEqual(await store.read('machine:task:1'), { active: 0, tabs: [{ url: 'https://example.com/account', width: 'phone' }] });
    assert.equal(await store.read('other-machine:task:1'), null);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('automation expiry and disposal revoke a late action before input and stop polling', async context => {
  const { BrowserAutomation } = require('../dist/browser/automation');
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const lease = new BrowserDriverLease('agent', 2);
  let release; const delayed = new Promise(resolve => { release = resolve; });
  let accepted = 0, reads = 0;
  const task = { scopeId: 'scope', taskId: 1, setPorts: () => undefined,
    revoke: () => lease.takeOver(),
    agent: async (input, session, signal) => {
      assert.equal(input.kind, 'click');
      const abort = () => { if (lease.driver === 'agent' && lease.generation === 1) lease.takeOver(); };
      signal.addEventListener('abort', abort, { once: true });
      try { await delayed; lease.assert(1, session); accepted++; return { tabs: [], observation: 'withheld', message: '' }; }
      finally { signal.removeEventListener('abort', abort); }
    },
  };
  const client = { state: () => ({ scope: { id: 'scope' } }), cancel: () => undefined,
    execute: async () => ({ ok: true, value: { ports: [], command: ++reads === 1 ? { id, sessionId: 2, input: { kind: 'click', tabId: id, generation: 1, x: 1, y: 1, step: 'Test' } } : null } }),
  };
  const automation = new BrowserAutomation(1, client);
  const settle = async () => { for (let n = 0; n < 12; n++) await Promise.resolve(); };
  automation.select(task); context.mock.timers.tick(0); await settle();
  assert.equal(reads, 1); context.mock.timers.tick(2000); await settle();
  assert.equal(lease.driver, 'you');
  release(); await settle(); assert.equal(accepted, 0, 'Expired DOM work must never dispatch late input');
  context.mock.timers.tick(400); await settle(); assert.equal(reads, 2, 'Timed-out observation must not block reconciliation');
  automation.dispose(); const previous = reads; context.mock.timers.tick(10000); await settle(); assert.equal(reads, previous);
});

test('public proxy destinations reject private, rebound and reserved addresses', () => {
  const { publicBrowserAddress } = require('@elevenex/browser-network');
  for (const value of ['127.0.0.1', '0.0.0.0', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '192.0.2.1', '198.18.0.1', '203.0.113.1', '224.0.0.1', '::1', '::ffff:127.0.0.1', 'fd00::1', 'fe80::1', '2001:db8::1', '2001::1', '3fff::1']) assert.equal(publicBrowserAddress(value), false, value);
  for (const value of ['8.8.8.8', '1.1.1.1', '192.0.78.24', '2001:4860:4860::8888']) assert.equal(publicBrowserAddress(value), true, value);
});

test('task SOCKS transport bounds handshakes, preserves streams and closes owned sockets', async context => {
  const { createServer, createConnection } = require('node:net');
  const { once } = require('node:events');
  const { browserSocks } = require('@elevenex/browser-network');
  const echo = createServer(socket => socket.pipe(socket));
  await new Promise(resolve => echo.listen(0, '127.0.0.1', resolve));
  context.after(() => new Promise(resolve => echo.close(resolve)));
  let resolutions = 0;
  const proxy = await browserSocks(async () => { resolutions++; return { host: '127.0.0.1', port: echo.address().port }; });
  context.after(() => proxy.close());
  const bad = createConnection(proxy.port, '127.0.0.1'); bad.on('error', () => undefined);
  const badClosed = once(bad, 'close'); bad.end(Buffer.alloc(1100, 65)); await badClosed;
  assert.equal(resolutions, 0, 'An invalid browser request must not become a connector');
  const client = createConnection(proxy.port, '127.0.0.1'); client.on('error', () => undefined);
  const greeting = once(client, 'data'); client.write(Buffer.from([5, 1, 0])); assert.deepEqual((await greeting)[0], Buffer.from([5, 0]));
  const connected = once(client, 'data'); client.write(Buffer.from([5, 1, 0, 1, 127, 0, 0, 1, 0x12, 0x34]));
  assert.equal((await connected)[0][1], 0);
  const response = once(client, 'data'); client.write('opaque task data'); assert.equal((await response)[0].toString(), 'opaque task data');
  const closed = once(client, 'close'); proxy.disconnect(); await closed; assert.equal(resolutions, 1);
});

test('stream input rejects unrestricted commands, unbounded text, invalid pointers and clipboard verbs', () => {
  const { streamInput } = require('../dist/browser/validation');
  for (const value of [{kind:'eval',code:'secret'}, {kind:'text',text:'x'.repeat(65537)}, {kind:'clipboard',operation:'readAll'}, {kind:'pointer',type:'down',x:-1,y:1,button:'left',buttons:1,clicks:1,modifiers:0}]) assert.throws(()=>streamInput(value));
  assert.deepEqual(streamInput({kind:'text',text:'世界'}), {kind:'text',text:'世界'});
});

test('SOCKS races pinned addresses without another DNS lookup when the first family is unavailable', async context => {
  const { createServer, createConnection } = require('node:net');
  const { once } = require('node:events');
  const { browserSocks } = require('@elevenex/browser-network');
  const echo = createServer(socket => socket.pipe(socket));
  await new Promise(resolve => echo.listen(0, '127.0.0.1', resolve));
  context.after(() => new Promise(resolve => echo.close(resolve)));
  const proxy = await browserSocks(async () => ({ host: 'pinned.invalid', port: echo.address().port, addresses: [
    { address: '::1', family: 6 }, { address: '127.0.0.1', family: 4 },
  ] }));
  context.after(() => proxy.close());
  const client = createConnection(proxy.port, '127.0.0.1');
  context.after(() => client.destroy());
  client.on('error', () => undefined);
  const greeting = once(client, 'data'); client.write(Buffer.from([5, 1, 0])); await greeting;
  const connected = once(client, 'data'); client.write(Buffer.from([5, 1, 0, 1, 1, 1, 1, 1, 0, 80]));
  assert.equal((await connected)[0][1], 0);
  const response = once(client, 'data'); client.write('pinned transport');
  assert.equal((await response)[0].toString(), 'pinned transport');
  client.destroy();
});

test('display stream bounds pending frames, authenticates receipts, adapts to slow consumers and stops on disposal', async context => {
  const { EventEmitter } = require('node:events');
  const { BrowserFrameStream } = require('../dist/browser/frame-stream');
  context.mock.timers.enable({apis:['setTimeout']});
  const debuggerApi=new EventEmitter();const commands=[];
  debuggerApi.isAttached=()=>true; debuggerApi.sendCommand=async(method,params)=>{commands.push({method,params});};
  const contents={debugger:debuggerApi,isDestroyed:()=>false};
  const frames=[];const stream=new BrowserFrameStream(contents,{scopeId:id,taskId:1,tabId:id},frame=>frames.push(frame));
  stream.setActive(true);await Promise.resolve();
  const frame=n=>debuggerApi.emit('message',{},'Page.screencastFrame',{sessionId:n,data:Buffer.from('image'+n).toString('base64'),metadata:{deviceWidth:390,deviceHeight:600}});
  frame(1);frame(2);frame(3);assert.equal(frames.length,1);
  stream.acknowledge('unrelated',1);assert.equal(frames.length,1);
  stream.acknowledge(frames[0].streamId,1);assert.equal(frames.length,2);assert.equal(Buffer.from(frames[1].jpeg).toString(),'image3');
  context.mock.timers.tick(1000);await Promise.resolve();assert.equal(commands.at(-1).method,'Page.stopScreencast');
  stream.destroy();assert.equal(debuggerApi.listenerCount('message'),0);frame(4);assert.equal(frames.length,2);
});

test('guest attachment accepts only a main-issued blank partition and removes inherited privileges', () => {
  const { hardenTaskGuest } = require('../dist/browser/guest-policy');
  for (const params of [{src:'https://evil.example',partition:id},{src:'about:blank',partition:'persist:default'},{src:'about:blank',partition:id,preload:'/unsafe'},{src:'about:blank',partition:id,webpreferences:'nodeIntegration=true'}]) assert.equal(hardenTaskGuest({},params,id),false);
  const prefs={preload:'/app-preload',nodeIntegration:true,sandbox:false,contextIsolation:false,webSecurity:false};
  assert.equal(hardenTaskGuest(prefs,{src:'about:blank',partition:id},id),true);
  assert.equal(prefs.preload,undefined);assert.equal(prefs.sandbox,true);assert.equal(prefs.contextIsolation,true);assert.equal(prefs.nodeIntegration,false);assert.equal(prefs.webSecurity,true);assert.equal(prefs.webviewTag,false);
});

const {remoteBrowserState}=require('../dist/browser/remote-state');
test('remote browser replies are bounded, resource matched and content allowlisted',()=>{
  const value={taskId:1,revision:1,surfaceEpoch:1,controlsFocus:0,tabs:[],active:null,ports:[],privacy:'content-withheld',picked:null,picking:false,pickerMessage:null,feedback:false,pageText:'never forward this'};
  assert.equal(remoteBrowserState(value,'scope',1).scopeId,'scope');
  assert.equal('pageText' in remoteBrowserState(value,'scope',1),false);
  const tab = { id, title: 'Page', url: 'https://example.com/', by: 'you', driver: 'you', agentSessionId: null, generation: 1, loading: false, ready: true, canGoBack: true, error: null, errors: 0, width: 'full', theme: 'system', slowNetwork: false, waiting: false };
  const withTab = { ...value, tabs: [tab], active: id };
  const step = { n: 2, total: 3, text: 'Waiting for results', status: 'waiting' };
  const agentCursor = { x: 50, y: 70, pulse: 3 };
  const agentHighlight = { x: 30, y: 50, width: 100, height: 40, label: 'Save' };
  const decorated = remoteBrowserState({ ...withTab, tabs: [{ ...tab, step, agentCursor: { ...agentCursor, script: 'withheld' }, agentHighlight }] }, 'scope', 1).tabs[0];
  assert.deepEqual(decorated.step, step); assert.deepEqual(decorated.agentCursor, agentCursor); assert.deepEqual(decorated.agentHighlight, agentHighlight);
  for (const change of [{ agentCursor: { ...agentCursor, x: NaN } }, { agentCursor: { ...agentCursor, pulse: -1 } }, { agentHighlight: { ...agentHighlight, width: -1 } }, { step: { ...step, status: 'html' } }])
    assert.throws(() => remoteBrowserState({ ...withTab, tabs: [{ ...tab, ...change }] }, 'scope', 1));
  const hovered = { tag: 'button', x: 10, y: 20, width: 100, height: 30 };
  assert.deepEqual(remoteBrowserState({ ...withTab, tabs: [{ ...tab, hovered: { ...hovered, text: 'private', attributes: ['value', 'secret'] } }] }, 'scope', 1).tabs[0].hovered, hovered);
  for (const change of [{ x: NaN }, { width: -1 }, { height: Infinity }, { tag: '<script>' }]) assert.throws(() => remoteBrowserState({ ...withTab, tabs: [{ ...tab, hovered: { ...hovered, ...change } }] }, 'scope', 1));
  const picked = { selector: 'html > body:nth-child(1) > button:nth-child(1)', tag: 'button', x: 1, y: 1, width: 20, height: 20 };
  const source = { file: 'src/App.tsx', line: 88, column: 7, kind: 'react-source-map' };
  assert.deepEqual(remoteBrowserState({ ...withTab, picked: { ...picked, source: { ...source, props: 'secret' } } }, 'scope', 1).picked.source, source);
  for (const metadata of [undefined, { ...source, line: -1 }, { ...source, file: '../secret.tsx' }, { ...source, file: 'app.tsx?token=secret' }]) {
    assert.deepEqual(remoteBrowserState({ ...withTab, picked: { ...picked, source: metadata } }, 'scope', 1).picked, picked);
  }
  const componentSource = { file: 'src/Checkout.vue', framework: 'vue' };
  assert.deepEqual(remoteBrowserState({ ...withTab, picked: { ...picked, componentSource: { ...componentSource, props: 'secret' } } }, 'scope', 1).picked.componentSource, componentSource);
  assert.equal(remoteBrowserState({ ...withTab, picked: { ...picked, componentSource: { ...componentSource, line: 0 } } }, 'scope', 1).picked.componentSource, undefined);
  assert.equal(remoteBrowserState({ ...withTab, picked: { ...picked, source, componentSource } }, 'scope', 1).picked.componentSource, undefined);
  assert.equal(remoteBrowserState(withTab, 'scope', 1).tabs[0].canGoForward, false);
  assert.equal(remoteBrowserState({ ...withTab, tabs: [{ ...tab, canGoForward: true }] }, 'scope', 1).tabs[0].canGoForward, true);
  assert.throws(() => remoteBrowserState({ ...withTab, tabs: [{ ...tab, canGoForward: 'true' }] }, 'scope', 1));
  for(const invalid of [{...value,taskId:2},{...value,ports:Array(33).fill(80)},{...value,ports:[0]},{...value,privacy:'masked'},{...value,revision:Infinity},{...value,picked:{selector:'input[value=secret]',tag:'input',x:0,y:0,width:1,height:1}},{...value,attention:{kind:'eval',message:'x',outside:true}}])assert.throws(()=>remoteBrowserState(invalid,'scope',1));
});

const {nativeBrowserInput}=require('../dist/browser/native-input');
test('unresponsive page observation expires without dispatching late native input',async()=>{
  let dispatched=0,release;
  const pending=new Promise(resolve=>{release=resolve;});
  const contents={executeJavaScriptInIsolatedWorld:()=>pending,isDestroyed:()=>true};
  const result=await nativeBrowserInput(contents,async()=>{dispatched++;},()=>undefined,'click');
  assert.equal(result,false);release();await Promise.resolve();assert.equal(dispatched,0);
});

test('human input batches exclude nesting and clipboard, and bound events and aggregate text',()=>{
  const {streamInput}=require('../dist/browser/validation');
  const event={kind:'text',text:'界'};
  assert.deepEqual(streamInput({kind:'batch',events:[event,event]}),{kind:'batch',events:[event,event]});
  for(const events of [[],Array(33).fill(event),[{kind:'batch',events:[event]}],[{kind:'clipboard',operation:'paste'}],[{kind:'text',text:'x'.repeat(65536)},event]])assert.throws(()=>streamInput({kind:'batch',events}));
});


test('detached-window labels are bounded presentation data with no executable settings', () => {
  const { windowContext } = require('../dist/browser/validation');
  const context = { projectName: 'Elevenex', taskName: 'Checkout', branchName: 'feat/checkout', machineName: 'This Mac', stage: 'active', hue: 'pine' };
  assert.deepEqual(windowContext(context), context);
  for (const invalid of [{ ...context, preload: '/unsafe' }, { ...context, taskName: 'x'.repeat(257) }, { ...context, projectName: 'bad\nlabel' }, { ...context, stage: 'running' }, { ...context, hue: 'url(secret)' }]) assert.throws(() => windowContext(invalid));
});

test('human input satisfies the shared desktop/runtime protocol cases', () => {
  const { streamInput } = require('../dist/browser/validation');
  for (const { valid, input } of require('../../../test/fixtures/task-browser-input.json')) {
    if (valid) assert.deepEqual(streamInput(input), input);
    else assert.throws(() => streamInput(input), JSON.stringify(input));
  }
});

test('a late native screencast start reconciles the current visible presentation', async () => {
  const { EventEmitter } = require('node:events');
  const { BrowserFrameStream } = require('../dist/browser/frame-stream');
  const debuggerApi = new EventEmitter(), commands = [];
  let release;
  debuggerApi.isAttached = () => true;
  debuggerApi.sendCommand = method => {
    commands.push(method);
    if (commands.length === 1) return new Promise(resolve => { release = resolve; });
    return Promise.resolve();
  };
  const stream = new BrowserFrameStream({ debugger: debuggerApi, isDestroyed: () => false }, { scopeId: id, taskId: 1, tabId: id }, () => undefined);
  stream.setActive(true); stream.setActive(false); stream.setActive(true);
  release();
  for (let i = 0; i < 20; i++) await Promise.resolve();
  assert.equal(commands.at(-1), 'Page.startScreencast', 'An older completion must not leave a visible stream stopped');
  stream.destroy();
});

test('site workflow replies and relative input are human-only bounded intents', () => {
  const { streamInput } = require('../dist/browser/validation');
  const reply = { kind: 'dialog-response', tabId: id, requestId: id, accept: true, text: 'private response' };
  assert.deepEqual(command(reply), reply);
  assert.throws(() => command({ ...reply, text: 'x'.repeat(4097) }));
  assert.throws(() => command({ ...reply, filePath: '/etc/passwd' }));
  assert.throws(() => agentCommand({ ...reply, generation: 1 }));
  assert.throws(() => agentCommand({ kind: 'choose-files', tabId: id, requestId: id }));
  const relative = { kind: 'pointer-relative', deltaX: 10, deltaY: -10, buttons: 0, modifiers: 0 };
  assert.deepEqual(streamInput(relative), relative);
  assert.throws(() => streamInput({ ...relative, deltaX: Infinity }));
  assert.throws(() => streamInput({ ...relative, deltaY: 10001 }));
});

test('code mailbox keeps polling during concurrent scripts and cancels revoked IDs', async context => {
  const { BrowserAutomation } = require('../dist/browser/automation');
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const ids = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'];
  const started = [], signals = [], completions = [];
  let reads = 0, running = [], currentScope = 'scope';
  const task = { scopeId: 'scope', taskId: 1, setPorts: () => {}, revoke: () => {},
    code: (session, command, signal) => {
      started.push(session); signals.push(signal);
      return new Promise(resolve => completions.push(() => resolve({ sandboxId: 'test', value: command.code, logs: [], images: [] })));
    },
  };
  const client = { state: () => ({scope: {id: currentScope}}), cancel: () => {},
    execute: async () => {
      const index = reads++;
      const id = ids[index];
      if (id) running.push(id);
      return {ok: true, value: {ports: [], running, command: id ? {id, sessionId: index + 2, input: {kind: 'code', code: 'return 42', timeoutMs: 15000}} : null}};
    },
  };
  const settle = async () => { for (let n = 0; n < 20; n++) await Promise.resolve(); };
  const automation = new BrowserAutomation(1, client);
  try {
    automation.select(task); context.mock.timers.tick(0); await settle();
    context.mock.timers.tick(150); await settle();
    assert.deepEqual(started, [2, 3], 'Two sessions execute without waiting for the first script');
    running = [ids[1]]; context.mock.timers.tick(150); await settle();
    assert.equal(signals[0].aborted, true); assert.equal(signals[1].aborted, false);
    assert.ok(reads >= 3, 'Heartbeats continue while code is running');
    currentScope = 'new-scope'; context.mock.timers.tick(150); await settle();
    assert.equal(signals[1].aborted, true, 'Scope changes cancel all remaining code');
  } finally {
    automation.dispose(); for (const complete of completions) complete(); await settle();
  }
});
