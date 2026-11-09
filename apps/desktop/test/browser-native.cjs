const {mkdtemp,readFile,rm,access}=require('node:fs/promises');
const {tmpdir}=require('node:os');
const {join}=require('node:path');
const {setInterval,clearInterval}=require('node:timers');
const assert = require('node:assert/strict');
const { webContents, BrowserWindow, WebContentsView, session, net, app } = require('electron');
const { setTimeout: delay } = require('node:timers/promises');
async function until(check, message, timeout = 6000) { const end = Date.now() + timeout; while (Date.now() < end) { const value = await check(); if (value) return value; await delay(25); } throw new Error(message); }
module.exports = async function browserSmoke(window, scope, url, backendUrl = url) {
  const call = async (method, ...args) => {
    if (method === 'taskBrowserLayout') {
      if (!args[2].testStale) args[2].sequence=Math.floor(performance.now()*1000);
      delete args[2].testStale;
      const snapshot = await window.webContents.executeJavaScript(`window.elevenex.taskBrowserRead(...${JSON.stringify(args.slice(0, 2))})`);
      args[2] = { inputReady: true, ownerGeneration: snapshot.value.tabs.find(tab => tab.id === snapshot.value.active)?.generation ?? 0, ...args[2], surfaceEpoch: args[2].surfaceEpoch ?? snapshot.value.surfaceEpoch };
    }
    return window.webContents.executeJavaScript(`window.elevenex.${method}(...${JSON.stringify(args)})`);
  };
  const read = async (task = 1) => { const result = await call('taskBrowserRead', scope, task); assert.equal(result.ok, true, JSON.stringify(result)); return result.value; };
  const command = async input => { const result = await call('taskBrowserCommand', scope, 1, input); assert.equal(result.ok, true, JSON.stringify(result)); return result.value; };
  // A trusted test host exercises the same fixed guest attributes as the Angular host.
  await window.webContents.executeJavaScript(`(() => {
    const guests = new Map();
    const render = surfaces => {
      window.__browserSurfaces = surfaces;
      for (const surface of surfaces) {
        if (!surface.partition) { guests.get(surface.tabId)?.remove(); guests.delete(surface.tabId); continue; }
        let guest = guests.get(surface.tabId);
        if (guest && guest.__bootstrap !== surface.bootstrap) { guest.remove(); guests.delete(surface.tabId); guest = undefined; }
        if (!guest) { guest = document.createElement('webview'); guest.__bootstrap = surface.bootstrap; guest.setAttribute('partition', surface.partition); guest.setAttribute('src', surface.bootstrap); guest.addEventListener('dom-ready', () => { void window.elevenex.taskBrowserAttach(surface.scopeId, surface.taskId, surface.tabId, guest.getWebContentsId()); }, { once: true }); document.body.append(guest); guests.set(surface.tabId, guest); }
        Object.assign(guest.style, { position: 'fixed', display: 'flex', left: surface.visible ? surface.bounds.x / surface.zoom + 'px' : '-20000px', top: surface.bounds.y / surface.zoom + 'px', width: (surface.bounds.width / surface.zoom || 800) + 'px', height: (surface.bounds.height / surface.zoom || 600) + 'px' });
      }
      for (const [id, guest] of guests) if (!surfaces.some(surface => surface.tabId === id)) { guest.remove(); guests.delete(id); }
    };
    window.elevenex.onTaskBrowserSurfacesChanged(render); window.elevenex.taskBrowserSurfaces().then(render);
  })()`);
  await window.webContents.executeJavaScript(`window.__autoBrowserAck = true; void window.elevenex.onTaskBrowserFrame(frame => { window.__browserFrame = {streamId:frame.streamId,sequence:frame.sequence,bytes:frame.jpeg.byteLength,width:frame.width,height:frame.height}; if (window.__autoBrowserAck) void window.elevenex.taskBrowserFrameAck(frame.scopeId,frame.taskId,frame.tabId,frame.streamId,frame.sequence); });`);
  const visibleCount = () => window.webContents.executeJavaScript('(window.__browserSurfaces || []).filter(surface=>surface.visible).length');
  assert.deepEqual((await read()).availablePlacements, ['desktop'], 'Local tasks must not offer a remote streaming location');
  const configured = await call('taskBrowserConfigure', scope, 1, 'desktop-proxy');
  assert.equal(configured.ok, true); assert.equal(configured.value.placement, 'desktop-proxy');
  assert.equal(configured.value.capabilities.embedded, true);
  assert.equal((await call('taskBrowserConfigure', scope, 1, 'desktop')).ok, true);
  await assert.rejects(() => call('taskBrowserConfigure', scope, 1, 'arbitrary-shell'));
  assert.equal((await call('taskBrowserConfigure', scope, 1, 'machine')).ok, true);
  assert.equal((await read()).placement, 'machine');
  const blank = await command({ kind: 'new-tab' });
  assert.equal(blank.tabs.length, 1);
  assert.equal(blank.tabs[0].url, '');
  assert.equal(blank.tabs[0].title, 'New tab');
  assert.equal(blank.tabs[0].loading, false);
  await fetch(backendUrl + '/hold-browser-task');
  const supersededPlacement = call('taskBrowserConfigure', scope, 1, 'desktop-proxy');
  await until(async () => (await fetch(backendUrl + '/browser-task-pending').then(reply => reply.text())) === '1', 'Placement did not begin preparation');
  await read(3);
  await fetch(backendUrl + '/release-browser-task');
  assert.equal((await supersededPlacement).ok, false, 'Task selection must invalidate pending placement replacement');
  assert.equal((await call('taskBrowserCommand', scope, 3, { kind: 'feedback', enabled: false })).ok, true);
  assert.equal((await read()).active, blank.active);
  // Preparing another host must not destroy a page opened in the meantime.
  await fetch(backendUrl + '/hold-browser-task');
  const pendingPlacement = call('taskBrowserConfigure', scope, 1, 'desktop-proxy');
  await until(async () => (await fetch(backendUrl + '/browser-task-pending').then(reply => reply.text())) === '1', 'Placement did not begin preparation');
  let state = await command({ kind: 'navigate', tabId: blank.active, url: url + '/browser-test' });
  await fetch(backendUrl + '/release-browser-task');
  assert.equal((await pendingPlacement).ok, false, 'A live page must invalidate pending placement replacement');
  assert.equal((await read()).placement, 'machine');
  assert.equal((await read()).active, blank.active);
  assert.equal((await call('taskBrowserConfigure', scope, 1, 'machine')).ok, false, 'Live pages prevent destructive placement changes');
  const first = state.active;
  let native = await until(() => webContents.getAllWebContents().find(contents => contents !== window.webContents && contents.getURL().includes('/browser-test')), 'Browser page did not load');
  await until(async () => (await read()).tabs[0]?.loading === false, 'Browser page still loading');
  // Authorization arriving after a newer user decision cannot restore agent control.
  await fetch(backendUrl + '/hold-browser-authorization');
  const pendingHandoff = call('taskBrowserCommand', scope, 1, { kind: 'handoff', tabId: first, sessionId: 2 });
  await until(async () => (await fetch(backendUrl + '/browser-authorization-pending').then(reply => reply.text())) === '1', 'Handoff did not reach authorization');
  await command({ kind: 'takeover', tabId: first });
  await fetch(backendUrl + '/release-browser-authorization');
  assert.equal((await pendingHandoff).ok, false, 'Obsolete handoff must be rejected');
  assert.equal((await read()).tabs[0].driver, 'you');
  const prefs = native.getLastWebPreferences();
  assert.equal(prefs.sandbox, true); assert.equal(prefs.contextIsolation, true); assert.equal(prefs.nodeIntegration, false); assert.equal(prefs.preload, undefined); assert.equal(prefs.webSecurity, true); assert.equal(native.getWebRTCIPHandlingPolicy(),'disable_non_proxied_udp');
  let clientCertificatePrevented = false, clientCertificate = 'not-called';
  native.emit('select-client-certificate', { preventDefault: () => { clientCertificatePrevented = true; } }, 'https://untrusted.example', [], certificate => { clientCertificate = certificate; });
  assert.equal(clientCertificatePrevented, true); assert.equal(clientCertificate, undefined);
  assert.deepEqual(await native.executeJavaScript('({node:typeof require,bridge:typeof window.elevenex})'), { node: 'undefined', bridge: 'undefined' });
  const layout = { inputReady: true, sequence: 1, visible: true, reducedMotion: false, bounds: { x: 400, y: 200, width: 390, height: 350 } };
  await call('taskBrowserLayout', scope, 1, layout);
  await until(async()=>await visibleCount() === 1, 'Guest was not presented');
  assert.deepEqual(await window.webContents.executeJavaScript('window.__browserSurfaces.find(s=>s.visible).bounds'), layout.bounds);
  assert.equal(await window.webContents.executeJavaScript('window.__browserSurfaces.find(s=>s.visible).presentation'), 'embedded', 'Even legacy local machine placement must embed natively');
  await call('taskBrowserPresentation', scope, 1, first, 'embedded');
  // Hold a real link navigation before response headers: the old document stays visible.
  await call('taskBrowserLayout', scope, 1, layout);
  await until(async () => (await read()).tabs.find(tab => tab.id === first)?.ready, 'Direct page is not ready for native input');
  app.focus({ steal: true }); window.show(); window.focus(); native.focus();
  await native.executeJavaScript(`document.body.insertAdjacentHTML('afterbegin', '<a id="next-page" href="/browser-test?held-navigation">Next page</a>')`);
  // Click only after the guest has painted the new link, like a real viewer.
  await native.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  const link = await native.executeJavaScript(`(() => { const box = document.querySelector('#next-page').getBoundingClientRect(); return { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) }; })()`);
  native.sendInputEvent({ type: 'mouseMove', ...link });
  native.sendInputEvent({ type: 'mouseDown', ...link, button: 'left', clickCount: 1 });
  native.sendInputEvent({ type: 'mouseUp', ...link, button: 'left', clickCount: 1 });
  await until(async () => (await read()).tabs[0]?.loading, 'Link did not start navigation');
  await call('taskBrowserLayout', scope, 1, layout);
  assert.equal(await visibleCount(), 1, 'Navigation must keep the existing guest visible');
  assert.equal(native.getURL(), url + '/browser-test', 'Previous document must remain until navigation commits');
  await until(async () => await fetch(url + '/browser-navigation-pending').then(response => response.text()) === '1', 'Navigation request did not reach fixture');
  await fetch(url + '/release-browser-navigation');
  await until(async () => !(await read()).tabs[0]?.loading && native.getURL().includes('navigation-finished'), 'Link navigation did not complete');
  await command({ kind: 'navigate', tabId: first, url: url + '/browser-test' });
  await until(async () => !(await read()).tabs[0]?.loading, 'Original fixture did not reload');
  native = await require('./browser-detached-native.cjs')(window, native, scope, first);
  // Human tab titles follow the page; private fields/logs stay out of state.
  await native.executeJavaScript(`document.title='Checkout page';document.querySelector('input').value='password-secret';console.error('password-secret')`);
  await until(async () => (await read()).tabs[0].title === 'Checkout page', 'Page title did not update');
  await native.executeJavaScript(`document.title='  Updated   checkout  '`);
  await until(async () => (await read()).tabs[0].title === 'Updated checkout', 'Dynamic page title did not update');
  await native.executeJavaScript(`history.pushState(null, '', '#checkout')`);
  await until(async () => (await read()).tabs[0].url.endsWith('#checkout'), 'Same-document navigation did not update');
  assert.equal((await read()).tabs[0].title, 'Updated checkout');
  await native.executeJavaScript(`document.title='x'.repeat(300)`);
  await until(async () => (await read()).tabs[0].title === 'x'.repeat(200), 'Page title was not bounded');
  await native.executeJavaScript(`document.title=''`);
  await until(async () => (await read()).tabs[0].title === '/browser-test', 'Empty page title did not fall back to the location');
  state = await read(); assert.equal(JSON.stringify(state).includes('password-secret'), false);
  state = await command({ kind: 'theme', tabId: first, theme: 'dark' });
  assert.equal(state.tabs[0].theme, 'dark'); assert.equal(await native.executeJavaScript("matchMedia('(prefers-color-scheme: dark)').matches"), true);
  state = await command({ kind: 'network', tabId: first, slow: true }); assert.equal(state.tabs[0].slowNetwork, true);
  await command({ kind: 'network', tabId: first, slow: false }); await command({ kind: 'theme', tabId: first, theme: 'system' });
  // Streamed display uses the same engine and no native child surface.
  await window.webContents.executeJavaScript('window.__autoBrowserAck = false; window.__browserFrame = null');
  await call('taskBrowserPresentation', scope, 1, first, 'stream');
  await call('taskBrowserLayout', scope, 1, {...layout, sequence:2});
  const streamHeartbeat=setInterval(()=>{void call('taskBrowserLayout',scope,1,{...layout,sequence:Math.floor(performance.now()*1000)});},200);
  const frame = await until(()=>window.webContents.executeJavaScript('window.__browserFrame'), 'Stream produced no browser frame');
  assert.ok(frame.bytes > 100);assert.equal(frame.width,390);assert.equal(window.contentView.children.length,0);
  await call('taskBrowserFrameAck',scope,1,first,frame.streamId,frame.sequence);
  await native.executeJavaScript('document.querySelector("input").value="";document.querySelector("input").scrollIntoView({block:"center"})');
  await call('taskBrowserLayout', scope, 1, {...layout, sequence:3});
  let humanGeneration=(await read()).tabs[0].generation;
  const textPoint=await native.executeJavaScript(`(()=>{const r=document.querySelector('input').getBoundingClientRect();return {x:r.x+5,y:r.y+5}})()`);
  humanGeneration=await call('taskBrowserInput',scope,1,first,humanGeneration,{kind:'pointer',type:'down',...textPoint,button:'left',buttons:1,clicks:1,modifiers:0});
  humanGeneration=await call('taskBrowserInput',scope,1,first,humanGeneration,{kind:'pointer',type:'up',...textPoint,button:'left',buttons:0,clicks:1,modifiers:0});
  await call('taskBrowserInput',scope,1,first,humanGeneration,{kind:'text',text:'Unicode 世界'});
  await until(async()=>await native.executeJavaScript('document.querySelector("input").value')==='Unicode 世界','Streamed Unicode text was not delivered');
  await native.executeJavaScript('scrollTo(0,0)');
  await assert.rejects(()=>call('taskBrowserInput',scope,1,first,humanGeneration,{kind:'eval',code:'unsafe'}));
  clearInterval(streamHeartbeat);
  await call('taskBrowserPresentation', scope, 1, first, 'embedded');
  await call('taskBrowserLayout', scope, 1, {...layout, sequence:4});
  state = await command({ kind: 'handoff', tabId: first, sessionId: 2 }); const generation = state.tabs[0].generation;
  assert.equal(state.tabs[0].driver, 'agent');
  native.sendInputEvent({ type: 'mouseDown', x: 30, y: 30, button: 'left', clickCount: 1 });
  native.sendInputEvent({ type: 'mouseUp', x: 30, y: 30, button: 'left', clickCount: 1 });
  await until(async () => (await read()).tabs[0].driver === 'you', 'Native input did not take control');
  assert.ok((await read()).tabs[0].generation > generation);
  await native.executeJavaScript("document.querySelector('input').value='';document.querySelector('input').focus()");
  await command({ kind: 'handoff', tabId: first, sessionId: 2 });
  await call('taskBrowserLayout', scope, 1, { ...layout, sequence: 4 });
  app.focus({ steal: true }); window.show(); window.focus();
  native.focus(); native.sendInputEvent({ type: 'keyDown', keyCode: 'A' }); native.sendInputEvent({ type: 'char', keyCode: 'a' }); native.sendInputEvent({ type: 'keyUp', keyCode: 'A' });
  await until(async () => (await read()).tabs[0].driver === 'you', 'Native keyboard input did not take control');
  const controlFocus = (await read()).controlsFocus;
  await call('taskBrowserLayout', scope, 1, { ...layout, sequence: 5 });
  native.sendInputEvent({ type: 'keyDown', keyCode: 'Escape', modifiers: ['shift'] });
  await until(async () => (await read()).controlsFocus > controlFocus, 'Shift+Escape did not request browser chrome focus');
  await command({ kind: 'focus', tabId: first });
  await call('taskBrowserLayout', scope, 1, { ...layout, sequence: 6 });
  assert.equal((await read()).tabs[0].driver, 'you');
  const gesturePoint=await native.executeJavaScript(`(()=>{const r=document.querySelector('button').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
  const beforeGesture=await native.executeJavaScript('window.clicks');
  native.sendInputEvent({type:'mouseDown',...gesturePoint,button:'left',clickCount:1});
  await call('taskBrowserLayout',scope,1,{...layout,inputReady:false});
  native.sendInputEvent({type:'mouseUp',...gesturePoint,button:'left',clickCount:1});
  await until(async()=>await native.executeJavaScript('window.clicks')===beforeGesture+1,'A visible gesture lost its release during chrome motion');
  await native.executeJavaScript('window.clicks=0');
  await call('taskBrowserLayout',scope,1,{...layout,inputReady:true});
  await command({ kind: 'pick', enabled: true, visual: 1 });
  await call('taskBrowserLayout', scope, 1, { ...layout, sequence: 7 });
  const rect = await native.executeJavaScript(`(() => {const r=document.querySelector('button').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
  await native.executeJavaScript(`document.querySelector('button').__reactFiber$test = { _debugSource: { fileName: 'src/Checkout.tsx', lineNumber: 88, columnNumber: 7 } }`);
  const { elementAt } = require('../dist/browser/page-inspection');
  await native.executeJavaScript(`document.querySelector('button').setAttribute('data-ng-source-location','src/checkout.component.html@o:120,l:87,c:2')`);
  assert.deepEqual((await elementAt(native, rect.x, rect.y, () => true)).source, { file: 'src/checkout.component.html', line: 88, column: 3, kind: 'angular-template' });
  await native.executeJavaScript(`document.querySelector('button').removeAttribute('data-ng-source-location');delete document.querySelector('button').__reactFiber$test;document.querySelector('button').__vueParentComponent={type:{__file:'src/Checkout.vue'}}`);
  assert.equal((await elementAt(native, rect.x, rect.y)).componentSource, undefined);
  assert.deepEqual((await elementAt(native, rect.x, rect.y, () => true)).componentSource, { file: 'src/Checkout.vue', framework: 'vue' });
  await native.executeJavaScript(`delete document.querySelector('button').__vueParentComponent;document.querySelector('button').__reactFiber$test={_debugSource:{fileName:'src/Checkout.tsx',lineNumber:88,columnNumber:7}}`);
  assert.equal((await elementAt(native, rect.x, rect.y)).source, undefined, 'Agent inspection must not read source metadata');
  assert.deepEqual((await elementAt(native, rect.x, rect.y, () => true)).source, { file: 'src/Checkout.tsx', line: 88, column: 7, kind: 'react-debug-source' });
  await native.executeJavaScript(`document.querySelector('button').__reactFiber$test = { _debugStack: Object.assign(new Error(), { stack: 'Error\\n at Checkout (' + location.origin + '/source-fixture.js:1:1)' }) }`);
  native.sendInputEvent({ type: 'mouseDown', ...rect, button: 'left', clickCount: 1 });
  native.sendInputEvent({ type: 'mouseUp', ...rect, button: 'left', clickCount: 1 });
  state = await until(async () => { const state = await read(); return state.picked ? state : null; }, 'Element picker did not return', 20000);
  assert.match(state.picked.selector, /data-elevenex-picked/); await delay(50); assert.equal(await visibleCount(), 0);
  assert.deepEqual(state.picked.source, { file: 'src/Checkout.tsx', line: 88, column: 1, kind: 'react-source-map' });
  await native.executeJavaScript(`delete document.querySelector('button').__reactFiber$test`);
  assert.equal(await native.executeJavaScript('window.clicks'), 0, 'Picker must consume page input');
  await command({ kind: 'pick', enabled: false });
  await call('taskBrowserLayout', scope, 1, layout);
  await until(async () => await visibleCount() === 1, 'Legacy picker surface did not return');
  await command({ kind: 'pick', enabled: true });
  native.sendInputEvent({ type: 'mouseDown', ...rect, button: 'left', clickCount: 1 });
  native.sendInputEvent({ type: 'mouseUp', ...rect, button: 'left', clickCount: 1 });
  const legacyPick = await until(async () => (await read()).picked, 'Legacy picker did not resolve');
  assert.match(legacyPick.selector, /button:nth-child/);
  assert.equal(legacyPick.snapshot, undefined, 'Older callers must not receive a changed picker contract');
  await command({ kind: 'pick', enabled: false });
  const previousUrl = native.getURL();
  await command({ kind: 'navigate', tabId: first, url: url + '/browser-test?next=1' });
  await until(async () => { const tab = (await read()).tabs[0]; return tab.canGoBack && !tab.loading && native.getURL() === url + '/browser-test?next=1'; }, 'Navigation did not retain history');
  assert.equal((await read()).tabs[0].canGoForward, false);
  await command({ kind: 'back', tabId: first });
  await until(async () => (await read()).tabs[0].canGoForward && !(await read()).tabs[0].loading && native.getURL() === previousUrl, 'Back did not enable forward history');
  await command({ kind: 'forward', tabId: first });
  await until(async () => !(await read()).tabs[0].canGoForward && !(await read()).tabs[0].loading && native.getURL() === url + '/browser-test?next=1', 'Forward did not restore the next page');
  await command({ kind: 'back', tabId: first });
  await until(async () => (await read()).tabs[0].canGoForward && !(await read()).tabs[0].loading, 'Back did not restore forward history');
  await command({ kind: 'navigate', tabId: first, url: url + '/browser-test?branch=1' });
  await until(async () => !(await read()).tabs[0].canGoForward && !(await read()).tabs[0].loading && native.getURL().includes('branch=1'), 'New navigation did not clear forward history');
  await native.executeJavaScript("localStorage.setItem('profile-probe','task-profile-value')");
  await command({ kind: 'open', url: url + '/browser-test?second=1' });
  const secondPage=await until(()=>webContents.getAllWebContents().find(contents=>contents.getURL().includes('second=1')),'Second profile tab did not load');
  assert.equal(await secondPage.executeJavaScript("localStorage.getItem('profile-probe')"),'task-profile-value');
  assert.equal((await read()).tabs.length, 2);
  await command({ kind: 'select', tabId: first });
  // Every picker exit must release native interception, including closing a sibling.
  const sibling = await command({ kind: 'new-tab' });
  await command({ kind: 'select', tabId: first });
  for (const exit of [{ kind: 'close', tabId: sibling.active }, { kind: 'reload', tabId: first }, { kind: 'back', tabId: first }, { kind: 'forward', tabId: first }]) {
    await command({ kind: 'pick', enabled: true, visual: 1 });
    await command(exit);
    await until(async () => !(await read()).tabs.find(tab => tab.id === first)?.loading, 'Picker exit navigation did not finish');
    await call('taskBrowserLayout', scope, 1, layout);
    await until(async () => (await read()).tabs.find(tab => tab.id === first)?.ready && await visibleCount() === 1, 'Picker exit page is not presented');
    const point = await native.executeJavaScript(`new Promise(resolve => { window.clicks = 0; document.querySelector('button').scrollIntoView({ block: 'center' }); requestAnimationFrame(() => requestAnimationFrame(() => { const r = document.querySelector('button').getBoundingClientRect(); resolve({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }); })); })`);
    native.focus();
    native.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 });
    native.sendInputEvent({ type: 'mouseUp', ...point, button: 'left', clickCount: 1 });
    await until(async () => await native.executeJavaScript('window.clicks') === 1, 'Picker interception survived ' + exit.kind);
    assert.equal((await read()).picking, false);
    assert.equal((await read()).picked, null);
  }
  const retainedBack = (await read()).tabs[0].canGoBack;
  await read(3); await delay(50); assert.equal(await visibleCount(), 0, 'Task switch must detach pages');
  state = await read(); assert.equal(state.tabs.length, 2); assert.equal(state.active, first); assert.equal(state.tabs[0].canGoBack, retainedBack);
  window.webContents.setZoomFactor(1.25);
  await call('taskBrowserLayout', scope, 1, { ...layout, sequence: 8 });
  assert.equal(native.getZoomFactor(), 1.25);
  await until(async()=>await window.webContents.executeJavaScript('window.__browserSurfaces.find(s=>s.visible)?.bounds.x') === 500, 'Zoom layout not published');
  assert.equal(await window.webContents.executeJavaScript('window.__browserSurfaces.find(s=>s.visible).bounds.x'), 500, 'App CSS bounds must be converted to native DIPs');
  await command({ kind: 'pick', enabled: true, visual: 1 });
  const zoomed = await native.executeJavaScript(`new Promise(resolve=>{document.querySelector('button').style.backgroundColor='rgb(20,120,200)';requestAnimationFrame(()=>requestAnimationFrame(()=>{const r=document.querySelector('button').getBoundingClientRect();resolve({x:r.x,y:r.y,width:r.width,height:r.height});}));})`);
  const zoomedPoint = { x: Math.round((zoomed.x + zoomed.width / 2) * 1.25), y: Math.round((zoomed.y + zoomed.height / 2) * 1.25) };
  native.sendInputEvent({ type: 'mouseDown', ...zoomedPoint, button: 'left', clickCount: 1 });
  native.sendInputEvent({ type: 'mouseUp', ...zoomedPoint, button: 'left', clickCount: 1 });
  const zoomPick = await until(async () => { const snapshot = await read(); return snapshot.picked; }, 'Zoomed picker did not resolve', 20000);

  assert.ok(zoomPick.snapshot?.jpeg, 'Zoomed pick must retain real pixels');
  await require('node:fs/promises').writeFile(join(process.cwd(), 'artifacts/element-mentions/native-zoom-crop.jpg'), Buffer.from(zoomPick.snapshot.jpeg, 'base64'));
  assert.deepEqual(require('electron').nativeImage.createFromBuffer(Buffer.from(zoomPick.snapshot.jpeg, 'base64')).getSize(), { width: zoomPick.snapshot.reference.image.width, height: zoomPick.snapshot.reference.image.height });
  const crop = zoomPick.snapshot.reference.crop, image = require('electron').nativeImage.createFromBuffer(Buffer.from(zoomPick.snapshot.jpeg, 'base64'));
  const bitmap = image.toBitmap(), pixel = (Math.round(zoomed.y - crop.y + 5) * image.getSize().width + Math.round(zoomed.x - crop.x + 5)) * 4;
  assert.ok(bitmap[pixel] > 100 && bitmap[pixel + 1] > 50 && bitmap[pixel + 2] < 100, 'Captured pixels must put the selected blue button at its CSS target offset');
  assert.ok(Math.abs(zoomPick.x - zoomed.x) < 1, JSON.stringify({ target: zoomPick.snapshot?.reference.target, crop: zoomPick.snapshot?.reference.crop, zoomed, x: zoomPick.x, y: zoomPick.y })); assert.ok(Math.abs(zoomPick.y - zoomed.y) < 1);
  await command({ kind: 'pick', enabled: false });
  window.webContents.setZoomFactor(1);
  await call('taskBrowserLayout', scope, 1, { ...layout, sequence: 9 });
  await command({ kind: 'theme', tabId: first, theme: 'dark' });
  await command({ kind: 'network', tabId: first, slow: true });
  native.forcefullyCrashRenderer();
  await until(async () => (await read()).tabs[0].driver === 'needs', 'Crash did not revoke agent control');
  assert.ok((await read()).tabs[0].error);
  await command({ kind: 'reload', tabId: first });
  await until(async () => !(await read()).tabs[0].loading && !(await read()).tabs[0].error, 'Crashed page did not recover on explicit reload');
  assert.equal((await read()).tabs[0].driver, 'you');
  assert.equal((await read()).tabs[0].id, first);
  assert.equal((await read()).tabs[0].theme, 'dark');
  assert.equal((await read()).tabs[0].slowNetwork, true);
  native = await until(() => webContents.getAllWebContents().find(contents => contents.getType() === 'webview' && contents.getURL() === (state.tabs.find(tab => tab.id === first)?.url)), 'Crashed guest was not replaced');
  assert.equal(await native.executeJavaScript("matchMedia('(prefers-color-scheme: dark)').matches"), true);
  await call('taskBrowserLayout', scope, 1, { ...layout, sequence: 10 });
  await call('taskBrowserLayout', scope, 1, { ...layout, sequence: 11, visible: false });
  await call('taskBrowserLayout', scope, 1, { ...layout, sequence: 10, testStale:true });
  await delay(50); assert.equal(await visibleCount(), 0, 'Late layout must not reopen hidden page');
  assert.equal((await call('taskBrowserCommand', scope, 3, { kind: 'open', url: 'https://example.com' })).ok, false, 'Stale task commands must not change selected task');
  assert.equal(await call('taskBrowserCommand', scope, 1, { kind: 'open', url: 'file:///etc/passwd' }).then(() => false, () => true), true);
  for (const tab of state.tabs) await command({ kind: 'close', tabId: tab.id });
  assert.equal((await call('taskBrowserConfigure', scope, 1, 'desktop')).ok, true);
  await until(() => native.isDestroyed(), 'Closed tab WebContents survived');
  console.log('Browser smoke: native lifecycle and scope checks passed');
  const selfClosing = await command({ kind: 'open', url: url + '/browser-test?self-close=1' });
  const closingContents = await until(() => webContents.getAllWebContents().find(contents => contents.getURL().includes('self-close')), 'Self-closing page not loaded');
  await until(async () => !(await read()).tabs[0]?.loading, 'Recovery fixture is still loading');
  await command({ kind: 'theme', tabId: selfClosing.active, theme: 'dark' });
  await command({ kind: 'network', tabId: selfClosing.active, slow: true });
  const recoverySibling = await command({ kind: 'new-tab' });
  await command({ kind: 'select', tabId: selfClosing.active });
  closingContents.close({ waitForBeforeUnload: false });
  await until(async () => (await read()).tabs[0]?.error, 'Unexpected WebContents closure was not reconciled');
  const replacement = await command({ kind: 'reload', tabId: selfClosing.active });
  assert.equal(replacement.active, selfClosing.active);
  assert.deepEqual(replacement.tabs.map(tab => tab.id), [selfClosing.active, recoverySibling.active]);
  assert.equal(replacement.tabs[0].theme, 'dark'); assert.equal(replacement.tabs[0].slowNetwork, true);
  assert.equal(replacement.tabs[0].driver, 'you');
  const recoveredContents = await until(() => webContents.getAllWebContents().find(contents => contents !== closingContents && contents.getURL().includes('self-close')), 'Replacement guest did not load');
  assert.equal(await recoveredContents.executeJavaScript("matchMedia('(prefers-color-scheme: dark)').matches"), true);
  await command({ kind: 'close', tabId: replacement.active });
  await command({ kind: 'close', tabId: recoverySibling.active });
  console.log('Browser smoke: destroyed guest recovery passed');
  const downloadRoot=await mkdtemp(join(tmpdir(),'elevenex-browser-download-'));
  window.once('closed',()=>{void rm(downloadRoot,{recursive:true,force:true});});
  const downloadTab=await command({kind:'open',url:url+'/browser-test?download-owner=1'});
  const downloadPage=await until(()=>webContents.getAllWebContents().find(contents=>contents.getURL().includes('download-owner')),'Download owner did not load');
  await until(async()=>!(await read()).tabs.find(tab=>tab.id===downloadTab.active)?.loading,'Download owner is still loading');
  await call('taskBrowserLayout',scope,1,{...layout,sequence:40});
  const savedFile=join(downloadRoot,'report.txt');
  downloadPage.session.on('will-download',(event,item)=>{if(!event.defaultPrevented)item.setSavePath(savedFile);});
  console.log('Browser smoke: download owner ready');
  await command({kind:'handoff',tabId:downloadTab.active,sessionId:2});
  await downloadPage.executeJavaScript('location.href='+JSON.stringify(url+'/download-test'));
  await until(async()=>(await read()).tabs.find(tab=>tab.id===downloadTab.active)?.driver==='needs','Agent-initiated download did not require the user');
  console.log('Browser smoke: agent download denied');
  await assert.rejects(()=>access(savedFile));
  await call('taskBrowserLayout',scope,1,{...layout,sequence:41});
  await command({kind:'navigate',tabId:downloadTab.active,url:url+'/download-test'});
  await until(async()=>await readFile(savedFile,'utf8').catch(()=>null)==='browser download fixture','Explicit user download was not saved');
  assert.equal(JSON.stringify(await read()).includes(downloadRoot),false,'Save paths must not enter window state');
  console.log('Browser smoke: user download saved');
  await command({kind:'close',tabId:downloadTab.active});
  console.log('Browser smoke: download tab closed');
  // A simulated remote transport lease resolves to a real isolated HTTP server.
  // The logical port stays in the page URL; the task proxy routes its real TCP connection.
  const { BackendClient } = require('../dist/backend-client/client');
  const { TaskBrowser } = require('../dist/browser/task');
  const remoteClient = new BackendClient(() => ({ identity: 'remote-fixture', url: backendUrl, version: 'a'.repeat(40), headers: {}, environment: { kind: 'remote', hostId: 'fixture' } }), () => undefined);
  const remoteWindow = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  await remoteWindow.loadURL('about:blank');
  remoteClient.attach(remoteWindow.webContents.id);
  const forwarded = []; let released = false;
  let remoteActive = true;
  const remoteTask = new TaskBrowser(remoteClient.state(remoteWindow.webContents.id).scope.id, 10, remoteWindow, remoteClient,
    { browserForward: async (windowId, port) => { forwarded.push({ windowId, port }); return { port: Number(new URL(url).port), close: async () => { released = true; } }; } },
    { read: async () => null, save: () => undefined }, 'remote-task', new (require('../dist/browser/task-session').BrowserTaskProfiles)(), true, () => undefined, () => remoteActive);
  await remoteTask.agent({ kind: 'open', url: 'http://localhost:40001/browser-test' }, 2);
  const remotePage = [...remoteTask.pages.values()][0];
  const remoteView = new WebContentsView({webPreferences:{session:session.fromPartition(remotePage.partition),additionalArguments:['--elevenex-task-tab='+remotePage.id],sandbox:true,contextIsolation:true,nodeIntegration:false}});
  remotePage.attach(remoteView.webContents);
  console.log('Browser smoke: forwarded guest attached');
  const forwardedOrigin = 'http://localhost:40001';
  await until(() => remotePage.contents.getURL() === forwardedOrigin + '/browser-test' && !remotePage.loading, 'Remote URL was not forwarded to the allocated listener');
  console.log('Browser smoke: forwarded guest loaded');
  const resourceStatus = await remotePage.contents.executeJavaScript("fetch('http://localhost:40001/browser-test?resource=1').then(r=>r.status).catch(()=>0)");
  assert.equal(resourceStatus, 200, 'Known remote subresources must use the allocated listener');
  console.log('Browser smoke: forwarded HTTP passed');
  const socketStatus = await remotePage.contents.executeJavaScript(`new Promise(resolve => {
    const socket = new WebSocket('ws://localhost:40001/browser-socket');
    const timer = setTimeout(() => { socket.close(); resolve('timeout'); }, 3000);
    socket.onopen = () => socket.send('task-browser-probe');
    socket.onmessage = event => { clearTimeout(timer); resolve(event.data); socket.close(); };
    socket.onerror = () => { clearTimeout(timer); resolve('failed'); };
  })`);
  assert.equal(socketStatus, 'task-browser-probe', 'Remote WebSockets must preserve the logical origin through the task connector');
  console.log('Browser smoke: forwarded socket passed');
  remoteTask.setPorts([40002]);
  assert.equal(await remotePage.contents.executeJavaScript("fetch('http://localhost:40002/browser-test').then(r=>r.status).catch(()=>0)"),0,'Log suggestions must not grant network authority');
  console.log('Browser smoke: implicit ports denied');
  const explicitApi=await remoteTask.agent({kind:'open',url:'http://localhost:40002/browser-test'},2);
  const apiTab=explicitApi.tabs.find(tab=>tab.id!==remotePage.id);
  await remoteTask.agent({kind:'close',tabId:apiTab.id,generation:apiTab.generation},2);
  assert.equal(await remotePage.contents.executeJavaScript("fetch('http://localhost:40002/browser-test').then(r=>r.status).catch(()=>0)"), 200, 'Discovered task API ports must be routed without changing origins');
  const unknown = await remotePage.contents.executeJavaScript("fetch('http://localhost:40003/browser-test').then(r=>r.status).catch(()=>0)");
  assert.equal(unknown, 0, 'Unknown desktop localhost must not be reachable');
  const originalResolve = net.resolveHost;
  net.resolveHost = async host => { assert.equal(host, 'rebinding.example'); return { endpoints: [{ address: '127.0.0.1', family: 'ipv4' }] }; };
  try {
    assert.equal(await remotePage.contents.executeJavaScript(`fetch('http://rebinding.example:${new URL(url).port}/browser-test').then(r=>r.status).catch(()=>0)`), 0, 'A public hostname must not rebind to desktop localhost');
  } finally { net.resolveHost = originalResolve; }
  remoteActive = false; remoteTask.suspend();
  assert.equal(await remotePage.contents.executeJavaScript("fetch('/browser-test?paused=1').then(r=>r.status).catch(()=>0)"), 0);
  remoteActive = true;
  assert.equal(await remotePage.contents.executeJavaScript("fetch('/browser-test?resumed=1').then(r=>r.status).catch(()=>0)"), 200);
  assert.equal(remoteTask.snapshot().tabs[0].url, 'http://localhost:40001/browser-test');
  const staleOutside = remoteTask.command({kind:'outside',tabId:remotePage.id});
  remoteActive=false;
  await assert.rejects(()=>staleOutside,/selection changed/);
  remoteActive=true;
  assert.deepEqual(forwarded, [{ windowId: remoteWindow.webContents.id, port: 40001 }, { windowId: remoteWindow.webContents.id, port: 40002 }]);
  console.log('Browser smoke: remote network boundaries passed');
  const openedViewport = await remoteTask.agent({ kind: 'open', url: 'http://localhost:40001/browser-test?viewport=1' }, 2);
  console.log('Browser smoke: viewport tab requested');
  const viewportId = openedViewport.tabs.find(tab => tab.id !== remotePage.id).id;
  assert.equal(remoteTask.active, remotePage.id, 'Agent-created tabs must not interrupt a user-controlled active tab');
  await assert.rejects(() => remoteTask.agent({ kind: 'select', tabId: viewportId, generation: 1 }, 2), /handoff/);
  await remoteTask.command({ kind: 'select', tabId: viewportId });
  console.log('Browser smoke: viewport tab selected');
  const viewportPage = remoteTask.pages.get(viewportId);
  const viewportView = new WebContentsView({webPreferences:{session:session.fromPartition(viewportPage.partition),additionalArguments:['--elevenex-task-tab='+viewportPage.id],sandbox:true,contextIsolation:true,nodeIntegration:false}});
  viewportPage.attach(viewportView.webContents); viewportView.setBounds(layout.bounds);remoteWindow.contentView.addChildView(viewportView);
  await until(() => !viewportPage.loading, 'Viewport test page did not load');
  console.log('Browser smoke: viewport guest loaded');
  remoteWindow.show(); remoteWindow.focus(); viewportPage.contents.focus(); remoteTask.position({ ...layout, surfaceEpoch: remoteTask.snapshot().surfaceEpoch, ownerGeneration: viewportPage.lease.generation, inputReady: true, sequence: 1 });
  viewportPage.lease.handBack(2);
  remoteTask.position({ ...layout, surfaceEpoch: remoteTask.snapshot().surfaceEpoch, ownerGeneration: viewportPage.lease.generation, inputReady: true, sequence: 2 });
  const viewportGeneration = viewportPage.lease.generation;
  remoteTask.position({ ...layout, surfaceEpoch: remoteTask.snapshot().surfaceEpoch, ownerGeneration: viewportPage.lease.generation, inputReady: true, sequence: 3, bounds: { ...layout.bounds, width: 420 } });
  assert.equal(viewportPage.lease.driver, 'you', 'Viewport changes must invalidate queued coordinate input');
  assert.ok(viewportPage.lease.generation > viewportGeneration);
  // A failed observation from an earlier picker must not cancel a fresh picker.
  const inspect = viewportPage.contents.executeJavaScriptInIsolatedWorld;
  let failInspection, markInspection;
  const inspecting = new Promise(resolve => { markInspection = resolve; });
  viewportPage.contents.executeJavaScriptInIsolatedWorld = (world, ...args) => world === 1001
    ? new Promise((_resolve, reject) => { failInspection = reject; markInspection(); })
    : Reflect.apply(inspect, viewportPage.contents, [world, ...args]);
  try {
    await remoteTask.command({ kind: 'pick', enabled: true, visual: 1 });
    remoteTask.position({ ...layout, surfaceEpoch: remoteTask.snapshot().surfaceEpoch, ownerGeneration: viewportPage.lease.generation, sequence: 4, bounds: { ...layout.bounds, width: 420 } });
    viewportPage.contents.sendInputEvent({ type: 'mouseDown', x: 30, y: 30, button: 'left', clickCount: 1 });
    await inspecting;
    await remoteTask.command({ kind: 'pick', enabled: false });
    await remoteTask.command({ kind: 'pick', enabled: true, visual: 1 });
    failInspection(new Error('Obsolete inspection'));
    for (let i = 0; i < 12; i++) await Promise.resolve();
    assert.equal(remoteTask.snapshot().picking, true, 'An obsolete picker failure must not dismiss the current picker');
    assert.equal(remoteTask.snapshot().pickerMessage, null);
  } finally {
    viewportPage.contents.executeJavaScriptInIsolatedWorld = inspect;
    await remoteTask.command({ kind: 'pick', enabled: false });
  }
  remoteWindow.once('closed', () => remoteTask.destroy()); remoteWindow.destroy(); await delay(0); assert.equal(released, true, 'Task teardown must close its forwarding lease'); remoteClient.dispose();
  console.log('Browser smoke: forwarded teardown passed');
  // Four pinned tasks leave no eviction candidate. A fifth must fail without
  // exceeding the resource bound or replacing the selected task.
  const pinned = [];
  const context = { projectName: 'Smoke', taskName: 'Pinned task', branchName: 'test', machineName: 'This Mac', stage: 'active', hue: 'ocean' };
  try {
    for (const task of [1, 3, 4, 5]) {
      await read(task);
      const tab = (await call('taskBrowserCommand', scope, task, { kind: 'new-tab' })).value.active;
      const before = new Set(BrowserWindow.getAllWindows());
      await call('taskBrowserDetach', scope, task, tab, context);
      pinned.push({ task, tab, window: BrowserWindow.getAllWindows().find(item => !before.has(item)) });
    }
    assert.equal((await call('taskBrowserRead', scope, 6)).ok, false, 'Pinned tasks must not bypass the task bound');
    assert.equal((await call('taskBrowserCommand', scope, 5, { kind: 'feedback', enabled: false })).ok, true, 'Capacity failure preserves the selected host');
  } finally {
    for (const item of pinned) {
      if (item.window && !item.window.isDestroyed()) item.window.close();
      await read(item.task);
      await call('taskBrowserCommand', scope, item.task, { kind: 'close', tabId: item.tab });
    }
  }
  console.log('Browser smoke: pinned task capacity passed');
  await read();
  await command({ kind: 'open', url: url + '/browser-test?private-query=not-persisted' });
  const resumed = await until(() => webContents.getAllWebContents().find(contents => contents !== window.webContents && contents.getURL().includes('private-query')), 'Reconnection test tab did not load');
  await command({ kind: 'handoff', tabId: (await read()).active, sessionId: 2 });
  const oldPresentation = await read();
  await call('taskBrowserHide', scope, 1);
  await call('taskBrowserLayout', scope, 1, { ...layout, sequence: 50, surfaceEpoch: oldPresentation.surfaceEpoch });
  await delay(50); assert.equal(await visibleCount(), 0, 'A higher sequence from an old presentation must not reattach over an overlay');
  await call('taskBrowserLayout', scope, 1, { ...layout, sequence: 51 });
  await call('taskBrowserHide', scope, 1);
  return resumed;
};
