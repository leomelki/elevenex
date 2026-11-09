const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const { mkdtemp, rm, mkdir, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join, resolve, dirname } = require('node:path');
const { app, BrowserWindow, Menu } = require('electron');
const { TaskBrowser } = require('../dist/browser/task');
const { BrowserTaskProfiles } = require('../dist/browser/task-session');
const { BrowserPersistence } = require('../dist/browser/persistence');

module.exports = async function browserPlaywrightNative() {
  const root = await mkdtemp(join(tmpdir(), 'elevenex-native-playwright-'));
  const server = createServer((request, response) => {
    if (request.url === '/api/desktop-browser/authorize') {
      request.resume();
      response.setHeader('Content-Type', 'application/json');
      response.end(
        JSON.stringify({ taskId: 1, sessionId: 2, available: true }),
      );
      return;
    }
    if (request.url === '/frame') {
      response.setHeader('Content-Type', 'text/html');
      response.end(
        '<button onclick="this.textContent=\'Frame done\'">Frame button</button>',
      );
      return;
    }
    if (request.url === '/download') {
      response.setHeader(
        'Content-Disposition',
        'attachment; filename="owned.txt"',
      );
      response.end('native-download');
      return;
    }
    response.setHeader('Content-Type', 'text/html');
    response.end(
      '<!doctype html><title>Native Playwright</title><style>body{font:20px sans-serif;margin:30px}input,button{font:inherit;margin:12px}iframe{display:block;width:500px;height:120px}</style><h1>Waiting</h1><input aria-label="Name"><button onclick="fetch(\'/api\').then(r=>r.json()).then(v=>document.querySelector(\'h1\').textContent=v.label)">Save</button><a href="/download">Download</a><input aria-label="Upload" type="file"><iframe src="/frame"></iframe>',
    );
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const base = 'http://127.0.0.1:' + server.address().port;
  const window = new BrowserWindow({
      show: false,
      webPreferences: {
        sandbox: true,
        nodeIntegration: false,
        contextIsolation: true,
      },
    }),
    profiles = new BrowserTaskProfiles(),
    persistence = new BrowserPersistence(root);
  const client = {
    state: () => ({ scope: { id: 'scope' } }),
    execute: async (_window, _scope, _key, _mutation, operation) => ({
      ok: true,
      value: await operation({ url: base }, new AbortController().signal),
    }),
  };
  const task = new TaskBrowser(
    'scope',
    1,
    window,
    client,
    {},
    persistence,
    'native-pw-' + Date.now(),
    profiles,
    false,
    () => {},
    () => true,
  );
  const run = (code, timeoutMs = 20000) =>
    task.code(
      2,
      { kind: 'code', code, timeoutMs },
      new AbortController().signal,
    );
  try {
    console.log('Native Playwright: starting page and locator checks');
    const result = await run(`
      state.page=await context.newPage();const label='Native real Playwright';
      await state.page.route('**/api',route=>route.fulfill({json:{label}}));
      await state.page.goto(${JSON.stringify(base)});
      await state.page.getByLabel('Name',{exact:true}).fill('Native text');
      await state.page.getByRole('button',{name:'Save',exact:true}).click();
      await expect(state.page.getByRole('heading')).toHaveText(label);
      await state.page.frameLocator('iframe').getByRole('button').click();
      await expect(state.page.frameLocator('iframe').getByRole('button')).toHaveText('Frame done');
      await emitImage(await state.page.screenshot({fullPage:true}));
      return await state.page.getByLabel('Name',{exact:true}).inputValue();
    `);
    assert.equal(result.error, undefined, JSON.stringify(result));
    assert.equal(result.value, 'Native text');
    assert.equal(result.images.length, 1);
    const artifacts = resolve(
      dirname(require.resolve('./browser-playwright-native.cjs')),
      '../../../artifacts/browser-playwright',
    );
    await mkdir(artifacts, { recursive: true });
    await writeFile(
      join(artifacts, 'electron.png'),
      Buffer.from(result.images[0].data, 'base64'),
    );
    const previousMenu = Menu.getApplicationMenu();
    let menuInvoked = false;
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([
        {
          label: 'Test',
          submenu: [
            {
              label: 'Browser must not invoke app shortcuts',
              accelerator: 'CmdOrCtrl+Q',
              click: () => {
                menuInvoked = true;
              },
            },
          ],
        },
      ]),
    );
    try {
      const keys = await run(
        `await state.page.keyboard.press(${JSON.stringify(process.platform === 'darwin' ? 'Meta+q' : 'Control+q')});return await state.page.title()`,
      );
      assert.equal(keys.error, undefined, JSON.stringify(keys));
      assert.equal(
        menuInvoked,
        false,
        'Browser automation must stay outside application menu shortcuts',
      );
    } finally {
      Menu.setApplicationMenu(previousMenu);
    }
    console.log('Native Playwright: checking uploads and downloads');
    const files = await run(`
      await state.page.getByLabel('Upload',{exact:true}).setInputFiles({name:'native.txt',mimeType:'text/plain',buffer:Buffer.from('native-upload')});
      const value=await state.page.getByLabel('Upload',{exact:true}).evaluate(async el=>await el.files[0].text());
      const [download]=await Promise.all([state.page.waitForEvent('download'),state.page.getByRole('link',{name:'Download'}).click()]);
      await download.saveAs('owned.txt');return [value,(await artifacts.read('owned.txt')).toString('utf8')];
    `);
    assert.equal(files.error, undefined, JSON.stringify(files));
    assert.deepEqual(files.value, ['native-upload', 'native-download']);
    console.log('Native Playwright: checking popup ownership');
    const popup = await run(`
      const [popup]=await Promise.all([state.page.waitForEvent('popup'),state.page.evaluate(()=>{window.open('/frame');})]);
      await expect(popup.getByRole('button')).toHaveText('Frame button');
      const opener=await popup.opener(); const same=opener===state.page;
      state.popup=popup;return same;
    `);
    assert.equal(popup.error, undefined, JSON.stringify(popup));
    assert.equal(popup.value, true);
    console.log('Native Playwright: checking human selection');
    const ticket = await run(
      `return await human.requestElement(state.page,{message:'Choose the Name input'})`,
    );
    assert.equal(ticket.error, undefined, JSON.stringify(ticket));
    assert.ok(
      [...task.pages.values()].every((page) => page.lease.driver !== 'agent'),
    );
    const blocked = await run(
      'return await state.popup.evaluate(()=>window.opener.document.body.innerText)',
    );
    assert.ok(
      blocked.error,
      'A related popup must not retain a path to the human-controlled opener',
    );
    await task.command({
      kind: 'agent-request-pick', visual: 1,
      requestId: ticket.value.id,
    });
    const page = task.pages.get(ticket.value.tabId),
      rect = await page.contents.executeJavaScript(
        `(()=>{const r=document.querySelector('input').getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`,
      );
    await page.agentPicker(rect.x, rect.y);
    assert.equal(task.snapshot().agentRequests[0].selection.tag, 'input');
    const snapshot = task.snapshot().agentRequests[0].selection.snapshot;
    assert.equal(snapshot?.reference.label, 'input · Name');
    assert.ok(snapshot?.jpeg, JSON.stringify(snapshot));
    assert.equal(Buffer.from(snapshot.jpeg, 'base64').readUInt16BE(0), 0xffd8);
    assert.equal(snapshot.reference.image.scale, 1);
    assert.ok(snapshot.reference.crop.width <= 1600);
    const evidence = resolve(process.cwd(), 'artifacts/element-mentions');
    await require('node:fs/promises').mkdir(evidence, { recursive: true });
    await require('node:fs/promises').writeFile(require('node:path').join(evidence, 'native-snapshot.json'), JSON.stringify(snapshot));
    await require('node:fs/promises').writeFile(require('node:path').join(evidence, 'native-crop.jpg'), Buffer.from(snapshot.jpeg, 'base64'));
    assert.equal(page.lease.driver, 'needs');
    await task.command({
      kind: 'agent-request-complete',
      requestId: ticket.value.id,
    });
    assert.equal(page.lease.agentSessionId, 2);
    const selected = await run(
      `const element=await human.locator(${JSON.stringify(ticket.value.id)});await element.fill('Selected by user');return await element.inputValue()`,
    );
    assert.equal(selected.error, undefined, JSON.stringify(selected));
    assert.equal(selected.value, 'Selected by user');
    console.log(
      'Native Playwright: real locators, assertions, routes, frames, uploads/downloads, images and explicit human selection passed',
    );
  } finally {
    task.destroy();
    window.destroy();
    server.closeAllConnections();
    await persistence.flush();
    await profiles.flush();
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
};

if (
  process.argv.some((arg) => arg.endsWith('/browser-playwright-native.cjs'))
) {
  app.on('window-all-closed', () => {});
  const { mkdtempSync } = require('node:fs'),
    data = mkdtempSync(join(tmpdir(), 'elevenex-pw-app-'));
  app.setPath('userData', data);
  app
    .whenReady()
    .then(module.exports)
    .then(
      async () => {
        await rm(data, { recursive: true, force: true });
        app.exit(0);
      },
      (error) => {
        console.error(error);
        app.exit(1);
      },
    );
}
