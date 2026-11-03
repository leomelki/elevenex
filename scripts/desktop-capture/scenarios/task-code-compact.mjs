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
  try {
    await cp(join(process.env.ELEVENEX_CODE_SMOKE_CACHE, '1.144.0'), join(app.getPath('userData'), 'code-runtimes/1.144.0'), { recursive: true });
    const finish = async () => { await capture.settle(); await capture.waitFor(() => document.getAnimations().every(animation => !Number.isFinite(animation.effect?.getComputedTiming().endTime) || animation.playState !== 'running')); };
    await capture.viewport(1440, 900);
    await capture.waitFor(() => document.querySelector('button[data-machine="local"]'));
    await capture.click('button[data-machine="local"]'); await finish();
    await capture.waitFor(id => document.querySelector(`[data-project-id="${id}"]`), projectId);
    await capture.click(`[data-project-id="${projectId}"]`); await finish();
    await capture.waitFor(id => document.querySelector(`[data-task-id="${id}"]`), taskId);
    if (await capture.evaluate(id => document.querySelector(`[data-task-id="${id}"] button.toggle`)?.getAttribute('aria-expanded') === 'false', taskId)) await capture.click(`[data-task-id="${taskId}"] button.toggle`);
    await capture.waitFor(id => document.querySelector(`[data-session-id="${id}"] button.select`), sessionId);
    await capture.click(`[data-session-id="${sessionId}"] button.select`); await finish();
    await capture.click('ex-workspace-task-header [aria-label="Toggle side panel"]'); await finish();
    await capture.click('ex-workspace-panels [role="tab"][aria-label="Code"]'); await finish();
    const waitMain = async (predicate, message) => { const deadline = Date.now() + 45000; while (!await predicate()) { if (Date.now() > deadline) throw new Error(message); await new Promise(resolve => setTimeout(resolve, 40)); } };
    await waitMain(() => capture.evaluate(() => !!document.querySelector('ex-workspace-panels .find-file')), 'Compact editor did not open');
    const frame = capture.window.webContents.mainFrame.frames.find(frame => frame.url.includes('code.elevenex.invalid'));
    assert.ok(frame); assert.equal(capture.window.contentView.children.length, 0);
    const target = await capture.evaluate(async taskId => ({ scopeId: (await window.elevenex.backendClientState()).scope.id, taskId }), taskId);
    assert.equal((await capture.evaluate(({ target }) => window.elevenex.codeOpenFile(target, { path: 'src/workspace.ts', line: 7 }), { target })).ok, true);
    await waitMain(() => frame.executeJavaScript('!!document.querySelector(".monaco-editor textarea.inputarea")'), 'Real file missing');
    assert.ok(await frame.executeJavaScript('innerWidth <= 440'));
    assert.equal(await frame.executeJavaScript('typeof window.elevenex'), 'undefined');
    assert.equal(await capture.evaluate(() => document.querySelector('ex-app-shell .main').hasAttribute('inert')), false);
    await capture.cdp('Emulation.setFocusEmulationEnabled', { enabled: true });
    const press = async (key, code, vk, modifiers = 0) => { for (const type of ['keyDown', 'keyUp']) await capture.cdp('Input.dispatchKeyEvent', { type, key, code, windowsVirtualKeyCode: vk, modifiers }); };
    const waitNative = async expression => { try { await waitMain(() => frame.executeJavaScript(expression), expression); } catch (error) { console.log('COMPACT_NATIVE_STATE', await frame.executeJavaScript('JSON.stringify({text:document.body.innerText.slice(-1800),inputs:[...document.querySelectorAll(".quick-input-widget input")].map(e=>({value:e.value,rect:e.getBoundingClientRect().toJSON()}))})')); throw error; } };
    const typeQuery = async text => { await press('a', 'KeyA', 65, process.platform === 'darwin' ? 4 : 2); await capture.cdp('Input.insertText', { text }); };
    for (const theme of ['light', 'dark']) {
      await capture.theme(theme);
      await waitNative(`!!document.querySelector('.monaco-workbench.${theme === 'light' ? 'vs' : 'vs-dark'}')`);
      await waitNative('(document.querySelector(".part.sidebar")?.getBoundingClientRect().width ?? 0) === 0');
      yield { name: `${theme}-compact-editing`, inspect: ['ex-code-panel', 'ex-workspace-panels .panel-head', 'ex-code-panel .editor-surface', 'ex-app-shell .main'] };
      await capture.evaluate(() => document.querySelector('ex-workspace-panels .save-file button').focus());
      await capture.waitFor(() => document.querySelector('[role="tooltip"]')?.textContent.includes(window.elevenex.platform === 'darwin' ? 'Save file · ⌘S' : 'Save file · Ctrl+S'));
      yield { name: `${theme}-save-icon-focus`, inspect: ['ex-workspace-panels .save-file button', '[role="tooltip"]'] };
      await capture.click('ex-workspace-panels .find-file');
      await waitNative('!!document.activeElement?.closest(".quick-input-widget")');
      await typeQuery('README');
      await waitNative('document.querySelector(".quick-input-list")?.textContent.includes("README.md")');
      yield { name: `${theme}-compact-find-file`, inspect: ['ex-code-panel .editor-surface'] };
      await press('Escape', 'Escape', 27);
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
      // Dirty text survives both layout directions; explicit toolbar Save reaches disk.
      assert.equal((await capture.evaluate(target => window.elevenex.codeOpenFile(target, { path: 'src/workspace.ts', line: 10000000, column: 10000000 }), target)).ok, true);
      await capture.evaluate(target => window.elevenex.codeFocus(target), target);
      await waitNative('document.activeElement === document.querySelector(".monaco-editor textarea.inputarea")');
      await capture.cdp('Input.insertText', { text: '// compact panel save verification\n' });
      await waitNative('!!document.querySelector(".tab.dirty")');
      await capture.click('ex-workspace-panels [aria-label="Expand side panel"]'); await finish();
      await waitNative('(document.querySelector(".part.sidebar")?.getBoundingClientRect().width ?? 0) > 0');
      assert.equal(capture.window.webContents.mainFrame.frames.find(child => child.url === frame.url), frame);
      await capture.click('ex-workspace-panels [role="tab"][aria-label="Browser"]'); await finish();
      await capture.click('ex-workspace-panels [role="tab"][aria-label="Code"]'); await finish();
      assert.equal(capture.window.webContents.mainFrame.frames.find(child => child.url === frame.url), frame);
      assert.equal(await frame.executeJavaScript('!!document.querySelector(".tab.dirty")'), true);
      yield { name: 'expanded-retained-dirty-file', inspect: ['ex-code-panel .editor-surface'] };
      await capture.click('ex-workspace-panels [aria-label="Return to chat"]'); await finish();
      await waitNative('(document.querySelector(".part.sidebar")?.getBoundingClientRect().width ?? 0) === 0');
      assert.equal(await frame.executeJavaScript('!!document.querySelector(".tab.dirty")'), true);
      await capture.click('ex-workspace-panels .save-file');
      await waitMain(async () => (await readFile(path, 'utf8')) === original + '// compact panel save verification\n', 'Toolbar Save did not reach the actual task');
      await waitNative('!document.querySelector(".tab.dirty")');
      yield { name: 'compact-save-confirmed', inspect: ['ex-workspace-panels .panel-head', 'ex-code-panel .editor-surface'] };
    } finally { await writeFile(path, original); }
    await capture.viewport(700, 600); await capture.reducedMotion(true); await finish();
    await capture.waitFor(() => document.querySelector('ex-code-frame iframe')?.getBoundingClientRect().width >= 320);
    yield { name: 'narrow-reduced-motion', inspect: ['ex-code-panel', 'ex-workspace-panels .panel-head', 'ex-code-panel .editor-surface'] };
    await capture.click('ex-workspace-panels [aria-label="Close side panel"]'); await finish();
    assert.equal(await capture.evaluate(() => document.querySelector('ex-code-frame iframe')?.checkVisibility() ?? false), false);
    yield { name: 'closed-panel-focus', inspect: ['ex-app-shell .panel'] };
  } finally { Object.assign(BackendManager.prototype, previous); }
}
