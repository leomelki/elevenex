const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const { mkdtemp, rm, writeFile, mkdir } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join, resolve, dirname } = require('node:path');
const { app, BrowserWindow } = require('electron');
const { TaskBrowser } = require('../dist/browser/task');
const { BrowserTaskProfiles } = require('../dist/browser/task-session');
const { BrowserPersistence } = require('../dist/browser/persistence');

module.exports = async function browserCodeNative() {
  const root = await mkdtemp(join(tmpdir(), 'elevenex-browser-code-native-'));
  const server = createServer((_request, response) => {
    response.setHeader('Content-Type', 'text/html');
    response.end(`<!doctype html><title>Native code browser</title><style>body{font:22px sans-serif;margin:40px}input,button{font:inherit;display:block;margin:20px 0}</style><h1>Agent browser</h1><input aria-label="Name"><button onclick="document.querySelector('h1').textContent=document.querySelector('input').value">Save</button><script>window.trusted=[];for(const type of ['mousedown','input','keydown'])addEventListener(type,e=>trusted.push([type,e.isTrusted]));console.log('native-loaded')</script>`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = 'http://localhost:' + server.address().port;
  const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, nodeIntegration: false, contextIsolation: true } });
  const profiles = new BrowserTaskProfiles(), persistence = new BrowserPersistence(root);
  const client = { state: () => ({ scope: { id: 'test' } }) };
  const task = new TaskBrowser('test', 1, window, client, {}, persistence, 'native-code-' + Date.now(), profiles, false, () => {}, () => true);
  const run = (code, timeoutMs = 15000) => task.code(2, { kind: 'code', code, timeoutMs }, new AbortController().signal);
  try {
    const result = await run(`
      state.tab=await browser.tabs.new(${JSON.stringify(url)});
      await state.tab.waitFor(()=>!!document.querySelector('button'));
      await state.tab.fill('input','Native works');
      await state.tab.click('button');
      await state.tab.waitFor(()=>document.querySelector('h1').textContent==='Native works');
      await state.tab.press('Tab');
      await state.tab.screenshot();
      return {trusted:await state.tab.evaluate(()=>trusted),events:await state.tab.events()};
    `);
    assert.equal(result.error, undefined, JSON.stringify(result));
    assert.equal(result.images.length, 1);
    assert.ok(result.value.trusted.some(([type, trusted]) => type === 'mousedown' && trusted));
    assert.ok(result.value.trusted.some(([type, trusted]) => type === 'input' && trusted));
    assert.ok(result.value.events.items.some(event => event.method === 'Runtime.consoleAPICalled'));
    assert.equal(task.pages.size, 1);
    const page = [...task.pages.values()][0];
    assert.equal(page.independent, true);
    assert.equal(page.contents.getLastWebPreferences().sandbox, true);
    assert.equal(page.contents.getLastWebPreferences().nodeIntegration, false);
    const artifact = resolve(dirname(require.resolve('./browser-code-native.cjs')), '../../../artifacts/browser-mcp');
    await mkdir(artifact, { recursive: true });
    await writeFile(join(artifact, 'electron.jpg'), Buffer.from(result.images[0].data, 'base64'));
    const stalled = await run('await state.tab.evaluate(()=>new Promise(()=>{}))', 500);
    assert.equal(stalled.error.outcomeUnknown, true);
    const recovered = await run('state.tab=await browser.tabs.get((await browser.tabs.list())[0].id); return await state.tab.evaluate(()=>document.title)');
    assert.equal(recovered.error, undefined, JSON.stringify(recovered));
    assert.equal(recovered.value, 'Native code browser');
    page.lease.takeOver();
    assert.ok((await run('return await state.tab.snapshot()')).error);
    page.lease.handBack(2);
    assert.ok((await run('return await state.tab.snapshot()')).error);
    const reacquired = await run('state.tab=await browser.tabs.get((await browser.tabs.list())[0].id);return await state.tab.evaluate(()=>document.title)');
    assert.equal(reacquired.error, undefined, JSON.stringify(reacquired));
    assert.equal(reacquired.value, 'Native code browser');
    console.log('Browser code native: hidden startup, trusted input, images, events, timeout recovery, takeover passed');
  } finally {
    task.destroy(); window.destroy(); server.closeAllConnections(); await persistence.flush(); await profiles.flush();
    await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true });
  }
};

if (process.argv.some(arg => arg.endsWith('/browser-code-native.cjs'))) {
  app.on('window-all-closed', () => {});
  const { mkdtempSync } = require('node:fs');
  const data = mkdtempSync(join(tmpdir(), 'elevenex-agent-app-'));
  app.setPath('userData', data);
  app.whenReady().then(module.exports).then(async () => { await rm(data, { recursive: true, force: true }); app.exit(0); }, error => { console.error(error); app.exit(1); });
}
