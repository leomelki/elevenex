const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { CodeFrameRouter } = require('../dist/code/frame-router');

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
