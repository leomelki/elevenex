import assert from 'node:assert/strict';
import { app, BrowserWindow } from 'electron';
import { cp, writeFile } from 'node:fs/promises';
import { Capture } from '../driver.mjs';
import { captureWindowPixels } from '../native-surfaces.mjs';
import { join } from 'node:path';
const requiredId = name => { const value = Number(process.env[name]); if (!Number.isSafeInteger(value) || value < 1) throw new Error('Set ' + name + ' to a disposable live backend resource.'); return value; };
export default async function* (capture) {
  const ux = process.env.ELEVENEX_CODE_CAPTURE_UX === '1';
  const waitMain = async (predicate, message) => { const deadline = Date.now() + 15000; while (!await predicate()) { if (Date.now() > deadline) throw new Error(message + ': ' + JSON.stringify(BrowserWindow.getAllWindows().map(window => ({ focused: window.isFocused(), rootFocused: window.webContents.isFocused(), views: window.contentView.children.map(view => ({ visible: view.getVisible(), focused: view.webContents?.isFocused() })) })))); await new Promise(resolve => setTimeout(resolve, 40)); } };
  const projectId = requiredId('ELEVENEX_CODE_CAPTURE_PROJECT'), taskId = requiredId('ELEVENEX_CODE_CAPTURE_TASK'), sessionId = requiredId('ELEVENEX_CODE_CAPTURE_SESSION');
  if (process.env.ELEVENEX_CODE_SMOKE_CACHE) await cp(join(process.env.ELEVENEX_CODE_SMOKE_CACHE, '1.144.0'), join(app.getPath('userData'), 'code-runtimes/1.144.0'), {recursive:true});
  const finish = async () => { await capture.settle(); await capture.waitFor(() => document.getAnimations().every(animation => !Number.isFinite(animation.effect?.getComputedTiming().endTime) || animation.playState !== 'running')); await capture.settle(); };
  await capture.viewport(1440, 900);
  await capture.waitFor(() => document.querySelector('button[data-machine="local"]'));
  await capture.click('button[data-machine="local"]'); await finish();
  await capture.waitFor(() => document.querySelector('ex-workspace-navigation ex-task-list'));
  await capture.waitFor(id => document.querySelector(`[data-project-id="${id}"]`), projectId);
  await capture.click(`[data-project-id="${projectId}"]`); await finish();
  await capture.waitFor(id => document.querySelector(`[data-task-id="${id}"]`), taskId);
  if (await capture.evaluate(id => document.querySelector(`[data-task-id="${id}"] button.toggle`)?.getAttribute('aria-expanded') === 'false', taskId)) { await capture.click(`[data-task-id="${taskId}"] button.toggle`); await finish(); }
  await capture.waitFor(id => document.querySelector(`[data-session-id="${id}"] button.select`), sessionId);
  await capture.click(`[data-session-id="${sessionId}"] button.select`); await finish();
  await capture.waitFor(() => document.querySelector('ex-workspace-task-header'));
  await capture.click('ex-workspace-task-header [aria-label="Toggle side panel"]'); await finish();
  await capture.click('ex-workspace-panels [role="tab"][aria-label="Code"]'); await finish();
  await capture.waitFor(() => document.querySelector('ex-code-panel h2')?.textContent.includes('Your task'));
  for (const theme of ['light', 'dark']) {
    await capture.theme(theme); await capture.settle();
    yield { name: `${theme}-code-compact-live`, inspect: ['ex-code-panel', 'ex-code-panel .workspace-identity', 'ex-code-panel button'] };
  }
  if (ux) {
    await capture.motion.freeze();
    const openingBefore = new Set(capture.motion.animations); await capture.click('ex-code-panel .expand-here');
    const opening = [...capture.motion.animations].filter(id => !openingBefore.has(id));
    assert.ok(opening.length); await capture.cdp('Animation.seekAnimations', { animations: opening, currentTime: 100 }); await capture.settle();
    yield { name: 'code-opening-interrupted', inspect: ['ex-code-panel', 'ex-app-shell .panel'] };
    const closingBefore = new Set(capture.motion.animations); await capture.click('ex-workspace-panels [aria-label="Return to chat"]');
    const closing = [...capture.motion.animations].filter(id => !closingBefore.has(id));
    assert.ok(closing.length); await capture.cdp('Animation.seekAnimations', { animations: closing, currentTime: 100 }); await capture.settle();
    yield { name: 'code-opening-reversed', inspect: ['ex-code-panel', 'ex-app-shell .panel'] };
    await capture.motion.play(); await finish();
    await capture.waitFor(() => !document.querySelector('ex-code-panel .expand-here').disabled);
  }
  await capture.click('ex-code-panel .expand-here'); await finish();
  const readyDeadline = Date.now() + 90000;
  while (!await capture.evaluate(() => document.querySelector('ex-code-panel .status')?.textContent.includes('Task connected'))) { if (Date.now() > readyDeadline) throw new Error('Real editor did not connect'); await new Promise(resolve => setTimeout(resolve, 100)); }
  const result = await capture.evaluate(async taskId => { const {scope} = await window.elevenex.backendClientState(); return window.elevenex.codeOpenFile({scopeId:scope.id,taskId},{path:'src/workspace.ts',line:7}); }, taskId);
  assert.equal(result.ok, true, JSON.stringify(result));
  const liveView = BrowserWindow.getAllWindows().flatMap(window => window.contentView.children).find(view => view.webContents?.getURL().includes('code.elevenex.invalid'));
  if (ux) await waitMain(async () => liveView.getVisible() && await liveView.webContents.executeJavaScript('document.activeElement === document.querySelector(".monaco-editor textarea.inputarea")'), 'Opening Code did not hand focus to the visible native editor');
  const fileDeadline = Date.now() + 45000;
  while (!await liveView.webContents.executeJavaScript('!!document.querySelector(".monaco-editor textarea.inputarea")')) { if (Date.now() > fileDeadline) throw new Error('Actual editor did not paint'); await new Promise(resolve => setTimeout(resolve, 100)); }
  assert.equal(await liveView.webContents.executeJavaScript('(document.querySelector(".part.titlebar")?.getBoundingClientRect().height ?? 0)'), 0, 'The redundant Code title bar still occupies space');
  assert.ok(await liveView.webContents.executeJavaScript('(document.querySelector(".part.editor")?.getBoundingClientRect().top ?? Infinity) <= 8'), 'File tabs did not reclaim the title-bar space');
  for (const theme of ['light', 'dark']) {
    await capture.theme(theme); await capture.settle();
    const themeDeadline = Date.now() + 10000;
    while (!await liveView.webContents.executeJavaScript(`!!document.querySelector('.monaco-workbench.${theme === 'light' ? 'vs' : 'vs-dark'}')`)) { if (Date.now() > themeDeadline) throw new Error('Native editor theme did not reconcile: ' + await liveView.webContents.executeJavaScript('document.body.className + " | " + document.querySelector(".monaco-workbench")?.className')); await new Promise(resolve => setTimeout(resolve, 50)); }
    yield { name: `${theme}-code-expanded-live`, inspect: ['ex-code-panel .editor-surface', 'ex-app-shell .main', 'ex-app-shell .panel'] };
    assert.match(await liveView.webContents.executeJavaScript('document.body.innerText'), /Ln\s*7,\s*Col\s*1/);
    const window = BrowserWindow.getAllWindows().find(w => w.contentView.children.length);
    const view = window?.contentView.children.find(view => view.webContents?.getURL().includes('code.elevenex.invalid'));
    assert.ok(view, 'Real native Code surface must be present');
    assert.equal(await view.webContents.executeJavaScript('typeof window.elevenex'), 'undefined');
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  if (ux) {
    const geometry = await capture.rect('ex-code-panel .editor-surface');
    assert.ok(geometry.height >= 740 && geometry.y <= 140, JSON.stringify(geometry));
    await capture.hover('ex-code-panel [aria-label="Focus editor"]');
    await capture.waitFor(() => document.querySelector('[role="tooltip"]')?.textContent.includes('Focus editor'));
    assert.equal(liveView.getVisible(), true, 'A toolbar tooltip hid the editor');
    yield { name: 'code-toolbar-tooltip-live', inspect: ['ex-code-panel .workspace-identity', '[role="tooltip"]'] };
    capture.window.webContents.focus();
    await capture.evaluate(() => document.querySelector('ex-code-panel [aria-label="Focus editor"]').focus());
    await capture.press('Enter'); await waitMain(() => liveView.webContents.executeJavaScript('document.activeElement === document.querySelector(".monaco-editor textarea.inputarea")'), 'Keyboard Focus editor did not hand off focus');
  }
  const upstream = (command, ...args) => liveView.webContents.executeJavaScript(`import('/assets/out/vs/workbench/workbench.web.main.internal.js').then(({commands}) => commands.executeCommand(${JSON.stringify(command)},...${JSON.stringify(args)}))`);
  const waitNative = async predicate => { const deadline = Date.now() + 15000; while (!await liveView.webContents.executeJavaScript(predicate)) { if (Date.now() > deadline) throw new Error('Native search did not resolve: ' + await liveView.webContents.executeJavaScript('document.body.innerText.slice(-1500)')); await new Promise(resolve => setTimeout(resolve, 50)); } };
  await upstream('workbench.action.quickOpen', 'README');
  await waitNative('document.querySelector(".quick-input-list")?.textContent.includes("README.md")');
  yield {name:'code-filename-search-live',inspect:['ex-code-panel .editor-surface']};
  liveView.webContents.debugger.attach('1.3');
  for(const type of ['keyDown','keyUp']) await liveView.webContents.debugger.sendCommand('Input.dispatchKeyEvent',{type,key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
  liveView.webContents.debugger.detach();
  await upstream('workbench.action.findInFiles',{query:'no-such-stale-query',triggerSearch:true});
  await upstream('workbench.action.findInFiles',{query:'describeWorkspace',triggerSearch:true});
  await waitNative('document.querySelector(".search-view")?.innerText.includes("describeWorkspace") && document.querySelector(".search-view")?.innerText.includes("workspace.ts")');
  yield {name:'code-text-search-live',inspect:['ex-code-panel .editor-surface']};
  await upstream('workbench.view.explorer');
  if (ux) {
    await capture.viewport(900, 850); await finish();
    const stable = await capture.evaluate(async () => {
      const states = []; for (let frame = 0; frame < 16; frame++) { await new Promise(resolve => requestAnimationFrame(resolve)); states.push(document.querySelector('ex-code-panel .editor-surface').classList.contains('loaded')); } return states;
    });
    assert.ok(stable.every(value => value === false), 'Editor oscillated near its minimum width');
    assert.equal(liveView.getVisible(), false);
    yield { name: 'code-minimum-width-live', inspect: ['ex-code-panel .editor-surface', 'ex-code-panel .launch-actions'] };
    await capture.viewport(1440, 900); await finish(); await waitMain(() => liveView.getVisible(), 'Resize did not restore the retained editor');
    capture.window.webContents.focus(); await capture.evaluate(() => document.querySelector('ex-code-panel [aria-label="Focus editor"]').focus()); await capture.press('Enter');
    await waitMain(() => liveView.webContents.executeJavaScript('document.activeElement === document.querySelector(".monaco-editor textarea.inputarea")'), 'Editor did not regain focus');
    liveView.webContents.debugger.attach('1.3');
    for (const type of ['keyDown', 'keyUp']) await liveView.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type, key: 'r', code: 'KeyR', windowsVirtualKeyCode: 82, modifiers: process.platform === 'darwin' ? 12 : 10 });
    liveView.webContents.debugger.detach(); await finish();
    await capture.waitFor(() => !document.querySelector('ex-app-shell').classList.contains('wide-review'));
    assert.equal(liveView.getVisible(), false);
    assert.equal(await capture.evaluate(() => !!document.activeElement?.closest('ex-app-shell .main') && !document.activeElement?.closest('[inert]')), true, 'Returning to chat did not restore focus');
    yield { name: 'code-keyboard-return-live', inspect: ['ex-code-panel', 'ex-app-shell .main'] };
  } else { await capture.click('ex-workspace-panels [aria-label="Return to chat"]'); await finish(); }
  await capture.viewport(640, 850); await capture.reducedMotion(true); await capture.settle();
  yield { name: 'code-narrow-reduced-motion-live', inspect: ['ex-code-panel', 'ex-app-shell .panel'] };
  if (ux) {
    assert.equal(await capture.evaluate(() => getComputedStyle(document.querySelector('ex-code-panel .expand-here')).display), 'none');
    assert.notEqual(await capture.evaluate(() => getComputedStyle(document.querySelector('ex-code-panel .open-window')).display), 'none');
    await capture.theme('light'); yield { name: 'code-narrow-light-live', inspect: ['ex-code-panel', 'ex-code-panel .launch-actions'] };
    await capture.viewport(640, 480); await capture.settle();
    await capture.evaluate(() => document.querySelector('ex-code-panel .open-window').focus());
    const visibleAction = await capture.rect('ex-code-panel .open-window');
    assert.ok(visibleAction.y >= 0 && visibleAction.y + visibleAction.height <= 480);
    yield { name: 'code-short-keyboard-focus-live', inspect: ['ex-code-panel .editor-surface', 'ex-code-panel .open-window'] };
    await capture.viewport(640, 850); await capture.theme('dark'); await capture.settle();
    await capture.click('ex-code-panel .open-window');
    await waitMain(() => BrowserWindow.getAllWindows().some(window => window !== capture.window && window.webContents.getURL().endsWith('/code-window')), 'The narrow action did not open a dedicated editor');
    const editorWindow = BrowserWindow.getAllWindows().find(window => window !== capture.window && window.webContents.getURL().endsWith('/code-window'));
    const diagnostics = { errors: [], warnings: [], droppedDiagnostics: 0 };
    const childCapture = new Capture(editorWindow, capture.nativeTheme, { ...capture.options, width: 1100, height: 850 }, diagnostics);
    try {
      await childCapture.initialize();
      await childCapture.waitFor(() => document.querySelector('ex-code-panel .status')?.textContent.includes('Task connected'));
      await waitMain(() => editorWindow.contentView.children.some(view => view.webContents?.id === liveView.webContents.id && view.getVisible()), 'The editor was duplicated or not reattached to its window');
      await waitMain(() => liveView.webContents.executeJavaScript('document.activeElement === document.querySelector(".monaco-editor textarea.inputarea")'), 'The new editor window did not focus the workbench');
      const explorerDeadline = Date.now() + 15000;
      while (!await liveView.webContents.executeJavaScript('document.querySelector(".explorer-folders-view")?.innerText.includes("README.md")')) {
        // Background native widgets need capture requests to submit compositor
        // frames in this runner; await real tree pixels before keeping an image.
        await captureWindowPixels(childCapture, { format: 'png', captureBeyondViewport: false });
        if (Date.now() > explorerDeadline) throw new Error('Explorer did not reconcile: ' + await liveView.webContents.executeJavaScript('document.body.innerText.slice(0,1800) + " | explorer=" + document.querySelector(".explorer-folders-view")?.outerHTML.slice(0,1400)'));
      }
      assert.equal(await liveView.webContents.executeJavaScript('document.activeElement === document.querySelector(".monaco-editor textarea.inputarea")'), true, 'Explorer reconciliation stole editor focus');
      const pixels = await captureWindowPixels(childCapture, { format: 'png', captureBeyondViewport: false });
      assert.equal(await liveView.webContents.executeJavaScript('(document.querySelector(".part.titlebar")?.getBoundingClientRect().height ?? 0)'), 0);
      await writeFile(join(capture.options.out, 'code-editor-window.png'), pixels.bytes);
      await childCapture.click('ex-title-island button');
      await childCapture.waitFor(() => !!document.querySelector('ex-title-island [role="dialog"]'));
      await waitMain(() => !liveView.getVisible(), 'Native content covered the machine menu');
      await childCapture.waitFor(() => document.querySelector('ex-code-panel .surface-cover')?.textContent.includes('Your editor stays open'));
      const menu = await captureWindowPixels(childCapture, { format: 'png', captureBeyondViewport: false });
      await writeFile(join(capture.options.out, 'code-editor-window-menu.png'), menu.bytes);
      await childCapture.press('Escape');
      await waitMain(() => liveView.getVisible(), 'The editor did not return after closing its menu');
      assert.deepEqual(diagnostics.errors, []);
      await writeFile(join(capture.options.out, 'code-editor-window-report.json'), JSON.stringify({ ...diagnostics, verified: true, nativeSurfaces: pixels.surfaces }, null, 2));
    } finally { childCapture.dispose(); editorWindow.close(); }
    await waitMain(() => editorWindow.isDestroyed(), 'Editor window did not close');
    capture.window.show(); capture.window.focus(); await capture.settle();
    assert.equal(await capture.evaluate(() => Array.from(document.querySelectorAll('ex-code-panel button')).some(button => button.textContent.trim() === 'Focus other window')), false);
    yield { name: 'code-retained-after-window-close-live', inspect: ['ex-code-panel', 'ex-code-panel .launch-actions'], metadata: { editorWindow: 'code-editor-window.png', menu: 'code-editor-window-menu.png' } };
  }
  await capture.click('ex-workspace-panels [aria-label="Close side panel"]'); await finish();
  assert.equal(await capture.evaluate(() => document.querySelector('ex-app-shell .panel')?.hasAttribute('inert')), true);
  yield { name: 'code-closed-focus-live', inspect: ['ex-app-shell .panel', 'ex-workspace-task-header'] };
}
