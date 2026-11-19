const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { CodeFrameRouter } = require('../dist/code/frame-router');
const { markdownPreviewEndpoint } = require('../dist/code/markdown-preview');

function setup() {
  let request, filter, permission, check;
  const session = {
    protocol: { handle: (_scheme, fn) => { request = fn; }, unhandle: () => {} },
    webRequest: { onBeforeRequest: (...args) => { filter = args.at(-1); } },
    setPermissionRequestHandler: fn => { permission = fn; },
    setPermissionCheckHandler: fn => { check = fn; }, setDevicePermissionHandler: () => {},
  };
  const router = new CodeFrameRouter(session);
  const a = 'https://a.code.elevenex.invalid', b = 'https://b.code.elevenex.invalid';
  const host = origin => ({ windowId: 1, authority: new URL(origin).host, active: true, allows: url => url === origin || url.startsWith(origin + '/'), handle: async () => new globalThis.Response('private') });
  const first = host(a), second = host(b); router.add(first); router.add(second);
  const contents = Object.assign(new EventEmitter(), {id:1,mainFrame:{},getURL:()=> 'app://elevenex/'});
  return {router,a,b,first,contents,request: (...args) => request(...args),filter: d => { let result; filter(d,v=>{result=v;}); return result; },permission: (...args) => permission(...args),check:(...args)=>check(...args)};
}
test('iframe requests require both window ownership and the correct task initiator', async () => {
  const {router,a,b,contents,filter,request,first}=setup();
  const root = {url:a+'/',webContentsId:1,webContents:contents,resourceType:'subFrame',initiatorOrigin:'app://elevenex',frame:{parent:contents.mainFrame}};
  assert.equal(filter(root).cancel,false);
  const api = {...root,url:a+'/api/read',resourceType:'xhr',initiatorOrigin:a};
  assert.equal(filter(api).cancel,false);
  for (const change of [{webContentsId:2},{initiatorOrigin:b},{initiatorOrigin:'https://evil.invalid'},{initiatorOrigin:undefined,frame:null},{resourceType:'mainFrame'},{url:'https://evil.invalid'}]) assert.equal(filter({...api,...change}).cancel,true);
  assert.equal(filter({...root,initiatorOrigin:b}).cancel,true);
  assert.equal((await request(new globalThis.Request('https://unknown.invalid'))).status,403);
  router.remove(first); assert.equal(filter(api).cancel,true); router.dispose();
});
test('frame navigation, permissions and handler cleanup stay confined to owned editors', () => {
  const {router,a,b,contents,permission,check}=setup();
  const stop=router.attach(contents);
  const navigate=(url,parent)=>{let blocked=false;contents.emit('will-frame-navigate',{isMainFrame:false,url,frame:{parent},preventDefault:()=>{blocked=true;}});return blocked;};
  assert.equal(navigate(a+'/',contents.mainFrame),false);
  assert.equal(navigate('https://evil.invalid',contents.mainFrame),true);
  assert.equal(navigate(b+'/',{url:a+'/'}),true);
  let allowed;
  permission({id:1,isFocused:()=>true},'clipboard-sanitized-write',v=>{allowed=v;},{requestingUrl:a+'/'}); assert.equal(allowed,true);
  permission({id:2,isFocused:()=>true},'clipboard-sanitized-write',v=>{allowed=v;},{requestingUrl:a+'/'}); assert.equal(allowed,false);
  assert.equal(check({id:1},'camera',a),false);
  assert.equal(check({id:1},'persistent-storage',a),true);
  stop(); assert.equal(contents.listenerCount('will-frame-navigate'),0); router.dispose();
});

test('Markdown navigation and worker requests stay on the owning task’s preview origin', () => {
  const {router,a,b,contents,filter}=setup();
  const stop = router.attach(contents);
  const base = markdownPreviewEndpoint(new URL(a).hostname).replace('{{uuid}}', 'a'.repeat(52));
  const origin = new URL(base).origin;
  const indexUrl = new URL('index.html', base);
  indexUrl.searchParams.set('extensionId', 'vscode.markdown-language-features');
  indexUrl.searchParams.set('parentOrigin', a);
  const index = indexUrl.href;
  const inner = `${base}fake.html?id=preview`;
  const editor = { url: a + '/', parent: contents.mainFrame };
  const preview = { url: index, parent: editor };
  const navigationAllowed = (url, parent) => {
    let allowed = true;
    contents.emit('will-frame-navigate', { isMainFrame: false, url, frame: { parent }, preventDefault: () => { allowed = false; } });
    return allowed;
  };
  try {
    assert.equal(navigationAllowed(index, editor), true);
    assert.equal(navigationAllowed(index, contents.mainFrame), false);
    assert.equal(navigationAllowed(inner, preview), true);
    assert.equal(navigationAllowed(inner, editor), false);
    assert.equal(navigationAllowed(a + '/', preview), false);
    const bootstrap = { url: index, webContentsId: 1, resourceType: 'subFrame', initiatorOrigin: a };
    assert.equal(filter(bootstrap).cancel, false);
    assert.equal(filter({ ...bootstrap, webContentsId: 2 }).cancel, true);
    assert.equal(filter({ ...bootstrap, initiatorOrigin: b }).cancel, true);
    assert.equal(filter({ ...bootstrap, url: index.replace('markdown-language-features', 'unrelated') }).cancel, true);
    assert.equal(filter({ ...bootstrap, url: inner, initiatorOrigin: origin }).cancel, false);
    assert.equal(filter({ ...bootstrap, url: a + '/api/read', initiatorOrigin: origin, resourceType: 'xhr' }).cancel, true);
    const renderer = { url: a + '/assets/extensions/markdown-language-features/media/pre.js', webContentsId: 1, method: 'GET', resourceType: 'script', initiatorOrigin: origin };
    assert.equal(filter(renderer).cancel, false);
    assert.equal(filter({ ...renderer, url: renderer.url.replace(a, b) }).cancel, true);
    assert.equal(filter({ ...renderer, url: a + '/assets/out/nls.messages.js' }).cancel, true);
    assert.equal(filter({ ...renderer, resourceType: 'subFrame' }).cancel, true);
    const local = { ...renderer, url: 'http://127.0.0.1:4300/', resourceType: 'image' };
    assert.equal(filter(local).cancel, true);
    assert.equal(filter({ ...local, initiatorOrigin: 'http://127.0.0.1:4300' }).cancel, false);
    const worker = { url: `${base}service-worker.js?v=6`, method: 'GET', resourceType: 'script', initiatorOrigin: origin };
    assert.equal(filter(worker).cancel, false);
    assert.equal(filter({ ...worker, webContentsId: 2 }).cancel, true);
    assert.equal(filter({ ...worker, initiatorOrigin: a }).cancel, true);
    assert.equal(filter({ ...worker, initiatorOrigin: undefined }).cancel, true);
    assert.equal(filter({ ...worker, url: base + 'arbitrary.js' }).cancel, true);
  } finally { stop(); router.dispose(); }
});
