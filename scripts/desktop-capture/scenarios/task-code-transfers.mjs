import assert from 'node:assert/strict';
import { app, dialog } from 'electron';
import { cp, mkdir, mkdtemp, lstat, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

// Real production renderer, Code OSS extension and disposable Nest task. Only
// native picker responses are deterministic; no capture hooks enter the app.
export default async function* (capture) {
  const origin = process.env.ELEVENEX_CODE_CAPTURE_ORIGIN;
  const token = process.env.ELEVENEX_CODE_CAPTURE_ACCESS;
  const projectId = Number(process.env.ELEVENEX_CODE_CAPTURE_PROJECT);
  const taskId = Number(process.env.ELEVENEX_CODE_CAPTURE_TASK);
  const sessionId = Number(process.env.ELEVENEX_CODE_CAPTURE_SESSION);
  const workspace = process.env.ELEVENEX_CODE_TEST_WORKSPACE;
  assert.ok(origin && token && projectId && taskId && sessionId && workspace);
  for (const name of ['upload.bin','assets']) assert.equal(await lstat(join(workspace,name)).then(()=>true,error=>{if(error.code === 'ENOENT')return false;throw error;}),false,'Capture requires unused fixture names in a disposable task.');
  const metadata = await fetch(origin + '/api/info').then(response => response.json());
  const ready = { phase: 'ready', version: metadata.backendSha, url: origin };
  const { BackendManager } = require('../../../apps/desktop/dist/backend/manager.js');
  const previous = { snapshot: BackendManager.prototype.snapshot, start: BackendManager.prototype.start, codeAccess: BackendManager.prototype.codeAccess, open: dialog.showOpenDialog, save: dialog.showSaveDialog, message: dialog.showMessageBox };
  BackendManager.prototype.snapshot = () => ready;
  BackendManager.prototype.start = async () => ready;
  BackendManager.prototype.codeAccess = () => token;
  const ipc = require('../../../apps/desktop/dist/ipc.js'), broadcast = ipc.broadcast;
  ipc.broadcast = (channel, value) => broadcast(channel, channel === 'backend:changed' ? ready : value);
  ipc.broadcast('backend:changed', ready);
  const local = await mkdtemp(join(tmpdir(), 'code-transfer-capture-'));
  const bytes = Buffer.alloc(9 * 1024 * 1024 + 7, 173);
  const source = join(local, 'upload.bin'), folder = join(local, 'assets'), target = join(local, 'download.bin');
  await writeFile(source, bytes); await mkdir(folder); await mkdir(join(folder, 'empty')); await writeFile(join(folder, 'note.txt'), 'Folder upload works.\n');
  let picker = 'files', picks = 0;
  dialog.showOpenDialog = async (_window, options) => {
    picks++;
    assert.ok(options.properties.includes(picker === 'folder' ? 'openDirectory' : 'openFile'));
    return { canceled: picker === 'cancel', filePaths: picker === 'folder' ? [folder] : [source] };
  };
  dialog.showSaveDialog = async () => ({ canceled: false, filePath: target });
  dialog.showMessageBox = async () => ({ response: 1 }); // Skip existing files.
  try {
    await cp(join(process.env.ELEVENEX_CODE_SMOKE_CACHE, '1.144.0'), join(app.getPath('userData'), 'code-runtimes/1.144.0'), { recursive: true });
    const finish = async () => { await capture.settle(); await capture.waitFor(() => document.getAnimations().every(animation => !Number.isFinite(animation.effect?.getComputedTiming().endTime) || animation.playState !== 'running')); await capture.settle(); };
    await capture.viewport(1440, 900); await capture.cdp('Emulation.setFocusEmulationEnabled', { enabled: true });
    await capture.waitFor(() => document.querySelector('button[data-machine="local"]'));
    await capture.evaluate(() => window.elevenex.selectEnvironment({ kind: 'local' }));
    await capture.waitFor(async () => !!(await window.elevenex.backendClientState()).scope);
    await capture.evaluate(() => window.elevenex.markMachineOpened({ kind: 'local' }));
    await capture.click('button[data-machine="local"]'); await finish();
    await capture.waitFor(id => document.querySelector(`[data-project-id="${id}"]`), projectId);
    await capture.click(`[data-project-id="${projectId}"]`); await finish();
    await capture.waitFor(id => document.querySelector(`[data-task-id="${id}"]`), taskId);
    if (await capture.evaluate(id => document.querySelector(`[data-task-id="${id}"] button.toggle`)?.getAttribute('aria-expanded') === 'false', taskId)) await capture.click(`[data-task-id="${taskId}"] button.toggle`);
    await capture.waitFor(id => document.querySelector(`[data-session-id="${id}"] button.select`), sessionId);
    await capture.click(`[data-session-id="${sessionId}"] button.select`); await finish();
    await capture.click('ex-workspace-task-header [aria-label="Toggle side panel"]'); await finish();
    await capture.click('ex-workspace-panels [role="tab"][aria-label="Code"]'); await finish();
    await capture.waitFor(() => document.querySelector('ex-workspace-panels .browse-files'));
    const frame = capture.window.webContents.mainFrame.frames.find(item => item.url.includes('code.elevenex.invalid'));
    assert.ok(frame);
    const wait = async expression => {
      const deadline = Date.now() + 30000;
      while (!await frame.executeJavaScript(expression)) { if (Date.now() > deadline) { console.log('TRANSFER_DIAGNOSTICS', picks, await frame.executeJavaScript('JSON.stringify({text:document.body.innerText.slice(-2500),active:document.activeElement?.outerHTML.slice(0,300),notifications:[...document.querySelectorAll(".notification-list-item")].map(e=>e.textContent)})')); throw new Error('Code condition failed: ' + expression); }; await new Promise(resolve => setTimeout(resolve, 50)); }
    };
    const press = async (key, code, windowsVirtualKeyCode, modifiers = 0) => {
      for (const type of ['keyDown', 'keyUp']) await capture.cdp('Input.dispatchKeyEvent', { type, key, code, windowsVirtualKeyCode, modifiers });
    };
    const click = async (selector, right = false, label = '') => {
      await frame.executeJavaScript('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
      const point = await frame.executeJavaScript(`(() => { const e=[...document.querySelectorAll(${JSON.stringify(selector)})].find(item => item.getBoundingClientRect().width > 0 && (!${JSON.stringify(label)} || item.textContent.trim().startsWith(${JSON.stringify(label)})));  if(!e)throw Error('Missing control'); const r=e.getBoundingClientRect(); if(!r.width || !r.height)throw Error('Control is hidden'); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`);
      const host = await capture.evaluate(() => document.querySelector('ex-code-panel iframe').getBoundingClientRect().toJSON());
      for (const type of ['mousePressed', 'mouseReleased']) await capture.cdp('Input.dispatchMouseEvent', { type, x: host.x + point.x, y: host.y + point.y, button: right ? 'right' : 'left', clickCount: 1 });
    };
    const chooseMenu = async label => {
      await press('Home','Home',36);
      for(let index=0;index<30;index++){
        if(await frame.executeJavaScript(`document.activeElement?.textContent.trim().startsWith(${JSON.stringify(label)})`)){await press('Enter','Enter',13);return;}
        await press('ArrowDown','ArrowDown',40);
      }
      throw Error('Keyboard menu selection failed: '+label);
    };
    const palette = async title => {
      await press('p', 'KeyP', 80, process.platform === 'darwin' ? 12 : 10);
      await wait('!!document.querySelector(".quick-input-widget input")?.offsetWidth');
      await press('a','KeyA',65,process.platform === 'darwin' ? 4 : 2);
      await capture.cdp('Input.insertText', { text: '>'+title });
      await wait(`document.querySelector('.quick-input-list')?.textContent.includes(${JSON.stringify(title)})`);
      await press('Enter','Enter',13);
    };
    const waitDisk = async (path, expected) => { const deadline=Date.now()+30000; for (;;) { try { if((await readFile(path)).equals(expected))return; } catch { /* Wait for atomic publication. */ } if(Date.now()>deadline){console.log('PUBLICATION_WAIT_STATE',await frame.executeJavaScript('document.body.innerText.slice(-2000)'));throw Error('Transferred file not published');} await new Promise(resolve=>setTimeout(resolve,50)); } };
    const complete = text => wait(`document.body.innerText.includes(${JSON.stringify(text)})`);
    await wait('!!document.querySelector(".part.auxiliarybar .codicon-cloud-upload")');
    await wait('document.body.innerText.includes("Task connected")');
    for (const theme of ['light','dark']) {
      await capture.theme(theme); await new Promise(resolve => setTimeout(resolve, 400));
      await click('.part.auxiliarybar .codicon-cloud-upload');
      await new Promise(resolve => setTimeout(resolve, 500));
      yield {name:`${theme}-upload-start`,inspect:['ex-code-panel','iframe']};
      await waitDisk(join(workspace,'upload.bin'),bytes);
      await complete('Upload complete: 1 file.');
      assert.deepEqual(await readFile(join(workspace, 'upload.bin')), bytes);
      yield { name: `${theme}-upload-complete`, inspect: ['ex-code-panel','iframe'] };
      // Exact context menu contributed by the extension, selected via real input.
      await click('.part.auxiliarybar .monaco-list-row[aria-label*="upload.bin"]', true);
      await wait('document.body.innerText.includes("Upload Folder") && document.body.innerText.includes("Download")');
      yield { name: `${theme}-explorer-transfer-menu`, inspect: ['ex-code-panel','iframe'] };
      await click('.context-view .action-label', false, 'Download');
      await waitDisk(target,bytes);
      await complete('Download complete: 1 file.');
      assert.deepEqual(await readFile(target), bytes);
      yield { name: `${theme}-download-complete`, inspect: ['ex-code-panel','iframe'] };
      await rm(join(workspace,'upload.bin')); await rm(target);
      await new Promise(resolve => setTimeout(resolve,600));
    }
    picker = 'folder';
    await palette('Task: Upload Folder'); await waitDisk(join(workspace,'assets/note.txt'),Buffer.from('Folder upload works.\n')); await complete('Upload complete: 1 file.');
    assert.equal(await readFile(join(workspace,'assets/note.txt'),'utf8'),'Folder upload works.\n');
    assert.ok((await (await import('node:fs/promises')).stat(join(workspace,'assets/empty'))).isDirectory());
    await wait(`!!document.querySelector('.part.auxiliarybar .monaco-list-row[aria-label="assets"]')`);
    await wait('!document.body.innerText.includes("Uploading to task")');
    await click('.part.auxiliarybar .monaco-list-row[aria-label="assets"]',true);
    await wait(`[...document.querySelectorAll('.context-view .action-label')].some(item=>item.getBoundingClientRect().width>0 && item.textContent.trim().startsWith('Download'))`);
    yield {name:'folder-transfer-menu',inspect:['ex-code-panel','iframe']};
    picker='files';
    await click('.context-view .action-label',false,'Upload');
    await waitDisk(join(workspace,'assets/upload.bin'),bytes);
    await wait('!document.body.innerText.includes("Uploading to task")');
    await click('.part.auxiliarybar .monaco-list-row[aria-label="assets"]',true);
    await wait('document.body.innerText.includes("Download")');
    await chooseMenu('Download');
    await waitDisk(join(target,'note.txt'),Buffer.from('Folder upload works.\n'));
    assert.ok((await (await import('node:fs/promises')).stat(join(target,'empty'))).isDirectory());
    await waitDisk(join(target,'upload.bin'),bytes);
    await complete('Download complete: 2 files.');
    await wait(`(()=>{const item=document.querySelector('.part.auxiliarybar .codicon-cloud-upload')?.closest('.action-item');return item && !item.matches('.disabled,[aria-disabled="true"]') && !item.querySelector('.disabled,[aria-disabled="true"]');})()`);
    picker = 'cancel';
    await click('.part.auxiliarybar .codicon-cloud-upload'); await complete('Transfer cancelled: 0 files.');
    await capture.viewport(840,680); await capture.reducedMotion(true);
    yield {name:'narrow-reduced-motion-transfers',inspect:['ex-code-panel','iframe']};
    assert.equal(picks,5);
    yield {name:'folder-download-and-cancel-complete',inspect:['ex-code-panel','iframe']};
  } finally {
    BackendManager.prototype.snapshot = previous.snapshot; BackendManager.prototype.start = previous.start; BackendManager.prototype.codeAccess = previous.codeAccess;
    ipc.broadcast = broadcast; dialog.showOpenDialog = previous.open; dialog.showSaveDialog = previous.save; dialog.showMessageBox = previous.message;
    await rm(local,{recursive:true,force:true});
    await rm(join(workspace,'upload.bin'),{force:true}); await rm(join(workspace,'assets'),{recursive:true,force:true});
  }
}
