// Real Code OSS + sandboxed cross-origin iframe + new backend file/search modules.
// Run after backend/desktop builds with the installed Electron. No product test hooks.
const { app, BrowserWindow, protocol } = require('electron');
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
const { readCodeLink, resolveCodeLink } = require('../../backend/dist/code-workspace/code-links');
const { CodeWatch } = require('../../backend/dist/code-workspace/code-watch.service');
const execute = promisify(execFile);
protocol.registerSchemesAsPrivileged([{scheme:'app',privileges:{standard:true,secure:true,supportFetchAPI:true}}]);
// The test owns shutdown, including asynchronous profile cleanup after its
// window is destroyed. Do not let Electron quit before that cleanup completes.
app.on('window-all-closed', () => {});
const deadline = setTimeout(() => { console.error('Code workbench smoke deadline'); app.exit(1); }, 180_000);
let root, server, code, search, watches, currentView, window, stopRouting;
let rejectWrites = false;
async function wait(predicate, message, timeout = 30_000) {
  const start = Date.now();
  while (Date.now() - start < timeout) { try { const result = await predicate(); if (result) return result; } catch { /* Wait for real state. */ } await new Promise(r => setTimeout(r, 100)); }
  throw new Error(message);
}
app.whenReady().then(async () => {
  root = await mkdtemp(join(tmpdir(), 'elevenex-new-code-'));
  await mkdir(join(root, 'profile')); app.setPath('userData', join(root, 'profile'));
  const repository = join(root, 'repository'), worktree = join(root, 'task');
  await mkdir(repository); await execute('git', ['init', repository]);
  await execute('git', ['-C', repository, 'symbolic-ref', 'HEAD', 'refs/heads/main']);
  const large = process.argv.includes('--large');
  const links = process.argv.includes('--chat-links');
  const htmlPreview = process.argv.includes('--html-preview');
  const linkedFolder = join(root, 'linked-notes'), linkedFile = join(linkedFolder, 'outside.md');
  if (links) {
    await mkdir(join(repository, 'src'));
    await writeFile(join(repository, 'src', 'nested.ts'), 'export const nested = true;');
    await mkdir(linkedFolder);
    await writeFile(linkedFile, '# External notes\nRead-only content\n');
  }
  if (large) { for (let folder = 0; folder < 120; folder++) { const path = join(repository, `group-${folder}`); await mkdir(path); await Promise.all(Array.from({ length: 100 }, (_, index) => writeFile(join(path, `module-${folder * 100 + index}.ts`), `export const needle${folder * 100 + index} = ${folder * 100 + index};\n`))); } }
  await writeFile(join(repository, 'hello.ts'), 'export const message = "hello workbench";\n');
  await writeFile(join(repository, 'README.md'), '# Task Markdown preview\n\n**Formatted text**\n\n![Task diagram](./diagram.svg)\n');
  await writeFile(join(repository, 'diagram.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><rect width="40" height="20" fill="teal"/></svg>');
  if (htmlPreview) {
    await mkdir(join(repository, 'site'));
    await writeFile(join(repository, 'site', 'Preview page.HTML'), `<!doctype html>
<link rel="stylesheet" href="./preview.css">
<h1 style="font-size: 36px">Task HTML preview</h1>
<img src="../diagram.svg" alt="Task diagram">
<a href="./next.htm">Next page</a>
<a id="external" href="https://example.invalid/">External</a>
<div style="height: 3000px"></div>
<script>document.querySelector('h1').textContent = 'Script ran'</script>`);
    await writeFile(join(repository, 'site', 'preview.css'), 'h1 { color: rgb(16, 80, 120); }');
    await writeFile(join(repository, 'site', 'next.htm'), '<h1>Second page</h1>');
  }
  await execute('git', ['-C', repository, 'add', '.']);
  await execute('git', ['-C', repository, '-c', 'user.name=Code test', '-c', 'user.email=code@example.invalid', 'commit', '-m', 'fixture']);
  await execute('git', ['-C', repository, 'worktree', 'add', '-b', 'code-smoke', worktree]);
  const workspace = { taskId: 1, identity: 'a'.repeat(64), storageIdentity: 'c'.repeat(64), root: await realpath(worktree), name: 'Code workbench smoke', branch: 'code-smoke' };
  search = new CodeSearch(); watches = new CodeWatch(search);
  server = createServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json');
    try {
      if (request.method === 'GET') { response.end(JSON.stringify({ version: 1, ...workspace, root: undefined, fileLinks: links })); return; }
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const input = JSON.parse(Buffer.concat(chunks).toString());
      assert.equal(input.identity, workspace.identity);
      const op = request.url.split('/').at(-1);
      let value;
      if (op === 'link-resolve') value = await resolveCodeLink(workspace, input.path);
      else if (op === 'link-directory' || op === 'link-stat' || op === 'link-read') value = await readCodeLink(op, input, new AbortController().signal);
      else if (op === 'read') value = await files.codeRead(workspace, input.path);
      else if (op === 'stat') value = await files.codeStat(workspace, input.path);
      else if (op === 'directory') value = await files.codeDirectory(workspace, input.path, input.after);
      else if (op === 'write') {
        if (rejectWrites) { response.statusCode = 403; response.end(JSON.stringify({ error: 'read-only' })); return; }
        value = await files.codeWrite(workspace, input, async () => {});
      }
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
  window = new BrowserWindow({ width: 1250, height: 900, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  protocol.handle('app', () => new globalThis.Response('<html><body><div id=editor style="height:780px"></div></body></html>', {headers:{'Content-Type':'text/html'}}));
  await window.loadURL('app://elevenex/'); window.show();
  const client = new BackendClient(() => ({ url: `http://127.0.0.1:${server.address().port}`, version: 'b'.repeat(40), headers: {}, identity: 'smoke', environment: { kind: 'local' } }), () => {});
  client.attach(window.webContents.id);
  const target = { scopeId: client.state(window.webContents.id).scope.id, taskId: 1 };
  const runtimeRoot = process.argv.includes('--cold-install') ? join(root, 'runtimes') : process.env.ELEVENEX_CODE_SMOKE_CACHE || join(root, 'runtimes');
  const metrics = { environment: { platform: process.platform, arch: process.arch, versions: process.versions, cpu: require('node:os').cpus()[0].model }, files: large ? 12003 : 3 };
  const started = performance.now();
  await new CodeArtifact(runtimeRoot).prepare();
  metrics.artifactCache = process.argv.includes('--cold-install') ? 'cold' : 'warm'; metrics.artifactInstallMs = Math.round(performance.now() - started); console.log('Artifact prepared ms:', metrics.artifactInstallMs);
  let codeState;
  code = new CodeSurfaces(client, runtimeRoot, join(process.cwd(), 'apps/renderer/public/fonts'), (_id, _target, state) => { codeState = state; console.log('CODE_STATE', state.phase, state.message); });
  window.webContents.on('console-message', event => console.log('FRAME_CONSOLE',event.message));
  window.webContents.on('did-fail-load', (_event,...args)=>console.log('FRAME_LOAD',...args));
  stopRouting = code.attachWindow(window.webContents);
  const opened = await code.open(window.webContents.id, target); assert.equal(opened.ok, true, JSON.stringify(opened));
  code.layout(window.webContents.id, target, { x: 60, y: 60, width: 1100, height: 780 });
  await window.webContents.executeJavaScript(`{const f=document.createElement('iframe');f.src=${JSON.stringify(opened.value.frameUrl)};f.sandbox='allow-scripts allow-same-origin';f.style='width:1100px;height:780px;border:0';document.querySelector('#editor').append(f);}`);
  const frame = await wait(()=>window.webContents.mainFrame.frames.find(frame=>frame.url===opened.value.frameUrl), 'Iframe did not navigate');
  const view = {webContents:{executeJavaScript:code=>frame.executeJavaScript(code),on:()=>{},session:window.webContents.session,focus:()=>{},debugger:window.webContents.debugger,capturePage:()=>window.webContents.capturePage(),isDestroyed:()=>window.isDestroyed()},getVisible:()=>true}; currentView=view;
  view.webContents.on('console-message', event => console.log('WORKBENCH', event.level, event.message));
  view.webContents.on('did-fail-load', (_event, ...details) => console.error('WORKBENCH_LOAD', ...details));
  await wait(() => view.webContents.executeJavaScript('!!document.querySelector(".monaco-workbench")'), 'Genuine workbench did not mount');
  view.webContents.session.webRequest.onErrorOccurred(details => console.log('FAILED_RESOURCE', details.url, details.error));
  assert.equal(await view.webContents.executeJavaScript('typeof window.elevenex'), 'undefined');
  assert.equal(await view.webContents.executeJavaScript('typeof require'), 'undefined');
  assert.equal(await view.webContents.executeJavaScript("(()=>{try{void parent.document;return false;}catch{return true;}})()"), true, 'Editor must not access the shell DOM');
  assert.equal(await view.webContents.executeJavaScript("fetch('https://example.invalid/exfiltrate').then(()=>false,()=>true)"), true, 'Editor CSP must block external network');
  const finish = async message => {
    await code.dispose(); client.dispose(); stopRouting();
    // Stop Chromium's profile writer before removing its files. The workbench
    // may have just persisted configuration or hot-exit state during shutdown.
    const session = window.webContents.session;
    window.destroy(); await session.clearStorageData();
    watches.onModuleDestroy(); search.onModuleDestroy();
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    console.log(message); clearTimeout(deadline); app.exit(0);
  };
  if (htmlPreview) {
    await wait(() => codeState?.phase === 'ready', 'Task editor did not connect');
    await window.webContents.executeJavaScript("document.querySelector('iframe').style.width='432px'");
    await code.present(window.webContents.id, target, { visible: true, compact: true });
    assert.equal((await code.openFile(window.webContents.id, target, { path: 'site/Preview page.HTML' })).ok, true);
    window.webContents.debugger.attach('1.3');
    await window.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
    const button = (label, focus = false) => frame.executeJavaScript(`(() => {
      const element = [...document.querySelectorAll('.editor-actions [aria-label]')].find(element => element.getAttribute('aria-label').startsWith(${JSON.stringify(label)}));
      if (!element) return;
      const rect = element.getBoundingClientRect();
      if (${focus}) element.focus();
      return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) };
    })()`);
    const click = async label => {
      const point = await wait(() => button(label), `Missing editor action ${label}`);
      const offset = await window.webContents.executeJavaScript('document.querySelector("iframe").getBoundingClientRect().toJSON()');
      const position = { x: point.x + offset.x, y: point.y + offset.y };
      await window.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', ...position });
      for (const type of ['mousePressed', 'mouseReleased']) await window.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type, button: 'left', clickCount: 1, ...position });
    };
    // The webview document that owns the page frames, and its visible page.
    const outer = () => frame.framesInSubtree.find(child => child.url.includes('/fake.html') &&
      child.parent?.url.includes('extensionId=elevenex.task-workspace'));
    const view = expression => outer()?.executeJavaScript(expression);
    const currentOrigin = async () => {
      const source = await view("document.querySelector('#stage iframe:not(.incoming)')?.src ?? ''").catch(() => '');
      return source ? new URL(source).origin : undefined;
    };
    const inspectPage = async expression => {
      const origin = await currentOrigin();
      if (!origin) return;
      const { targetInfos } = await window.webContents.debugger.sendCommand('Target.getTargets');
      const preview = targetInfos.find(info => info.type === 'iframe' && info.url.startsWith(origin + '/'));
      if (!preview) return;
      const { sessionId } = await window.webContents.debugger.sendCommand('Target.attachToTarget', { targetId: preview.targetId, flatten: true });
      try {
        const { result } = await window.webContents.debugger.sendCommand('Runtime.evaluate', { expression, returnByValue: true }, sessionId);
        return result.value;
      } finally {
        await window.webContents.debugger.sendCommand('Target.detachFromTarget', { sessionId }).catch(() => undefined);
      }
    };
    const tab = label => frame.executeJavaScript(`!!document.querySelector('.tab[aria-label^=${JSON.stringify(label)}]')`);
    const previewLabel = () => frame.executeJavaScript(`(() => {
      const action = document.querySelector('.editor-actions [role="button"][aria-label^="Open Preview"]');
      if (!action || getComputedStyle(action, '::before').content === 'none') return;
      return getComputedStyle(action, '::after').content;
    })()`);
    await wait(async () => (await previewLabel())?.startsWith('"Preview"'), 'HTML title action did not show its icon and label');
    await window.webContents.executeJavaScript("document.querySelector('iframe').style.width = '240px'");
    await wait(async () => (await previewLabel()) === 'none', 'Narrow editor did not keep an accessible icon-only preview action');
    await window.webContents.executeJavaScript("document.querySelector('iframe').style.width = '432px'");
    await wait(async () => (await previewLabel())?.startsWith('"Preview"'), 'Preview label did not return after widening the editor');
    await click('Open Preview');
    await wait(currentOrigin, 'HTML preview did not load from a single click');
    await wait(() => inspectPage(`document.querySelector('h1')?.textContent === 'Task HTML preview' &&
      getComputedStyle(document.querySelector('h1')).color === 'rgb(16, 80, 120)' &&
      getComputedStyle(document.querySelector('h1')).fontSize === '36px' &&
      document.querySelector('img')?.naturalWidth === 40`), 'HTML, relative stylesheet or local image did not render');
    assert.equal(await inspectPage('typeof window.elevenex'), 'undefined');
    await wait(async () => /Scripts don’t run/.test(await view("document.getElementById('notice').hidden ? '' : document.getElementById('notice-text').textContent")), 'Blocked page script was not explained');
    assert.equal(await inspectPage("document.querySelector('h1').textContent"), 'Task HTML preview', 'Page scripts must stay blocked');

    // External links ask before leaving, and never navigate the preview.
    const previousOrigin = await currentOrigin();
    await inspectPage("document.querySelector('#external').click()");
    const confirmation = "(() => { const widget = document.querySelector('.quick-input-widget'); return !!widget && widget.style.display !== 'none' && widget.textContent.includes('https://example.invalid/'); })()";
    await wait(() => frame.executeJavaScript(confirmation), 'External link was not confirmed');
    for (const type of ['keyDown', 'keyUp']) await window.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type, key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await wait(async () => !(await frame.executeJavaScript(confirmation)), 'Link confirmation did not close');
    assert.ok(!frame.framesInSubtree.some(child => child.url.startsWith('https://example.invalid')), 'Preview must remain in the task');
    assert.equal(await currentOrigin(), previousOrigin);

    // Editing the source keeps the reader's place.
    await inspectPage('scrollTo(0, 900)');
    await new Promise(resolve => setTimeout(resolve, 400));
    await wait(() => button('Show Source', true), 'Missing return-to-source control');
    for (const type of ['keyDown', 'keyUp']) await window.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await wait(() => button('Open Preview'), 'Show Source did not return to the source tab');
    const command = name => frame.executeJavaScript(`import('/assets/out/vs/workbench/workbench.web.main.internal.js').then(({commands}) => commands.executeCommand(${JSON.stringify(name)}))`);
    await command('workbench.action.focusActiveEditorGroup');
    await command('editor.action.selectAll');
    const updated = '<!doctype html><h1>Updated after saving</h1><a href="./next.htm">Next page</a><div style="height: 3000px"></div>';
    await window.webContents.debugger.sendCommand('Input.insertText', { text: updated });
    await command('workbench.action.files.save');
    await wait(async () => (await readFile(join(worktree, 'site', 'Preview page.HTML'), 'utf8')).includes(updated), 'HTML source did not save');
    // Return to the retained preview tab directly. Opening the preview command
    // again only reveals it.
    await command('workbench.action.nextEditorInGroup');
    await wait(() => inspectPage("document.querySelector('h1')?.textContent === 'Updated after saving'"), 'Retained HTML preview did not refresh on save');
    const restored = await inspectPage('scrollY');
    assert.ok(Math.abs(restored - 900) <= 2, `Refresh did not keep the scroll position (${restored})`);

    // Following a link retargets the tab, Refresh and Show Source.
    await inspectPage("document.querySelector('a').click()");
    await wait(() => inspectPage("document.querySelector('h1')?.textContent === 'Second page'"), 'Relative HTML link did not navigate');
    await wait(() => tab('Preview · next.htm'), 'Preview title did not follow navigation');
    await click('Refresh Preview');
    await wait(async () => (await view("document.querySelectorAll('#stage iframe').length")) === 1 &&
      inspectPage("document.querySelector('h1')?.textContent === 'Second page'"), 'Refresh did not stay on the current page');

    // An agent's disk edit refreshes the visible preview without a save.
    await writeFile(join(worktree, 'site', 'next.htm'), '<h1>Edited on disk</h1>');
    await wait(() => inspectPage("document.querySelector('h1')?.textContent === 'Edited on disk'"), 'Disk edit did not refresh the preview', 20_000);
    assert.equal(await frame.executeJavaScript("document.querySelectorAll('.tab[aria-label^=\"Preview ·\"]').length"), 1);
    window.webContents.debugger.detach();
    return finish('HTML_PREVIEW_SMOKE_OK');
  }
  if (links) {
    await wait(() => codeState?.phase === 'ready', 'Task editor did not connect');
    await window.webContents.executeJavaScript("document.querySelector('iframe').style.width='432px'");
    await code.present(window.webContents.id, target, { visible: true, compact: true });
    const openLink = async path => {
      const result = await code.openFile(window.webContents.id, target, { path, fromChat: true });
      assert.equal(result.ok, true, JSON.stringify(result));
    };
    await openLink('./src/');
    await wait(() => frame.executeJavaScript('document.querySelector(".explorer-folders-view")?.innerText.includes("nested.ts")'), 'Workspace folder did not expand');
    await openLink(join(worktree, 'hello.ts') + ':1:8');
    await wait(() => frame.executeJavaScript('/Ln 1, Col 8/.test(document.body.innerText) && !!document.querySelector(".tab[aria-label*=hello]")'), 'Absolute task file did not open at its position');
    await openLink(require('node:url').pathToFileURL(linkedFile).href + '#L2');
    await wait(() => frame.executeJavaScript('!!document.querySelector(".tab[aria-label*=outside]") && /Ln 2, Col 1/.test(document.body.innerText)'), 'Outside file did not open at its position');
    await frame.executeJavaScript('document.querySelector(".monaco-editor textarea.inputarea").focus()');
    window.webContents.debugger.attach('1.3');
    try {
      await window.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
      await window.webContents.debugger.sendCommand('Input.insertText', { text: 'unexpected edit' });
      assert.equal(await frame.executeJavaScript('!!document.querySelector(".tab.dirty") || document.body.innerText.includes("unexpected edit")'), false);
    } finally { window.webContents.debugger.detach(); }
    await openLink(linkedFolder);
    await wait(() => frame.executeJavaScript('Array.from(document.querySelectorAll("[role=treeitem]")).some(item => item.textContent.includes("outside.md"))'), 'Outside folder did not expand');
    await finish('CHAT_LINKS_SMOKE_OK');
    return;
  }
  assert.equal((await code.openFile(window.webContents.id, target, { path: 'hello.ts', line: 1 })).ok, true);
  await wait(() => view.webContents.executeJavaScript('!!document.querySelector(".monaco-editor") && !!document.querySelector(".tab[aria-label*=hello], .tab[title*=hello]")'), 'File did not open', 45_000);
  metrics.usableFileMs = Math.round(performance.now() - started); console.log('Usable file ms:', metrics.usableFileMs);
  // Real keyboard commands into the VS Code iframe.
  window.focus(); view.webContents.focus();
  await view.webContents.executeJavaScript("import('/assets/out/vs/workbench/workbench.web.main.internal.js').then(({commands}) => commands.executeCommand('workbench.action.focusActiveEditorGroup'))");
  console.log('EDITOR_LAYOUT', await view.webContents.executeJavaScript('JSON.stringify({size:[innerWidth,innerHeight],editor:document.querySelector(".monaco-editor")?.getBoundingClientRect().toJSON(),inputs:[...document.querySelectorAll("textarea,[contenteditable=true]")].map(e=>e.outerHTML.slice(0,180))})'));
  await view.webContents.executeJavaScript('document.querySelector(".monaco-editor textarea.inputarea").focus()');
  view.webContents.debugger.attach('1.3');
  await view.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', {enabled:true});
  await view.webContents.executeJavaScript("import('/assets/out/vs/workbench/workbench.web.main.internal.js').then(({commands}) => commands.executeCommand('editor.action.selectAll'))"); await view.webContents.debugger.sendCommand('Input.insertText', { text: 'export const message = "saved through Code OSS";\n' });
  console.log('AFTER_INPUT', await view.webContents.executeJavaScript('JSON.stringify({active:document.activeElement?.className,dirty:!!document.querySelector(".tab.dirty"),text:document.querySelector(".monaco-editor")?.innerText})'));
  await wait(async () => (await readFile(join(worktree, 'hello.ts'), 'utf8')) === 'export const message = "saved through Code OSS";\n', 'Auto-save did not reach task files without a save action');
  const reopenStarted = performance.now();
  code.release(window.webContents.id, target); await code.open(window.webContents.id, target);
  code.layout(window.webContents.id, target, { x: 60, y: 60, width: 1100, height: 780 });
  metrics.reopenMs = Math.round(performance.now() - reopenStarted);
  assert.equal(window.webContents.mainFrame.frames.find(f=>f.url===opened.value.frameUrl), frame, 'Reopen duplicated the workbench');
  // Compact side-panel mode uses the same workbench, with direct overlay search.
  await window.webContents.executeJavaScript("document.querySelector('iframe').style.width='432px'");
  await code.layout(window.webContents.id, target, { x: 750, y: 100, width: 432, height: 700 });
  assert.equal(view.getVisible(), true);
  assert.equal(await view.webContents.executeJavaScript('document.querySelector(".part.sidebar")?.getBoundingClientRect().width ?? 0'), 0);
  await code.action(window.webContents.id, target, 'find-file');
  await wait(() => view.webContents.executeJavaScript('!!document.querySelector(".quick-input-widget input")'), 'Compact file picker missing');
  for (const type of ['keyDown', 'keyUp']) await view.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type, key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await code.action(window.webContents.id, target, 'search-text');
  await view.webContents.debugger.sendCommand('Input.insertText', { text: 'saved through Code OSS' });
  await wait(() => view.webContents.executeJavaScript('document.querySelector(".quick-input-list")?.textContent.includes("hello.ts")'), 'Compact text search did not find the real file');
  for (const type of ['keyDown', 'keyUp']) await view.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type, key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  const command = name => frame.executeJavaScript(`import('/assets/out/vs/workbench/workbench.web.main.internal.js').then(({commands}) => commands.executeCommand(${JSON.stringify(name)}))`);
  const markdownFrame = () => frame.frames.find(child => !child.detached && child.url.startsWith('https:')
    && new URL(child.url).searchParams.get('extensionId') === 'vscode.markdown-language-features');
  for (const mode of ['markdown.showPreview', 'markdown.showPreviewToSide', 'markdown.showLockedPreviewToSide', 'markdown.reopenAsPreview']) {
    assert.equal((await code.openFile(window.webContents.id, target, { path: 'README.md' })).ok, true);
    await command(mode);
    const preview = await wait(markdownFrame, `Markdown preview frame did not load for ${mode}`, 12_000);
    await wait(() => preview.executeJavaScript(`(() => {
      const doc = document.querySelector('#active-frame')?.contentDocument;
      return doc?.querySelector('h1')?.textContent === 'Task Markdown preview' &&
        doc.querySelector('strong')?.textContent === 'Formatted text' &&
        doc.querySelector('img[alt="Task diagram"]')?.naturalWidth === 40;
    })()`), `Markdown preview content or task image did not render for ${mode}`, 12_000);
    console.log('MARKDOWN_PREVIEW_RENDERED', mode);
    await command('workbench.action.closeAllEditors');
    await command('workbench.action.joinAllGroups');
    await wait(() => !markdownFrame(), `Markdown preview did not close for ${mode}`, 12_000);
  }
  assert.equal((await code.openFile(window.webContents.id, target, { path: 'hello.ts' })).ok, true);
  await code.layout(window.webContents.id, target, { x: 60, y: 60, width: 1100, height: 780 });
  await window.webContents.executeJavaScript("document.querySelector('iframe').style.width='1100px'");
  assert.equal(window.webContents.mainFrame.frames.find(f=>f.url===opened.value.frameUrl), frame, 'Expansion duplicated the compact editor');
  // Force a renderer crash after upstream hot-exit backups have settled.
  // Deliberately disable auto-save only for this unsaved-buffer recovery case.
  await view.webContents.executeJavaScript("import('/assets/out/vs/workbench/workbench.web.main.internal.js').then(({commands}) => commands.executeCommand('workbench.action.toggleAutoSave'))");
  await view.webContents.executeJavaScript("import('/assets/out/vs/workbench/workbench.web.main.internal.js').then(({commands}) => commands.executeCommand('editor.action.selectAll'))"); await view.webContents.debugger.sendCommand('Input.insertText', { text: 'export const recoveredFromCrash = true;\n' });
  await wait(() => view.webContents.executeJavaScript('!!document.querySelector(".tab.dirty")'), 'Dirty editor state missing');
  // VS Code debounces browser backups; allow its supported hot-exit mechanism to settle.
  await new Promise(resolve => setTimeout(resolve, 2500));
  view.webContents.debugger.detach();
  window.webContents.forcefullyCrashRenderer();
  await wait(()=>codeState?.phase === 'failed','Renderer crash was not reported');
  await window.loadURL('app://elevenex/');
  const restartAt = performance.now();
  const restored = await code.open(window.webContents.id, target); assert.equal(restored.ok, true);
  await window.webContents.executeJavaScript(`{const f=document.createElement('iframe');f.src=${JSON.stringify(opened.value.frameUrl)};f.sandbox='allow-scripts allow-same-origin';f.style='width:1100px;height:780px;border:0';document.querySelector('#editor').append(f);}`);
  view.webContents.executeJavaScript = async code => (await wait(()=>window.webContents.mainFrame.frames.find(f=>f.url===opened.value.frameUrl),'Restored frame missing')).executeJavaScript(code);
  code.layout(window.webContents.id, target, { x: 60, y: 60, width: 1100, height: 780 });
  await wait(() => view.webContents.executeJavaScript('document.querySelector(".monaco-editor")?.textContent.includes("recoveredFromCrash")'), 'Unsaved hot-exit buffer was not restored', 45_000);
  metrics.crashRecoveryMs = Math.round(performance.now() - restartAt);
  assert.equal(window.webContents.mainFrame.frames.filter(f=>f.url===opened.value.frameUrl).length, 1);
  view.webContents.debugger.attach('1.3');
  await view.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', {enabled:true});
  await view.webContents.executeJavaScript('document.querySelector(".monaco-editor textarea.inputarea").focus()');
  await code.action(window.webContents.id, target, 'save');
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
  await view.webContents.executeJavaScript("import('/assets/out/vs/workbench/workbench.web.main.internal.js').then(({commands}) => commands.executeCommand('workbench.action.toggleAutoSave'))");
  // Native save errors must stay visible inside VS Code and retain the buffer.
  rejectWrites = true;
  await view.webContents.executeJavaScript("import('/assets/out/vs/workbench/workbench.web.main.internal.js').then(({commands}) => commands.executeCommand('editor.action.selectAll'))");
  await view.webContents.debugger.sendCommand('Input.insertText', { text: 'export const retainedAfterSaveFailure = true;\n' });
  await wait(() => view.webContents.executeJavaScript('document.querySelector(".notifications-toasts")?.textContent.includes("Failed to save")'), 'Auto-save failure did not show a native VS Code notification');
  await wait(() => view.webContents.executeJavaScript('(()=>{const toasts=document.querySelector(".notifications-toasts");return toasts?.classList.contains("visible") && toasts.getAnimations({subtree:true}).every(animation=>animation.playState!=="running");})()'), 'Save error toast did not become visible');
  assert.equal(await readFile(join(worktree, 'hello.ts'), 'utf8'), 'export const recoveredFromCrash = true;\n');
  assert.equal(await view.webContents.executeJavaScript('!!document.querySelector(".tab.dirty") && document.querySelector(".monaco-editor")?.textContent.includes("retainedAfterSaveFailure")'), true);
  await view.webContents.capturePage().then(image => writeFile(join(process.cwd(), 'artifacts/code-autosave-failure.png'), image.toPNG()));
  view.webContents.debugger.detach();
  await finish('CODE_WORKBENCH_SMOKE_PASSED');
}).catch(async error => {
  console.error(error);
  if (currentView && !currentView.webContents.isDestroyed()) {
    try {
      console.log('FAILED_EDITOR_DOM', await currentView.webContents.executeJavaScript('document.body.innerText.slice(-4000)'));
      await currentView.webContents.capturePage().then(image => writeFile(join(process.cwd(), 'artifacts/code-workbench-failed.png'), image.toPNG()));
    } catch (diagnosticError) { console.error('Editor diagnostics unavailable', diagnosticError.message); }
  }
  try { await code?.dispose(); } catch (cleanupError) { console.error('Editor cleanup failed', cleanupError.message); }
  stopRouting?.(); if (window && !window.isDestroyed()) window.destroy();
  watches?.onModuleDestroy(); search?.onModuleDestroy(); server?.close(); server?.closeAllConnections();
  if (root) await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => {});
  clearTimeout(deadline); app.exit(1);
});
