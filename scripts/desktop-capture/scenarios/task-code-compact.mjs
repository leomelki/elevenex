import assert from 'node:assert/strict';
import { app } from 'electron';
import { cp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

// Test-only process adapter: real production UI/IPC/HTTP and actual disposable
// Nest task, without starting or reconfiguring the user's managed backend.
export default async function* (capture) {
  const origin = process.env.ELEVENEX_CODE_CAPTURE_ORIGIN;
  const token = process.env.ELEVENEX_CODE_CAPTURE_ACCESS;
  const projectId = Number(process.env.ELEVENEX_CODE_CAPTURE_PROJECT);
  const taskId = Number(process.env.ELEVENEX_CODE_CAPTURE_TASK);
  const sessionId = Number(process.env.ELEVENEX_CODE_CAPTURE_SESSION);
  assert.ok(origin && token && projectId && taskId && sessionId);
  let metadata;
  const readyDeadline = Date.now() + 30000;
  while (!metadata) {
    try { const response = await fetch(origin + '/api/info', { signal: AbortSignal.timeout(1000) }); if (response.ok) { const value = await response.json(); if (typeof value.backendSha === 'string') metadata = value; } } catch { /* The disposable backend may still be booting. */ }
    if (!metadata) { if (Date.now() >= readyDeadline) throw new Error('Disposable backend did not become ready'); await new Promise(resolve => setTimeout(resolve, 100)); }
  }
  const ready = { phase: 'ready', version: metadata.backendSha, url: origin };
  const { BackendManager } = require('../../../apps/desktop/dist/backend/manager.js');
  const previous = { snapshot: BackendManager.prototype.snapshot, start: BackendManager.prototype.start, codeAccess: BackendManager.prototype.codeAccess };
  BackendManager.prototype.snapshot = () => ready;
  BackendManager.prototype.start = async () => ready;
  BackendManager.prototype.codeAccess = () => token;
  // A release installation may already be pending when the scenario starts.
  // Keep its later status events consistent with this external-backend adapter.
  const ipc = require('../../../apps/desktop/dist/ipc.js');
  const broadcast = ipc.broadcast;
  ipc.broadcast = (channel, value) => broadcast(channel, channel === 'backend:changed' ? ready : value);
  ipc.broadcast('backend:changed', ready);
  // Hold the real extension bootstrap to inspect the document-loading phase.
  // This adapter lives only in the disposable capture process.
  const { CodeProtocol } = require('../../../apps/desktop/dist/code/protocol.js');
  const { CodeFrame } = require('../../../apps/desktop/dist/code/frame.js');
  const settleLayout = CodeFrame.prototype.settleLayout;
  let layoutSequence = 0, settledSequence = 0;
  CodeFrame.prototype.settleLayout = async function(width) {
    const sequence = ++layoutSequence;
    await settleLayout.call(this,width);
    if (sequence === layoutSequence) settledSequence = sequence;
  };
  const handle = CodeProtocol.prototype.handle;
  let resumeBootstrap;
  const bootstrap = new Promise(resolve => { resumeBootstrap = resolve; });
  let holdBootstrap = true;
  CodeProtocol.prototype.handle = async function(request) {
    if (holdBootstrap && new URL(request.url).pathname.endsWith('/extension.js')) await bootstrap;
    return handle.call(this, request);
  };
  try {
    await cp(join(process.env.ELEVENEX_CODE_SMOKE_CACHE, '1.144.0'), join(app.getPath('userData'), 'code-runtimes/1.144.0'), { recursive: true });
    const finish = async () => { await capture.settle(); await capture.waitFor(() => !document.querySelector('ex-code-panel .crossfading') && document.getAnimations().every(animation => !Number.isFinite(animation.effect?.getComputedTiming().endTime) || animation.playState !== 'running')); };
    await capture.viewport(1440, 900);
    await capture.cdp('Emulation.setFocusEmulationEnabled', { enabled: true });
    await capture.waitFor(() => document.querySelector('button[data-machine="local"]'));
    // Publish a newer real machine revision after installing the test adapter;
    // reselecting also refreshes a client that observed failed startup earlier.
    await capture.evaluate(() => window.elevenex.selectEnvironment({ kind: 'local' }));
    await capture.waitFor(async () => !!(await window.elevenex.backendClientState()).scope);
    await capture.evaluate(() => window.elevenex.markMachineOpened({ kind: 'local' }));
    await finish();
    await capture.click('button[data-machine="local"]'); await finish();
    await capture.waitFor(id => document.querySelector(`[data-project-id="${id}"]`), projectId);
    await capture.click(`[data-project-id="${projectId}"]`); await finish();
    await capture.waitFor(id => document.querySelector(`[data-task-id="${id}"]`), taskId);
    if (await capture.evaluate(id => document.querySelector(`[data-task-id="${id}"] button.toggle`)?.getAttribute('aria-expanded') === 'false', taskId)) await capture.click(`[data-task-id="${taskId}"] button.toggle`);
    await capture.waitFor(id => document.querySelector(`[data-session-id="${id}"] button.select`), sessionId);
    await capture.click(`[data-session-id="${sessionId}"] button.select`); await finish();
    await capture.click('ex-workspace-task-header [aria-label="Toggle side panel"]'); await finish();
    await capture.click('ex-workspace-panels [role="tab"][aria-label="Code"]'); await finish();
    await capture.waitFor(() => document.querySelector('ex-code-panel iframe'));
    assert.equal(await capture.evaluate(() => !!document.querySelector('ex-code-panel .launch-card')), false);
    assert.equal(await capture.evaluate(() => document.querySelector('ex-code-panel')?.getAttribute('aria-busy')), 'true');
    yield {name:'iframe-loading-without-fallback',inspect:['ex-code-panel','.editor-surface','iframe']};
    holdBootstrap = false; resumeBootstrap();
    const waitMain = async (predicate, message) => { const deadline = Date.now() + 45000; while (!await predicate()) { if (Date.now() > deadline) throw new Error(message); await new Promise(resolve => setTimeout(resolve, 40)); } };
    await waitMain(() => capture.evaluate(() => !!document.querySelector('ex-workspace-panels .browse-files')), 'Compact editor did not open');
    assert.equal(await capture.evaluate(() => !!document.querySelector('ex-workspace-panels .find-file')), false);
    const frame = capture.window.webContents.mainFrame.frames.find(frame => frame.url.includes('code.elevenex.invalid'));
    assert.ok(frame); assert.equal(capture.window.contentView.children.length, 0);
    await waitMain(()=>frame.executeJavaScript('document.querySelector(".part.auxiliarybar")?.getBoundingClientRect().width >= innerWidth - 16'),'Empty compact workbench did not show its tree');
    await capture.waitFor(() => !document.querySelector('ex-code-panel .frame-container.loading') && document.querySelector('ex-code-panel')?.getAttribute('aria-busy') === 'false');
    for (const theme of ['light','dark']) {
      await capture.theme(theme);
      yield {name:`${theme}-empty-editor-files`,inspect:['ex-code-panel','ex-workspace-panels .browse-files','iframe']};
    }
    const target = await capture.evaluate(async taskId => ({ scopeId: (await window.elevenex.backendClientState()).scope.id, taskId }), taskId);
    assert.equal((await capture.evaluate(({ target }) => window.elevenex.codeOpenFile(target, { path: 'src/workspace.ts', line: 7 }), { target })).ok, true);
    await waitMain(() => frame.executeJavaScript('!!document.querySelector(".monaco-editor textarea.inputarea")'), 'Real file missing');
    assert.ok(await frame.executeJavaScript('innerWidth <= 440'));
    assert.equal(await frame.executeJavaScript('typeof window.elevenex'), 'undefined');
    assert.equal(await capture.evaluate(() => document.querySelector('ex-app-shell .main').hasAttribute('inert')), false);
    const press = async (key, code, vk, modifiers = 0) => { for (const type of ['keyDown', 'keyUp']) await capture.cdp('Input.dispatchKeyEvent', { type, key, code, windowsVirtualKeyCode: vk, modifiers }); };
    const waitNative = async expression => { try { await waitMain(() => frame.executeJavaScript(expression), expression); } catch (error) { console.log('COMPACT_NATIVE_STATE', await frame.executeJavaScript('JSON.stringify({text:document.body.innerText.slice(-1800),inputs:[...document.querySelectorAll(".quick-input-widget input")].map(e=>({value:e.value,rect:e.getBoundingClientRect().toJSON()}))})')); throw error; } };
    const typeQuery = async text => { await press('a', 'KeyA', 65, process.platform === 'darwin' ? 4 : 2); await capture.cdp('Input.insertText', { text }); };
    const findSelector = '.part.auxiliarybar .action-label[aria-label^="Find file"]';
    const findHitPoint = async () => {
      const button = await frame.executeJavaScript(`(() => {
        const find = document.querySelector('${findSelector}'), create = document.querySelector('.part.auxiliarybar .codicon-new-file');
        if (!find || !create) throw Error('Native Files actions missing');
        const r = find.getBoundingClientRect(), other = create.getBoundingClientRect(), title = find.closest('.title');
        if (Math.abs(r.y + r.height / 2 - other.y - other.height / 2) > 2 || r.x - title.getBoundingClientRect().x > 20 || title.querySelector('.title-label').getBoundingClientRect().width !== 0) throw Error('Find file must replace the folder title on the left');
        if (r.height < 30 || r.width < 140 || other.x - r.right < 8) throw Error('Find file needs a roomy target with a clear gap before New File');
        if (!getComputedStyle(find, '::after').content.includes('Find file')) throw Error('Find file label missing');
        const point = { x: r.right - 4, y: r.bottom - 4 };
        if (!find.contains(document.elementFromPoint(point.x, point.y))) throw Error('The padded edge must be clickable');
        return point;
      })()`);
      const host = await capture.evaluate(() => document.querySelector('ex-code-panel iframe').getBoundingClientRect().toJSON());
      return { x: host.x + button.x, y: host.y + button.y };
    };
    const clickFind = async () => {
      const point = await findHitPoint();
      for (const type of ['mousePressed', 'mouseReleased']) await capture.cdp('Input.dispatchMouseEvent', { type, ...point, button: 'left', clickCount: 1 });
    };
    const clickTree = async name => {
      await capture.settle();
      await frame.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
      const row = await frame.executeJavaScript(`(()=>{const row=[...document.querySelectorAll('.part.auxiliarybar [role="treeitem"]')].find(row=>row.querySelector('.label-name')?.textContent===${JSON.stringify(name)});if(!row)throw Error('Tree item missing');const r=row.getBoundingClientRect();return {x:r.x+Math.min(90,r.width/2),y:r.y+r.height/2};})()`);
      const host = await capture.evaluate(()=>document.querySelector('ex-code-panel iframe').getBoundingClientRect().toJSON());
      for(const type of ['mousePressed','mouseReleased']) await capture.cdp('Input.dispatchMouseEvent',{type,x:host.x+row.x,y:host.y+row.y,button:'left',clickCount:1});
    };
    for (const theme of ['light', 'dark']) {
      await capture.theme(theme);
      await waitNative(`!!document.querySelector('.monaco-workbench.${theme === 'light' ? 'vs' : 'vs-dark'}')`);
      await waitNative('(document.querySelector(".part.sidebar")?.getBoundingClientRect().width ?? 0) === 0');
      await capture.click('ex-workspace-panels .browse-files');
      await waitNative('document.querySelector(".part.auxiliarybar")?.getBoundingClientRect().width >= innerWidth - 16');
      await capture.waitFor(()=>document.querySelector('ex-workspace-panels .browse-files button')?.getAttribute('aria-label')==='Back to editor · Esc');
      await waitNative(`!!document.querySelector('${findSelector}')`);
      yield {name:`${theme}-files-over-editor`,inspect:['ex-workspace-panels .browse-files','ex-code-panel','iframe']};
      await press('Escape','Escape',27);
      await waitNative('document.querySelector(".part.auxiliarybar")?.getBoundingClientRect().width === 0');
      await capture.click('ex-workspace-panels .browse-files');
      await waitNative('document.querySelector(".part.auxiliarybar")?.getBoundingClientRect().width >= innerWidth - 16');
      await waitNative('[...document.querySelectorAll(".part.auxiliarybar [role=treeitem]")].some(row=>row.querySelector(".label-name")?.textContent==="workspace.ts")');
      await clickTree('workspace.ts'); // The already-open file must also dismiss the cover.
      await waitNative('document.querySelector(".part.auxiliarybar")?.getBoundingClientRect().width === 0 && document.activeElement?.classList.contains("inputarea")');
      yield {name:`${theme}-tree-file-accepted`,inspect:['ex-code-panel','ex-workspace-panels .browse-files','iframe']};
      await press('e','KeyE',69,(process.platform==='darwin'?4:2)|8);
      await waitNative('document.querySelector(".part.auxiliarybar")?.getBoundingClientRect().width >= innerWidth - 16');
      await waitNative('!!document.activeElement?.closest(".part.auxiliarybar")');
      await press('Home','Home',36); await press('ArrowRight','ArrowRight',39); await press('ArrowDown','ArrowDown',40); await press('Enter','Enter',13);
      await waitNative('document.querySelector(".part.auxiliarybar")?.getBoundingClientRect().width === 0 && document.activeElement?.classList.contains("inputarea")');
      yield {name:`${theme}-keyboard-tree-accepted`,inspect:['ex-code-panel','iframe']};
      yield { name: `${theme}-compact-editing`, inspect: ['ex-code-panel', 'ex-workspace-panels .panel-head', 'ex-code-panel .editor-surface', 'ex-app-shell .main'] };
      assert.equal(await capture.evaluate(() => !!document.querySelector('ex-code-panel .find-file, ex-code-panel .files-toolbar')), false);
      await capture.click('ex-workspace-panels .browse-files');
      await waitNative(`!!document.querySelector('${findSelector}')`);
      await waitNative('document.querySelector(".part.auxiliarybar")?.getBoundingClientRect().width >= innerWidth - 16 && !!document.activeElement?.closest(".part.auxiliarybar .monaco-list")');
      await capture.settle();
      // Use the actual tab path; programmatically focusing the iframe can
      // restore its last editor and dismiss Files before the action is focused.
      const direction = await capture.evaluate(() => document.activeElement?.matches('ex-code-panel iframe')) ? 8 : 0;
      for (let step = 0; step < 24; step++) {
        if (await capture.evaluate(() => document.activeElement?.matches('ex-code-panel iframe')) && await frame.executeJavaScript(`document.activeElement?.matches('${findSelector}')`)) break;
        await capture.press('Tab', direction);
      }
      await press('ArrowRight', 'ArrowRight', 39); await press('ArrowLeft', 'ArrowLeft', 37);
      assert.equal(await frame.executeJavaScript(`document.activeElement?.matches('${findSelector}')`), true);
      yield { name: `${theme}-native-find-file-focus`, inspect: ['ex-code-panel .editor-surface'] };
      assert.equal(await frame.executeJavaScript(`document.activeElement?.matches('${findSelector}')`), true, 'Browse must finish focusing the tree before moving to the header');
      await press('Enter', 'Enter', 13);
      await waitNative('!!document.activeElement?.closest(".quick-input-widget")');
      await press('Escape', 'Escape', 27);
      await waitNative('document.querySelector(".part.auxiliarybar")?.getBoundingClientRect().width >= innerWidth - 16');
      await waitNative('[...document.querySelectorAll(".quick-input-widget")].every(widget => widget.getClientRects().length === 0)');
      await capture.cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', ...await findHitPoint() });
      yield { name: `${theme}-native-find-file-hover`, inspect: ['ex-code-panel .editor-surface'] };
      await clickFind();
      await waitNative('!!document.activeElement?.closest(".quick-input-widget")');
      await typeQuery('README');
      await waitNative('document.querySelector(".quick-input-list")?.textContent.includes("README.md")');
      yield { name: `${theme}-compact-find-file`, inspect: ['ex-code-panel .editor-surface'] };
      await press('Enter', 'Enter', 13);
      await waitNative('document.querySelector(".part.auxiliarybar")?.getBoundingClientRect().width === 0 && document.activeElement?.classList.contains("inputarea")');
      await capture.click('ex-workspace-panels [aria-label="Search text in files"]');
      await waitNative('!!document.activeElement?.closest(".quick-input-widget")');
      await typeQuery('%describeWorkspace');
      await waitNative('document.querySelector(".quick-input-list")?.textContent.includes("workspace.ts")');
      yield { name: `${theme}-compact-text-search`, inspect: ['ex-code-panel .editor-surface'] };
      await press('Enter', 'Enter', 13); await press('Escape', 'Escape', 27);
    }
    // A real settings modal must paint over the editor while its browsing
    // context and dirty buffers stay alive beneath the DOM overlay.
    for (const theme of ['light', 'dark']) {
      await capture.theme(theme);
      await capture.click('ex-workspace-navigation .project-title');
      await capture.waitFor(() => document.querySelector('ex-project-menu'));
      const settingsSelector = await capture.evaluate(() => {
        const buttons = [...document.querySelectorAll('ex-project-menu button')];
        const index = buttons.findIndex(button => button.textContent.includes('Project settings'));
        if (index < 0) throw new Error('Settings action missing');
        return 'ex-project-menu button:nth-of-type(' + (index + 1) + ')';
      });
      await capture.click(settingsSelector); await finish();
      await capture.waitFor(() => document.querySelector('[role="dialog"]'));
      assert.equal(await frame.executeJavaScript('!!document.querySelector(".monaco-editor")'), true);
      assert.equal(await capture.evaluate(() => !!document.querySelector('.surface-cover')), false);
      yield { name: `${theme}-settings-over-live-iframe`, inspect: ['[role="dialog"]', 'ex-code-panel iframe'] };
      await capture.press('Escape'); await finish();
      assert.equal(capture.window.webContents.mainFrame.frames.find(child => child.url === frame.url), frame);
    }
    const path = process.env.ELEVENEX_CODE_TEST_WORKSPACE + '/src/workspace.ts';
    const original = await readFile(path, 'utf8');
    try {
      // Auto-save persists editing through both layout directions without a save action.
      assert.equal((await capture.evaluate(target => window.elevenex.codeOpenFile(target, { path: 'src/workspace.ts', line: 10000000, column: 10000000 }), target)).ok, true);
      await capture.evaluate(target => window.elevenex.codeFocus(target), target);
      await waitNative('document.activeElement === document.querySelector(".monaco-editor textarea.inputarea")');
      await capture.cdp('Input.insertText', { text: '// compact panel save verification\n' });
      await waitNative('document.querySelector(".monaco-editor")?.textContent.includes("verification")');
      await capture.click('ex-workspace-panels [aria-label="Expand side panel"]'); await finish();
      await waitNative('(document.querySelector(".part.sidebar")?.getBoundingClientRect().width ?? 0) > 0');
      await waitNative('!document.body.classList.contains("elevenex-compact-files")');
      assert.equal(capture.window.webContents.mainFrame.frames.find(child => child.url === frame.url), frame);
      await capture.click('ex-workspace-panels [role="tab"][aria-label="Browser"]'); await finish();
      await capture.click('ex-workspace-panels [role="tab"][aria-label="Code"]'); await finish();
      assert.equal(capture.window.webContents.mainFrame.frames.find(child => child.url === frame.url), frame);
      assert.equal(await frame.executeJavaScript('document.querySelector(".monaco-editor")?.textContent.includes("verification")'), true);
      for (const theme of ['light', 'dark']) {
        await capture.theme(theme);
        await waitNative(`!!document.querySelector('.monaco-workbench.${theme === 'light' ? 'vs' : 'vs-dark'}')`);
        const navigation = await frame.executeJavaScript(`(() => {
          const item = icon => document.querySelector('.composite-bar .action-label.codicon-' + icon)?.closest('.action-item');
          return Object.fromEntries(['run-view-icon', 'extensions-view-icon', 'explorer-view-icon', 'search-view-icon', 'source-control-view-icon'].map(icon => [icon, item(icon)?.checkVisibility() ?? false]));
        })()`);
        assert.equal(navigation['run-view-icon'], false, 'Run and Debug must be hidden');
        assert.equal(navigation['extensions-view-icon'], false, 'Extensions must be hidden');
        for (const icon of ['explorer-view-icon', 'search-view-icon', 'source-control-view-icon']) assert.equal(navigation[icon], true, `${icon} must remain visible`);
        yield { name: `${theme}-expanded-retained-file`, inspect: ['ex-code-panel .editor-surface'], metadata: { navigation } };
      }
      await capture.click('ex-workspace-panels [aria-label="Return to chat"]'); await finish();
      await waitNative('(document.querySelector(".part.sidebar")?.getBoundingClientRect().width ?? 0) === 0');
      assert.equal(await frame.executeJavaScript('document.querySelector(".monaco-editor")?.textContent.includes("verification")'), true);
      assert.equal(await capture.evaluate(() => !!document.querySelector('ex-workspace-panels .save-file')), false);
      await waitMain(async () => (await readFile(path, 'utf8')) === original + '// compact panel save verification\n', 'Auto-save did not reach the actual task');
      await waitNative('!document.querySelector(".tab.dirty")');
      yield { name: 'compact-autosave-confirmed', inspect: ['ex-workspace-panels .panel-head', 'ex-code-panel .editor-surface'] };
    } finally { await writeFile(path, original); }
    const geometry = async () => {
      await capture.waitFor(() => !document.querySelector('ex-code-panel .frame-container.resizing, ex-code-panel .frame-container.reflowing, ex-code-panel .frame-container.crossfading'));
      await capture.waitFor(() => getComputedStyle(document.querySelector('ex-code-panel .frame-container'), '::after').opacity === '0');
      const bounds = await capture.evaluate(() => {
        const launch = document.querySelector('ex-machine-launch .launch');
        const shell = document.querySelector('ex-machine-workspace ex-app-shell');
        const iframe = document.querySelector('ex-code-panel iframe');
        return {scroll:launch.scrollLeft,launch:launch.getBoundingClientRect().toJSON(),shell:shell.getBoundingClientRect().toJSON(),iframe:iframe.getBoundingClientRect().toJSON(),width:iframe.clientWidth,viewport:iframe.closest('.editor-surface').clientWidth,fallback:!!document.querySelector('ex-code-panel .launch-card')};
      });
      assert.equal(bounds.scroll,0,'Focus scrolled the machine launch viewport');
      assert.ok(Math.abs(bounds.shell.left-bounds.launch.left)<1 && Math.abs(bounds.shell.right-bounds.launch.right)<1,'Workspace shifted and left a blank right margin');
      assert.equal(bounds.fallback,false,'Launch UI replaced or shared space with the retained iframe');
      assert.equal(bounds.width,bounds.viewport,'Editor did not return to the actual panel width');
      // Chromium notifies the out-of-process frame after the parent’s final
      // animation frame. Await its actual viewport/layout rather than a timer.
      await waitMain(async () => {
        const editor = await frame.executeJavaScript('({width:innerWidth,workbench:document.querySelector(".monaco-workbench").getBoundingClientRect().width})');
        return Math.abs(editor.width-bounds.width)<=1 && Math.abs(editor.workbench-bounds.width)<=1;
      }, 'Workbench did not fill the resized iframe: '+JSON.stringify(bounds));
      assert.equal(capture.window.webContents.mainFrame.frames.find(child=>child.url===frame.url),frame);
    };
    const glidingCrossfade = async selector => {
      await capture.evaluate(() => {
        const panel = document.querySelector('ex-app-shell .panel');
        const scope = document.querySelector('ex-code-panel .frame-container');
        window.codeGlide = [];
        const start = performance.now();
        const sample = () => {
          const glide=panel.getAnimations().find(animation=>animation.transitionProperty==='width');
          const iframe=scope.querySelector('iframe');
          window.codeGlide.push({motionTime:glide?.currentTime ?? null,time:performance.now()-start,width:panel.getBoundingClientRect().width,liveScale:iframe.getBoundingClientRect().width/iframe.clientWidth,opacity:Number(getComputedStyle(scope,'::view-transition-old(code-editor)').opacity),active:scope.matches(':active-view-transition'),blur:getComputedStyle(scope,'::view-transition-old(code-editor)').filter});
          if (performance.now()-start<650) requestAnimationFrame(sample);
        };
        sample();
      });
      await capture.click(selector);
      await capture.waitFor(() => window.codeGlide.at(-1)?.time>=650);
      const samples = await capture.evaluate(() => {const samples=window.codeGlide;delete window.codeGlide;return samples;});
      const first=samples[0].width, last=samples.at(-1).width, distance=Math.abs(last-first);
      assert.ok(samples.every(s=>Math.abs(s.liveScale-1)<0.001),'Live editor was stretched, including before snapshot readiness: '+JSON.stringify(samples));
      assert.ok(distance>100,'Panel did not change width');
      const intermediate=samples.filter(s=>Math.abs(s.width-first)>1 && Math.abs(s.width-last)>1);
      assert.ok(intermediate.length>=5,'Panel snapped instead of using the original width glide: '+JSON.stringify(samples));
      const shrinking=last<first;
      // Compositor sampling can land fractionally beyond the held keyframe
      // before its pause commits; reject visible blending, not rounding noise.
      if (shrinking) assert.ok(!intermediate.some(s=>s.active && s.opacity<0.99),'Compact image faded in while still magnified: '+JSON.stringify(samples));
      else assert.ok(intermediate.some(s=>s.active && s.opacity>0 && s.opacity<1 && s.blur!=='none'),'Blur/crossfade did not overlap panel motion: '+JSON.stringify(samples));
      const firstBlur=intermediate.find(s=>s.active && s.blur!=='none' && s.blur!=='blur(0px)');
      assert.ok(firstBlur?.motionTime>=280/3-2 && firstBlur.motionTime<180,'Blur should start around one third into the glide: '+JSON.stringify(samples));
      const firstBlend=samples.find(s=>s.active && s.opacity>0.01 && s.opacity<0.99);
      assert.ok(firstBlend,'No editor crossfade was observed: '+JSON.stringify(samples));
      if (shrinking) assert.ok(Math.abs(firstBlend.width-last)<=1,'Collapse crossfade started before the final width: '+JSON.stringify(samples));
      else assert.ok(firstBlend.motionTime>=280/3-2,'Crossfade started before the first third of the panel glide: '+JSON.stringify(samples));
      assert.ok(!intermediate.some(s=>s.active && s.motionTime<280/3-2 && s.opacity<1),'Outgoing Code faded too early: '+JSON.stringify(samples));
      const largestStep=Math.max(...samples.slice(1).map((s,i)=>Math.abs(s.width-samples[i].width)));
      assert.ok(largestStep<distance*0.65,'Panel width jumped during crossfade: '+JSON.stringify(samples));
      await finish(); await geometry();
      return {intermediateFrames:intermediate.length,largestStep,distance,firstBlendAtMs:firstBlend.motionTime ?? firstBlend.time,firstBlurAtMs:firstBlur.motionTime};
    };
    const viewportMotion = async function* (selector, name) {
      const { CodeFrame } = require('../../../apps/desktop/dist/code/frame.js');
      const settleLayout = CodeFrame.prototype.settleLayout;
      let acknowledge, reachedLayout = false;
      const acknowledgement = new Promise(resolve => { acknowledge = resolve; });
      CodeFrame.prototype.settleLayout = async function(width) {
        await settleLayout.call(this, width);
        reachedLayout = true;
        await acknowledgement;
      };
      // Measure actual child browsing-context resizes, rather than just the
      // shell's geometry. Test-only instrumentation stays inside this process.
      await frame.executeJavaScript(`(() => {
        window.codeViewportWidths = [innerWidth];
        window.codeViewportResize = () => { if (window.codeViewportWidths.length < 60) window.codeViewportWidths.push(innerWidth); };
        addEventListener('resize', window.codeViewportResize);
      })()`);
      await capture.evaluate(() => {
        const iframe = document.querySelector('ex-code-panel iframe');
        let width = iframe.clientWidth;
        window.codeResizeStarted = 0;
        window.codeResizeClick = () => { window.codeResizeStarted = performance.now(); };
        document.addEventListener('click',window.codeResizeClick,{once:true,capture:true});
        window.codeReflowPaints = [];
        window.codeReflowObserver = new window.ResizeObserver(() => {
          if (iframe.clientWidth === width) return;
          width = iframe.clientWidth;
          const scope = iframe.closest('.frame-container');
          window.codeReflowPaints.push({width,transform:getComputedStyle(scope).transform,snapshot:scope.matches(':active-view-transition'),elapsed:performance.now()-window.codeResizeStarted});
        });
        window.codeReflowObserver.observe(iframe);
      });
      try {
        await capture.click(selector);
        await waitMain(() => reachedLayout, 'The real child layout did not settle');
        await capture.settle();
        assert.equal(await capture.evaluate(() => getComputedStyle(document.querySelector('ex-code-panel .frame-container'), '::view-transition-old(code-editor)').opacity), '1', 'Old snapshot faded before the new layout was ready');
        assert.ok(await capture.evaluate(() => {
          const tab=document.querySelector('ex-workspace-panels [role="tab"][aria-label="Code"]');
          const box=tab.getBoundingClientRect(),hit=document.elementFromPoint(box.x+box.width/2,box.y+box.height/2);
          return tab===hit || tab.contains(hit);
        }), 'The snapshot overlay blocked panel controls');
        await frame.executeJavaScript(`window.codeCrossfadeKey=null;window.codeCrossfadeKeyListener=event=>{window.codeCrossfadeKey=event.key;};document.addEventListener('keydown',window.codeCrossfadeKeyListener,{once:true});`);
        await capture.evaluate(target=>window.elevenex.codeFocus(target),target);
        await capture.press('ArrowUp');
        assert.equal(await frame.executeJavaScript('window.codeCrossfadeKey'),'ArrowUp','The retained snapshot blocked editor keyboard input');
        yield {name:`${name}-old-snapshot-held`,inspect:['ex-code-panel .frame-container','iframe']};
        // Keep sampling after acknowledgement, including the actual fade-in.
        // Viewport-only checks miss Explorer/editor grid movement at one size.
        const stableLayout = frame.executeJavaScript(`new Promise(resolve => {
          const parts = [...document.querySelectorAll('.monaco-workbench .part, .monaco-workbench .monaco-editor')].slice(0,32);
          const geometry = () => JSON.stringify(parts.map(part => { const r=part.getBoundingClientRect(); return [r.x,r.y,r.width,r.height]; }));
          const baseline = geometry(); let changes=0, pending=0;
          const sample = () => { if(geometry()!==baseline) changes++; pending=requestAnimationFrame(sample); };
          pending=requestAnimationFrame(sample);
          setTimeout(() => {cancelAnimationFrame(pending);resolve(changes);},350);
        })`);
        acknowledge();
        await finish(); await geometry();
        assert.equal(await stableLayout,0,'Workbench panes continued jumping during or after reveal');
        const widths = await frame.executeJavaScript('window.codeViewportWidths');
        assert.notEqual(widths[0], widths.at(-1), 'Editor must resize to the new viewport');
        assert.equal(new Set(widths).size, 2, 'Code must resize exactly once during panel motion: ' + JSON.stringify(widths));
        assert.ok(await capture.evaluate(() => {const frame=document.querySelector('ex-code-panel .frame-container');return !frame.classList.contains('resizing') && frame.clientWidth===frame.parentElement.clientWidth;}), 'Frozen viewport was not released');
        const paints = await capture.evaluate(() => window.codeReflowPaints);
        assert.ok(paints.length, 'No actual iframe layout change was observed');
        for (const paint of paints) {
          assert.equal(paint.snapshot,true,'An uncovered live resize exposed the layout jump');
          assert.ok(paint.elapsed < 220, 'Destination resize waited until the end of the panel glide: '+JSON.stringify(paint));
        }
        return {widths,destinationResizeMs:paints[0].elapsed,paneChangesDuringReveal:0};
      } finally {
        acknowledge();
        CodeFrame.prototype.settleLayout = settleLayout;
        await frame.executeJavaScript('removeEventListener("resize", window.codeViewportResize); delete window.codeViewportResize; delete window.codeViewportWidths;');
        await frame.executeJavaScript("document.removeEventListener('keydown',window.codeCrossfadeKeyListener);delete window.codeCrossfadeKey;delete window.codeCrossfadeKeyListener;");
        await capture.evaluate(() => { window.codeReflowObserver.disconnect(); document.removeEventListener('click',window.codeResizeClick,true); delete window.codeResizeClick; delete window.codeResizeStarted; delete window.codeReflowObserver; delete window.codeReflowPaints; });
      }
    };
    const closingMotion = async function* (name, interrupted = false, resizing = false) {
      if (resizing) {
        await capture.motion.freeze();
        const before = layoutSequence;
        await capture.click('ex-workspace-panels [aria-label="Expand side panel"]');
        await waitMain(()=>layoutSequence>before && settledSequence===layoutSequence,'Interrupted expansion did not settle');
        await capture.settle();
        await capture.evaluate(() => {
          for (const region of document.querySelector('ex-app-shell .workspace').children) {
            for (const animation of region.getAnimations()) if ('transitionProperty' in animation) animation.currentTime=140;
          }
        });
        await capture.settle();
      }
      const before = await capture.evaluate(() => ({width:document.querySelector('ex-code-panel iframe').clientWidth,inner:document.querySelector('ex-app-shell .panel-inner').clientWidth,transform:getComputedStyle(document.querySelector('ex-code-panel .frame-container')).transform}));
      await capture.motion.freeze();
      await capture.click('ex-workspace-panels [aria-label="Close side panel"]');
      // Include subpixel/zero-width frames before retention cleanup: composited
      // editor layers must stay clipped right up to the end of the slide.
      for (const time of interrupted ? [140] : [70,140,245,270,279]) {
        await capture.evaluate(time => {
          for (const region of document.querySelector('ex-app-shell .workspace').children) {
            for (const animation of region.getAnimations()) if ('transitionProperty' in animation) animation.currentTime=time;
          }
        },time);
        await capture.settle();
        const state=await capture.evaluate(() => {
          const panel=document.querySelector('ex-app-shell .panel'), inner=panel.querySelector('.panel-inner'), scope=panel.querySelector('ex-code-panel .frame-container'), iframe=scope.querySelector('iframe');
          return {opacity:getComputedStyle(panel).opacity,inert:panel.inert,visible:!scope.hidden && !!iframe,width:iframe?.clientWidth,inner:inner.clientWidth,transform:getComputedStyle(scope).transform,cover:getComputedStyle(scope,'::after').opacity};
        });
        assert.deepEqual(state,{opacity:'1',inert:true,visible:true,width:before.width,inner:before.inner,transform:before.transform,cover:'0'},'Closing discarded, faded or resized the outgoing editor');
        assert.equal(await frame.executeJavaScript('innerWidth'),before.width,'Closing resized the real child browsing context');
        assert.equal(capture.window.webContents.mainFrame.frames.find(child=>child.url===frame.url),frame);
        yield {name:`${name}-closing-${time}ms`,inspect:['.panel','.panel-inner','ex-code-panel .frame-container','iframe']};
      }
      if (interrupted) {
        await capture.click('ex-workspace-task-header [aria-label="Toggle side panel"]');
        await capture.motion.finish(); await capture.motion.play(); await finish(); await geometry();
        assert.ok(await capture.evaluate(()=>!!document.querySelector('ex-code-panel iframe')),'Interrupted reopening parked the retained editor');
        yield {name:`${name}-reopened`,inspect:['.panel','iframe']};
      } else {
        await capture.motion.finish(); await capture.motion.play(); await finish();
        assert.equal(await capture.evaluate(()=>!!document.querySelector('ex-code-panel iframe')),false,'Closed editor was not parked after the slide');
        await capture.click('ex-workspace-task-header [aria-label="Toggle side panel"]'); await finish(); await geometry();
      }
    };
    for (const theme of ['light','dark']) {
      await capture.theme(theme);
      const glideExpansion=await glidingCrossfade('ex-workspace-panels [aria-label="Expand side panel"]');
      const glideCollapse=await glidingCrossfade('ex-workspace-panels [aria-label="Return to chat"]');
      yield {name:`${theme}-continuous-panel-glide`,metadata:{glideExpansion,glideCollapse},inspect:['.panel','iframe']};
      const expansion = yield* viewportMotion('ex-workspace-panels [aria-label="Expand side panel"]',`${theme}-expansion`);
      const collapse = yield* viewportMotion('ex-workspace-panels [aria-label="Return to chat"]',`${theme}-collapse`);
      yield { name: `${theme}-single-editor-resize`, inspect: ['ex-code-panel .editor-surface'], metadata: { expansion, collapse } };
      for (let cycle=0;cycle<3;cycle++) {
        await capture.click('ex-workspace-panels [aria-label="Close side panel"]'); await finish();
        if (cycle===0) await capture.motion.freeze();
        await capture.click('ex-workspace-task-header [aria-label="Toggle side panel"]');
        if (cycle===0) {
          await capture.evaluate(() => {
            for (const region of document.querySelector('ex-app-shell .workspace').children) {
              for (const animation of region.getAnimations()) if ('transitionProperty' in animation) animation.currentTime=90;
            }
          });
          await capture.settle();
          assert.deepEqual(await capture.evaluate(() => {
            const scope=document.querySelector('ex-code-panel .frame-container');
            return {visible:!scope.hidden && !!scope.querySelector('iframe'),cover:getComputedStyle(scope,'::after').opacity,reflowing:scope.classList.contains('reflowing'),crossfading:scope.classList.contains('crossfading'),resizing:scope.classList.contains('resizing')};
          }),{visible:true,cover:'0',reflowing:false,crossfading:false,resizing:false},'Code must be visible during the opening slide without a resize cover or crossfade');
          assert.equal(capture.window.webContents.mainFrame.frames.find(child=>child.url===frame.url),frame,'Reopening recreated the editor');
          yield {name:`${theme}-instant-panel-opening`,inspect:['.panel','ex-code-panel .frame-container','iframe']};
          await capture.motion.finish(); await capture.motion.play();
        }
        await finish();
        await capture.waitFor(()=>document.querySelector('ex-code-panel')?.getAttribute('aria-busy')==='false');
        await capture.evaluate(target=>window.elevenex.codeFocus(target),target); await finish();
        await geometry();
        await capture.click('ex-workspace-panels [aria-label="Expand side panel"]'); await finish(); await geometry();
        await capture.click('ex-workspace-panels [aria-label="Return to chat"]'); await finish(); await geometry();
      }
      yield* closingMotion(`${theme}-compact`);
      yield* closingMotion(`${theme}-interrupted`,true);
      await capture.click('ex-workspace-panels [aria-label="Expand side panel"]'); await finish(); await geometry();
      yield* closingMotion(`${theme}-wide`);
      yield* closingMotion(`${theme}-mid-expansion`,false,true);
      yield {name:`${theme}-reopened-without-right-gap`,inspect:['ex-machine-launch .launch','ex-app-shell','.panel','iframe']};
      await capture.motion.freeze();
      const beforeExpansion = layoutSequence;
      await capture.click('ex-workspace-panels [aria-label="Expand side panel"]');
      await capture.waitFor(() => document.querySelector('ex-code-panel .frame-container').getAnimations({subtree:true}).some(a=>a.animationName?.endsWith('code-layout-out') && a.playState==='running'));
      await waitMain(() => layoutSequence > beforeExpansion && settledSequence === layoutSequence, 'Expansion layout did not settle');
      await capture.settle();
      const heldWidth = await capture.evaluate(() => document.querySelector('ex-code-panel iframe').clientWidth);
      await capture.evaluate(() => {
        for (const region of document.querySelector('ex-app-shell .workspace').children) {
          for (const animation of region.getAnimations()) if ('transitionProperty' in animation) animation.currentTime=140;
        }
        for (const animation of document.querySelector('ex-code-panel .frame-container').getAnimations({subtree:true})) if(animation.animationName?.includes('code-layout-')) animation.currentTime=Number(animation.effect.getComputedTiming().delay)+105;
      });
      await capture.settle();
      assert.equal(await capture.evaluate(()=>!!document.querySelector('ex-code-panel .launch-card')),false);
      assert.equal(await capture.evaluate(() => document.querySelector('ex-code-panel iframe').clientWidth), heldWidth, 'Midpoint reflowed the editor');
      assert.ok(await capture.evaluate(() => document.querySelector('ex-code-panel .frame-container').classList.contains('crossfading')));
      assert.deepEqual(await capture.evaluate(() => {
        const scope=document.querySelector('ex-code-panel .frame-container');
        const old=getComputedStyle(scope,'::view-transition-old(code-editor)');
        return {followsPanel:Math.abs(scope.getBoundingClientRect().width-scope.parentElement.clientWidth)<1,blending:Number(old.opacity)>0 && Number(old.opacity)<1,fit:old.objectFit,newOpacity:getComputedStyle(scope,'::view-transition-new(code-editor)').opacity};
      }), {followsPanel:true,blending:true,fit:'fill',newOpacity:'1'}, 'Old and new snapshots must stretch with the panel and blend in one phase');
      yield {name:`${theme}-expansion-interrupted`,inspect:['.panel','ex-code-panel','iframe']};
      await capture.click('ex-workspace-panels [aria-label="Return to chat"]');
      await capture.motion.finish(); await capture.motion.play(); await finish(); await geometry();
      await capture.click('ex-workspace-panels [aria-label="Expand side panel"]'); await finish(); await geometry();
      await capture.motion.freeze();
      const beforeCollapse = layoutSequence;
      await capture.click('ex-workspace-panels [aria-label="Return to chat"]');
      await capture.waitFor(() => document.querySelector('ex-code-panel .frame-container').getAnimations({subtree:true}).some(a=>a.animationName?.endsWith('code-layout-out') && a.playState==='running'));
      await waitMain(() => layoutSequence > beforeCollapse && settledSequence === layoutSequence, 'Collapse layout did not settle');
      await capture.settle();
      const wideWidth = await capture.evaluate(() => document.querySelector('ex-code-panel iframe').clientWidth);
      await capture.evaluate(() => {
        for (const region of document.querySelector('ex-app-shell .workspace').children) {
          for (const animation of region.getAnimations()) if ('transitionProperty' in animation) animation.currentTime=140;
        }
        for (const animation of document.querySelector('ex-code-panel .frame-container').getAnimations({subtree:true})) if(animation.animationName?.includes('code-layout-')) animation.currentTime=Number(animation.effect.getComputedTiming().delay)+105;
      });
      await capture.settle();
      assert.equal(await capture.evaluate(() => document.querySelector('ex-code-panel iframe').clientWidth),wideWidth,'Collapse midpoint reflowed the editor');
      assert.deepEqual(await capture.evaluate(() => {
        const scope=document.querySelector('ex-code-panel .frame-container');
        const old=getComputedStyle(scope,'::view-transition-old(code-editor)');
        const incoming=getComputedStyle(scope,'::view-transition-new(code-editor)');
        return {followsPanel:Math.abs(scope.getBoundingClientRect().width-scope.parentElement.clientWidth)<1,oldOpaque:Number(old.opacity)===1,incomingBlurred:incoming.filter!=='none' && incoming.filter!=='blur(0px)',fit:old.objectFit,newOpacity:incoming.opacity};
      }), {followsPanel:true,oldOpaque:true,incomingBlurred:true,fit:'fill',newOpacity:'1'}, 'Collapse must keep the magnified compact image blurred behind the opaque old snapshot');
      yield {name:`${theme}-collapse-interrupted`,inspect:['.panel','ex-code-panel .frame-container','iframe']};
      await capture.click('ex-workspace-panels [aria-label="Expand side panel"]');
      await capture.motion.finish(); await capture.motion.play(); await finish(); await geometry();
      await capture.click('ex-workspace-panels [aria-label="Return to chat"]'); await finish(); await geometry();
      await capture.viewport(900,700); await finish(); await geometry();
      const narrowExpansion = yield* viewportMotion('ex-workspace-panels [aria-label="Expand side panel"]',`${theme}-narrow-expansion`);
      const narrowCollapse = yield* viewportMotion('ex-workspace-panels [aria-label="Return to chat"]',`${theme}-narrow-collapse`);
      yield {name:`${theme}-narrow-crossfade`,inspect:['ex-code-panel .editor-surface'],metadata:{expansion:narrowExpansion,collapse:narrowCollapse}};
      await capture.viewport(1440,900); await finish(); await geometry();
    }
    await frame.executeJavaScript("import('/assets/out/vs/workbench/workbench.web.main.internal.js').then(({commands})=>commands.executeCommand('workbench.action.closeAllEditors'))");
    await waitNative('document.querySelector(".part.auxiliarybar")?.getBoundingClientRect().width >= innerWidth - 16');
    yield {name:'last-editor-closed-shows-files',inspect:['ex-code-panel','ex-workspace-panels .browse-files','iframe']};
    await capture.viewport(700, 600); await capture.reducedMotion(true); await finish();
    await capture.waitFor(() => document.querySelector('ex-code-frame iframe')?.getBoundingClientRect().width >= 320);
    yield { name: 'narrow-reduced-motion', inspect: ['ex-code-panel', 'ex-workspace-panels .panel-head', 'ex-code-panel .editor-surface'] };
    await capture.click('ex-workspace-panels [aria-label="Close side panel"]'); await finish();
    assert.equal(await capture.evaluate(() => document.querySelector('ex-code-frame iframe')?.checkVisibility() ?? false), false);
    yield { name: 'closed-panel-focus', inspect: ['ex-app-shell .panel'] };
  } finally { holdBootstrap=false; resumeBootstrap(); CodeProtocol.prototype.handle=handle; CodeFrame.prototype.settleLayout=settleLayout; ipc.broadcast=broadcast; Object.assign(BackendManager.prototype, previous); }
}
