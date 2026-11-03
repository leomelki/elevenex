// Production main/preload/router + a real disposable backend/task. Start that
// backend and supply the normal development backend directory before running.
const { app, BrowserWindow } = require('electron');
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
// Optional disposable backend adapter; production still owns its scoped client.
if (process.env.ELEVENEX_CODE_CAPTURE_ORIGIN) {
  const { BackendManager } = require('../dist/backend/manager');
  const version = process.env.ELEVENEX_CODE_TEST_BACKEND_SHA;
  const ready = {phase:'ready',version,url:process.env.ELEVENEX_CODE_CAPTURE_ORIGIN};
  BackendManager.prototype.snapshot = () => ready;
  BackendManager.prototype.start = async () => ready;
  BackendManager.prototype.codeAccess = () => process.env.ELEVENEX_CODE_CAPTURE_ACCESS;
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
  await parent.webContents.executeJavaScript(`{const frame=document.createElement('iframe');frame.src=${JSON.stringify(opened.value.frameUrl)};frame.sandbox='allow-scripts allow-same-origin';frame.style.width='1000px';frame.style.height='700px';document.body.append(frame);}`);
  const original = await wait(() => parent.webContents.mainFrame.frames.find(frame => frame.url === opened.value.frameUrl), 'Source iframe missing');
  assert.equal((await parent.webContents.executeJavaScript(`window.elevenex.codeOpenFile(${JSON.stringify(target)},{path:"src/workspace.ts",line:7})`)).ok,true);
  await wait(() => original.executeJavaScript('!!document.querySelector("textarea.inputarea")'), 'Source file missing');
  const path = join(workspace, 'src/workspace.ts');
  const previousContent = await readFile(path, 'utf8');
  await original.executeJavaScript("import('/assets/out/vs/workbench/workbench.web.main.internal.js').then(({commands})=>commands.executeCommand('editor.action.selectAll'))");
  await original.executeJavaScript('document.querySelector("textarea.inputarea").focus()');
  parent.webContents.debugger.attach('1.3');
  await parent.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled',{enabled:true});
  await parent.webContents.debugger.sendCommand('Input.insertText',{text:'export const detachedLeaseVerified = true;\n'});
  await wait(()=>original.executeJavaScript('!!document.querySelector(".tab.dirty")'),'Source dirty text missing');
  parent.webContents.debugger.detach();
  await parent.webContents.executeJavaScript(`window.elevenex.codeDetach(${JSON.stringify(target)})`);
  const editor = await wait(() => BrowserWindow.getAllWindows().find(window => window !== parent && window.webContents.getURL().endsWith('/code-window')), 'Dedicated Code window did not load');
  await wait(() => editor.webContents.executeJavaScript('!!document.querySelector("ex-code-panel .editor-surface.loaded")'), 'Dedicated window did not connect');
  const childState = await editor.webContents.executeJavaScript('window.elevenex.backendClientState()');
  assert.notEqual(childState.scope.id, state.scope.id, 'Detached window must own another backend lease');
  const childTarget = { scopeId: childState.scope.id, taskId };
  const file = await editor.webContents.executeJavaScript(`window.elevenex.codeOpenFile(${JSON.stringify(childTarget)},{path:"src/workspace.ts",line:7})`);
  assert.equal(file.ok, true, JSON.stringify(file));
  const frame = await wait(() => editor.webContents.mainFrame.frames.find(frame => frame.url === opened.value.frameUrl), 'Editor iframe is not visible');
  assert.notEqual(frame, original, 'Window handoff must restore a new browsing context');
  await wait(() => frame.executeJavaScript('document.querySelector(".monaco-editor")?.textContent.includes("detachedLeaseVerified") && !!document.querySelector(".tab.dirty")'), 'Unsaved handoff text was not restored');
  assert.equal(await frame.executeJavaScript('typeof window.elevenex'), 'undefined');
  assert.equal(editor.contentView.children.length,0);
  parent.close();
  await wait(() => parent.isDestroyed(), 'Parent did not close');
  assert.equal((await editor.webContents.executeJavaScript('window.elevenex.backendClientState()')).scope.id, childState.scope.id, 'Parent close invalidated detached lease');
  editor.show(); editor.focus();
  await editor.webContents.executeJavaScript(`window.elevenex.codeFocus(${JSON.stringify(childTarget)})`);
  await editor.webContents.executeJavaScript(`window.elevenex.codeAction(${JSON.stringify(childTarget)},'save')`);
  await wait(async () => (await readFile(path, 'utf8')) === 'export const detachedLeaseVerified = true;\n', 'Detached editor could not save after parent close');
  await wait(() => frame.executeJavaScript('!document.querySelector(".tab.dirty")'), 'Save not acknowledged');
  await writeFile('artifacts/code-window-live.png', (await editor.webContents.capturePage()).toPNG());
  await writeFile(path, previousContent);
  clearTimeout(deadline);
  console.log('CODE_WINDOW_PRODUCTION_SMOKE_PASSED');
  editor.close(); app.quit();
}).catch(async error => { console.error(error); clearTimeout(deadline); await rm(profile, { recursive: true, force: true }).catch(() => {}); app.exit(1); });
