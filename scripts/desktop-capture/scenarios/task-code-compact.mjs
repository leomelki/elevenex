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
    const finish = async () => { await capture.settle(); await capture.waitFor(() => document.getAnimations().every(animation => !Number.isFinite(animation.effect?.getComputedTiming().endTime) || animation.playState !== 'running')); };
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
      const bounds = await capture.evaluate(() => {
        const launch = document.querySelector('ex-machine-launch .launch');
        const shell = document.querySelector('ex-machine-workspace ex-app-shell');
        const iframe = document.querySelector('ex-code-panel iframe');
        return {scroll:launch.scrollLeft,launch:launch.getBoundingClientRect().toJSON(),shell:shell.getBoundingClientRect().toJSON(),iframe:iframe.getBoundingClientRect().toJSON(),width:iframe.clientWidth,fallback:!!document.querySelector('ex-code-panel .launch-card')};
      });
      assert.equal(bounds.scroll,0,'Focus scrolled the machine launch viewport');
      assert.ok(Math.abs(bounds.shell.left-bounds.launch.left)<1 && Math.abs(bounds.shell.right-bounds.launch.right)<1,'Workspace shifted and left a blank right margin');
      assert.equal(bounds.fallback,false,'Launch UI replaced or shared space with the retained iframe');
      // Chromium notifies the out-of-process frame after the parent’s final
      // animation frame. Await its actual viewport/layout rather than a timer.
      await waitMain(async () => {
        const editor = await frame.executeJavaScript('({width:innerWidth,workbench:document.querySelector(".monaco-workbench").getBoundingClientRect().width})');
        return Math.abs(editor.width-bounds.width)<=1 && Math.abs(editor.workbench-bounds.width)<=1;
      }, 'Workbench did not fill the resized iframe: '+JSON.stringify(bounds));
      assert.equal(capture.window.webContents.mainFrame.frames.find(child=>child.url===frame.url),frame);
    };
    for (const theme of ['light','dark']) {
      await capture.theme(theme);
      for (let cycle=0;cycle<3;cycle++) {
        await capture.click('ex-workspace-panels [aria-label="Close side panel"]'); await finish();
        await capture.click('ex-workspace-task-header [aria-label="Toggle side panel"]'); await finish();
        await capture.waitFor(()=>document.querySelector('ex-code-panel')?.getAttribute('aria-busy')==='false');
        await capture.evaluate(target=>window.elevenex.codeFocus(target),target); await finish();
        await geometry();
        await capture.click('ex-workspace-panels [aria-label="Expand side panel"]'); await finish(); await geometry();
        await capture.click('ex-workspace-panels [aria-label="Return to chat"]'); await finish(); await geometry();
      }
      yield {name:`${theme}-reopened-without-right-gap`,inspect:['ex-machine-launch .launch','ex-app-shell','.panel','iframe']};
      await capture.motion.freeze();
      const previousAnimations = new Set(capture.motion.animations);
      await capture.click('ex-workspace-panels [aria-label="Expand side panel"]');
      const opening = [...capture.motion.animations].filter(id=>!previousAnimations.has(id));
      assert.ok(opening.length,'Panel expansion animation did not start');
      await capture.cdp('Animation.seekAnimations',{animations:opening,currentTime:80});
      await capture.settle();
      assert.equal(await capture.evaluate(()=>!!document.querySelector('ex-code-panel .launch-card')),false);
      yield {name:`${theme}-expansion-interrupted`,inspect:['.panel','ex-code-panel','iframe']};
      await capture.click('ex-workspace-panels [aria-label="Return to chat"]');
      await capture.motion.finish(); await capture.motion.play(); await finish(); await geometry();
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
  } finally { holdBootstrap=false; resumeBootstrap(); CodeProtocol.prototype.handle=handle; ipc.broadcast=broadcast; Object.assign(BackendManager.prototype, previous); }
}
