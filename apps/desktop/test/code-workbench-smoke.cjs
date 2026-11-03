// Real Code OSS + sandboxed native surface + new backend file/search modules.
// Run after backend/desktop builds with the installed Electron. No product test hooks.
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const { mkdtemp, mkdir, writeFile, readFile, realpath, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { BackendClient } = require('../dist/backend-client/client');
const { CodeSurfaces } = require('../dist/code/surfaces');
const { CodeArtifact } = require('../dist/code/artifact');
const files = require('../../backend/dist/code-workspace/code-files');
const { CodeSearch } = require('../../backend/dist/code-workspace/code-search.service');
const { CodeWatch } = require('../../backend/dist/code-workspace/code-watch.service');
const execute = promisify(execFile);
const deadline = setTimeout(() => { console.error('Code workbench smoke deadline'); app.exit(1); }, 180_000);
let root, server, code, search, watches, currentView;
async function wait(predicate, message, timeout = 30_000) {
  const start = Date.now();
  while (Date.now() - start < timeout) { try { const result = await predicate(); if (result) return result; } catch { /* Wait for real state. */ } await new Promise(r => setTimeout(r, 100)); }
  throw new Error(message);
}
app.whenReady().then(async () => {
  root = await mkdtemp(join(tmpdir(), 'elevenex-new-code-'));
  await mkdir(join(root, 'profile')); app.setPath('userData', join(root, 'profile'));
  const repository = join(root, 'repository'), worktree = join(root, 'task');
  await mkdir(repository); await execute('git', ['init', '-b', 'main', repository]);
  const large = process.argv.includes('--large');
  if (large) { for (let folder = 0; folder < 120; folder++) { const path = join(repository, `group-${folder}`); await mkdir(path); await Promise.all(Array.from({ length: 100 }, (_, index) => writeFile(join(path, `module-${folder * 100 + index}.ts`), `export const needle${folder * 100 + index} = ${folder * 100 + index};\n`))); } }
  await writeFile(join(repository, 'hello.ts'), 'export const message = "hello workbench";\n');
  await execute('git', ['-C', repository, 'add', '.']);
  await execute('git', ['-C', repository, '-c', 'user.name=Code test', '-c', 'user.email=code@example.invalid', 'commit', '-m', 'fixture']);
  await execute('git', ['-C', repository, 'worktree', 'add', '-b', 'code-smoke', worktree]);
  const workspace = { taskId: 1, identity: 'a'.repeat(64), storageIdentity: 'c'.repeat(64), root: await realpath(worktree), name: 'Code workbench smoke', branch: 'code-smoke' };
  search = new CodeSearch(); watches = new CodeWatch(search);
  server = createServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json');
    try {
      if (request.method === 'GET') { response.end(JSON.stringify({ version: 1, ...workspace, root: undefined })); return; }
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const input = JSON.parse(Buffer.concat(chunks).toString());
      assert.equal(input.identity, workspace.identity);
      const op = request.url.split('/').at(-1);
      let value;
      if (op === 'read') value = await files.codeRead(workspace, input.path);
      else if (op === 'stat') value = await files.codeStat(workspace, input.path);
      else if (op === 'directory') value = await files.codeDirectory(workspace, input.path, input.after);
      else if (op === 'write') value = await files.codeWrite(workspace, input, async () => {});
      else if (op === 'mkdir') value = await files.codeMkdir(workspace, input.path);
      else if (op === 'rename') value = await files.codeRename(workspace, input);
      else if (op === 'delete') value = await files.codeDelete(workspace, input);
      else if (op === 'filenames') value = await search.filenames(workspace, input);
      else if (op === 'search') value = await search.start(workspace, input);
      else if (op === 'search-page') value = await search.page(workspace, input.id);
      else if (op === 'search-cancel') { search.cancel(workspace, input.id); value = { accepted: true }; }
      else if (op === 'changes') value = watches.changes(workspace, input.after);
      else throw new Error('Unsupported operation ' + op);
      if (op === 'read' && input.path === '/hello.ts') console.log('FILE_READ_CONFIRMED', value.revision);
      if (op === 'write') console.log('FILE_WRITE', input.path, value);
      response.end(JSON.stringify(value));
    } catch (error) { response.statusCode = error.getStatus?.() ?? (error.code === 'ENOENT' ? 404 : 500); response.end(JSON.stringify(error.getResponse?.() ?? { error: error.message })); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const window = new BrowserWindow({ width: 1250, height: 900, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  await window.loadURL('data:text/html,<html><body>Native Code verification</body></html>'); window.show();
  const client = new BackendClient(() => ({ url: `http://127.0.0.1:${server.address().port}`, version: 'b'.repeat(40), headers: {}, identity: 'smoke', environment: { kind: 'local' } }), () => {});
  client.attach(window.webContents.id);
  const target = { scopeId: client.state(window.webContents.id).scope.id, taskId: 1 };
  const runtimeRoot = process.argv.includes('--cold-install') ? join(root, 'runtimes') : process.env.ELEVENEX_CODE_SMOKE_CACHE || join(root, 'runtimes');
  const metrics = { environment: { platform: process.platform, arch: process.arch, versions: process.versions, cpu: require('node:os').cpus()[0].model }, files: large ? 12001 : 1 };
  const started = performance.now();
  await new CodeArtifact(runtimeRoot).prepare();
  metrics.artifactCache = process.argv.includes('--cold-install') ? 'cold' : 'warm'; metrics.artifactInstallMs = Math.round(performance.now() - started); console.log('Artifact prepared ms:', metrics.artifactInstallMs);
  let codeState;
  code = new CodeSurfaces(client, runtimeRoot, join(process.cwd(), 'apps/renderer/public/fonts'), (_id, _target, state) => { codeState = state; console.log('CODE_STATE', state.phase, state.message); });
  const opened = await code.open(window.webContents.id, target); assert.equal(opened.ok, true, JSON.stringify(opened));
  code.layout(window.webContents.id, target, { x: 60, y: 60, width: 1100, height: 780 });
  const view = window.contentView.children[0]; currentView = view; assert.ok(view);
  view.webContents.on('console-message', event => console.log('WORKBENCH', event.level, event.message));
  view.webContents.on('did-fail-load', (_event, ...details) => console.error('WORKBENCH_LOAD', ...details));
  await wait(() => view.webContents.executeJavaScript('!!document.querySelector(".monaco-workbench")'), 'Genuine workbench did not mount');
  view.webContents.session.webRequest.onErrorOccurred(details => console.log('FAILED_RESOURCE', details.url, details.error));
  assert.equal(await view.webContents.executeJavaScript('typeof window.elevenex'), 'undefined');
  assert.equal(await view.webContents.executeJavaScript('typeof require'), 'undefined');
  assert.equal((await code.openFile(window.webContents.id, target, { path: 'hello.ts', line: 1 })).ok, true);
  await wait(() => view.webContents.executeJavaScript('!!document.querySelector(".monaco-editor") && !!document.querySelector(".tab[aria-label*=hello], .tab[title*=hello]")'), 'File did not open', 45_000);
  metrics.usableFileMs = Math.round(performance.now() - started); console.log('Usable file ms:', metrics.usableFileMs);
  // Real keyboard commands into the native VS Code editor.
  window.focus(); view.webContents.focus();
  await view.webContents.executeJavaScript("import('/assets/out/vs/workbench/workbench.web.main.internal.js').then(({commands}) => commands.executeCommand('workbench.action.focusActiveEditorGroup'))");
  console.log('EDITOR_LAYOUT', await view.webContents.executeJavaScript('JSON.stringify({size:[innerWidth,innerHeight],editor:document.querySelector(".monaco-editor")?.getBoundingClientRect().toJSON(),inputs:[...document.querySelectorAll("textarea,[contenteditable=true]")].map(e=>e.outerHTML.slice(0,180))})'));
  await view.webContents.executeJavaScript('document.querySelector(".monaco-editor textarea.inputarea").focus()');
  view.webContents.debugger.attach('1.3');
  await view.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', {enabled:true});
  const modifier = process.platform === 'darwin' ? 4 : 2;
  const key = async key => { const code = 'Key' + key.toUpperCase(), windowsVirtualKeyCode = key.toUpperCase().charCodeAt(0); await view.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode, modifiers: modifier }); await view.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode, modifiers: modifier }); };
  await view.webContents.executeJavaScript("import('/assets/out/vs/workbench/workbench.web.main.internal.js').then(({commands}) => commands.executeCommand('editor.action.selectAll'))"); await view.webContents.debugger.sendCommand('Input.insertText', { text: 'export const message = "saved through Code OSS";\n' }); await key('s');
  console.log('AFTER_INPUT', await view.webContents.executeJavaScript('JSON.stringify({active:document.activeElement?.className,dirty:!!document.querySelector(".tab.dirty"),text:document.querySelector(".monaco-editor")?.innerText})')); 
  await wait(async () => (await readFile(join(worktree, 'hello.ts'), 'utf8')) === 'export const message = "saved through Code OSS";\n', 'Real editor save did not reach task files');
  const reopenStarted = performance.now();
  code.release(window.webContents.id, target); await code.open(window.webContents.id, target);
  code.layout(window.webContents.id, target, { x: 60, y: 60, width: 1100, height: 780 });
  metrics.reopenMs = Math.round(performance.now() - reopenStarted);
  assert.equal(window.contentView.children[0], view, 'Reopen duplicated the workbench');
  // Dirty backup recovery uses upstream hot-exit storage, without a second workbench.
  await view.webContents.executeJavaScript("import('/assets/out/vs/workbench/workbench.web.main.internal.js').then(({commands}) => commands.executeCommand('editor.action.selectAll'))"); await view.webContents.debugger.sendCommand('Input.insertText', { text: 'export const recoveredFromCrash = true;\n' });
  await wait(() => view.webContents.executeJavaScript('!!document.querySelector(".tab.dirty")'), 'Dirty editor state missing');
  // VS Code debounces browser backups; allow its supported hot-exit mechanism to settle.
  await new Promise(resolve => setTimeout(resolve, 2500));
  view.webContents.debugger.detach();
  view.webContents.forcefullyCrashRenderer();
  await wait(() => codeState?.phase === 'failed', 'Crash was not reported');
  const restartAt = performance.now();
  assert.equal((await code.open(window.webContents.id, target)).ok, true);
  code.layout(window.webContents.id, target, { x: 60, y: 60, width: 1100, height: 780 });
  await wait(() => view.webContents.executeJavaScript('document.querySelector(".monaco-editor")?.textContent.includes("recoveredFromCrash")'), 'Unsaved hot-exit buffer was not restored', 45_000);
  metrics.crashRecoveryMs = Math.round(performance.now() - restartAt);
  assert.equal(window.contentView.children[0], view, 'Crash recovery duplicated the workbench');
  view.webContents.debugger.attach('1.3');
  await view.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', {enabled:true});
  await view.webContents.executeJavaScript('document.querySelector(".monaco-editor textarea.inputarea").focus()');
  await key('s');
  await wait(async () => (await readFile(join(worktree, 'hello.ts'), 'utf8')) === 'export const recoveredFromCrash = true;\n', 'Recovered edits did not save');
  await new Promise(resolve => setTimeout(resolve, 250));
  await view.webContents.capturePage().then(image => writeFile(join(process.cwd(), 'artifacts/code-workbench-smoke.png'), image.toPNG()));
  console.log('EDITOR_DOM', await view.webContents.executeJavaScript('document.body.innerText.slice(-2000)'));
  const benchmarkSearch = new CodeSearch();
  let at = performance.now(); await benchmarkSearch.filenames(workspace, { query: large ? 'module-11999' : 'hello' }); metrics.filenameColdMs = Math.round(performance.now() - at);
  at = performance.now(); await benchmarkSearch.filenames(workspace, { query: large ? 'module-11998' : 'hello' }); metrics.filenameWarmMs = Math.round(performance.now() - at);
  at = performance.now(); const firstPage = await benchmarkSearch.start(workspace, { query: 'export', limit: 2000 }); metrics.textFirstPageMs = Math.round(performance.now() - at); metrics.textFirstPageResults = firstPage.rows.length;
  benchmarkSearch.cancel(workspace, firstPage.id); benchmarkSearch.onModuleDestroy();
  metrics.processes = app.getAppMetrics().map(({ type, memory }) => ({ type, memory }));
  await writeFile(join(process.cwd(), 'artifacts/code-workbench-metrics.json'), JSON.stringify(metrics, null, 2));
  console.log('METRICS', JSON.stringify(metrics));
  view.webContents.debugger.detach();
  console.log('CODE_WORKBENCH_SMOKE_PASSED');
  client.dispose(); clearTimeout(deadline); await code.dispose(); watches.onModuleDestroy(); search.onModuleDestroy();
  await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
  await rm(root, { recursive: true, force: true }); app.exit(0);
}).catch(async error => { console.error(error); if (currentView && !currentView.webContents.isDestroyed()) { console.log('FAILED_EDITOR_DOM', await currentView.webContents.executeJavaScript('document.body.innerText.slice(-4000)')); await currentView.webContents.capturePage().then(image => writeFile(join(process.cwd(), 'artifacts/code-workbench-failed.png'), image.toPNG())).catch(() => undefined); } clearTimeout(deadline); await code?.dispose(); watches?.onModuleDestroy(); search?.onModuleDestroy(); server?.close(); if (root) await rm(root, { recursive: true, force: true }).catch(() => {}); app.exit(1); });
