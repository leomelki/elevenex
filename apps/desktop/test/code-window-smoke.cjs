// Production main/preload/router + a real disposable backend/task. Start that
// backend and supply the normal development backend directory before running.
const { app, BrowserWindow, webContents } = require('electron');
const assert = require('node:assert/strict');
const { mkdtempSync } = require('node:fs');
const { cp, mkdir, readFile, writeFile, rm } = require('node:fs/promises');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const profile = mkdtempSync(join(tmpdir(), 'code-window-live-'));
app.setPath('appData', profile);
const cache = process.env.ELEVENEX_CODE_SMOKE_CACHE;
const workspace = process.env.ELEVENEX_CODE_TEST_WORKSPACE;
const taskId = Number(process.env.ELEVENEX_CODE_TEST_TASK_ID);
if (!cache || !workspace || !Number.isSafeInteger(taskId) || taskId < 1) throw new Error('Set ELEVENEX_CODE_SMOKE_CACHE (the verified runtime cache root), ELEVENEX_CODE_TEST_WORKSPACE and ELEVENEX_CODE_TEST_TASK_ID for a disposable task.');
const deadline = setTimeout(() => { console.error('Production Code window deadline'); app.exit(1); }, 120_000);
async function wait(check, message, ms = 30_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { try { const result = await check(); if (result) return result; } catch { /* await live state */ } await new Promise(resolve => setTimeout(resolve, 40)); }
  throw new Error(message);
}
require('../dist/main');
app.whenReady().then(async () => {
  await mkdir(join(app.getPath('userData'), 'code-runtimes'), { recursive: true });
  await cp(join(cache, '1.144.0'), join(app.getPath('userData'), 'code-runtimes/1.144.0'), { recursive: true });
  const parent = await wait(() => BrowserWindow.getAllWindows().find(window => window.webContents.getURL().startsWith('app://')), 'Workspace did not open');
  await wait(() => parent.webContents.executeJavaScript('typeof window.elevenex === "object"'), 'Real preload missing');
  await parent.webContents.executeJavaScript('window.elevenex.selectEnvironment({kind:"local"})');
  const state = await wait(() => parent.webContents.executeJavaScript('window.elevenex.backendClientState().then(state=>state.scope?state:null)'), 'Backend not ready');
  const target = { scopeId: state.scope.id, taskId };
  const opened = await parent.webContents.executeJavaScript(`window.elevenex.codeOpen(${JSON.stringify(target)})`);
  assert.equal(opened.ok, true, JSON.stringify(opened));
  const original = webContents.getAllWebContents().find(contents => contents.getURL().includes('code.elevenex.invalid'));
  assert.ok(original);
  await parent.webContents.executeJavaScript(`window.elevenex.codeDetach(${JSON.stringify(target)})`);
  const editor = await wait(() => BrowserWindow.getAllWindows().find(window => window !== parent && window.webContents.getURL().endsWith('/code-window')), 'Dedicated Code window did not load');
  await wait(() => editor.webContents.executeJavaScript('!!document.querySelector("ex-code-panel .editor-surface.loaded")'), 'Dedicated window did not connect');
  const childState = await editor.webContents.executeJavaScript('window.elevenex.backendClientState()');
  assert.notEqual(childState.scope.id, state.scope.id, 'Detached window must own another backend lease');
  const childTarget = { scopeId: childState.scope.id, taskId };
  const file = await editor.webContents.executeJavaScript(`window.elevenex.codeOpenFile(${JSON.stringify(childTarget)},{path:"src/workspace.ts",line:7})`);
  assert.equal(file.ok, true, JSON.stringify(file));
  const surface = await wait(() => editor.contentView.children.find(view => view.webContents?.getURL().includes('code.elevenex.invalid') && view.getVisible()), 'Native editor is not visible');
  assert.equal(surface.webContents.id, original.id, 'Detaching duplicated the workbench');
  assert.equal(await surface.webContents.executeJavaScript('typeof window.elevenex'), 'undefined');
  parent.close();
  await wait(() => parent.isDestroyed(), 'Parent did not close');
  assert.equal((await editor.webContents.executeJavaScript('window.elevenex.backendClientState()')).scope.id, childState.scope.id, 'Parent close invalidated detached lease');
  editor.show(); editor.focus(); surface.webContents.focus();
  await wait(() => surface.webContents.executeJavaScript('!!document.querySelector("textarea.inputarea")'), 'Actual editor input missing');
  await surface.webContents.executeJavaScript('document.querySelector("textarea.inputarea").focus()');
  surface.webContents.debugger.attach('1.3');
  await surface.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
  const key = async key => { for (const type of ['keyDown', 'keyUp']) await surface.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type, key, code: 'Key' + key.toUpperCase(), windowsVirtualKeyCode: key.toUpperCase().charCodeAt(0), modifiers: process.platform === 'darwin' ? 4 : 2 }); };
  const path = join(workspace, 'src/workspace.ts');
  const previousContent = await readFile(path, 'utf8');
  await key('a'); await surface.webContents.debugger.sendCommand('Input.insertText', { text: 'export const detachedLeaseVerified = true;\n' }); await key('s');
  await wait(async () => (await readFile(path, 'utf8')) === 'export const detachedLeaseVerified = true;\n', 'Detached editor could not save after parent close');
  await wait(() => surface.webContents.executeJavaScript('!document.querySelector(".tab.dirty")'), 'Save not acknowledged');
  await writeFile('artifacts/code-window-live.png', (await editor.webContents.capturePage()).toPNG());
  await writeFile('artifacts/code-window-workbench-live.png', (await surface.webContents.capturePage()).toPNG());
  await writeFile(path, previousContent);
  surface.webContents.debugger.detach(); clearTimeout(deadline);
  console.log('CODE_WINDOW_PRODUCTION_SMOKE_PASSED');
  editor.close(); app.quit();
}).catch(async error => { console.error(error); clearTimeout(deadline); await rm(profile, { recursive: true, force: true }).catch(() => {}); app.exit(1); });
