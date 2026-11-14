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
  const presentationUpdates = [];
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
    state => {
      const tab = state.tabs.at(-1);
      if (tab?.step?.text.startsWith('Native feedback') && presentationUpdates.length < 128)
        presentationUpdates.push({ status: tab.step.status, cursor: tab.agentCursor, highlight: tab.agentHighlight });
    },
    () => true,
  );
  const run = (code, timeoutMs = 20000) =>
    task.code(
      2,
      { kind: 'code', code, timeoutMs },
      new AbortController().signal,
    );
  try {
    console.log('Native Playwright: checking autonomous acquisition and user stop');
    const opened = await task.command({ kind: 'open', url: base });
    const userPage = task.pages.get(opened.active);
    userPage.ensureAgentView();
    const readyDeadline = Date.now() + 15000;
    while (userPage.loading || userPage.contents.getURL() === 'about:blank' || !userPage.contents.getURL()) {
      if (Date.now() > readyDeadline) throw new Error('User tab did not load');
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    const id = JSON.stringify(userPage.id);
    const acquired = await run(`
      state.userPage=await browser.page(${id});
      await state.userPage.getByLabel('Name',{exact:true}).fill('Acquired');
      await state.userPage.frameLocator('iframe').getByRole('button').click();
      return await state.userPage.frameLocator('iframe').getByRole('button').textContent();
    `);
    assert.equal(acquired.error, undefined, JSON.stringify(acquired));
    assert.equal(acquired.value, 'Frame done');
    const foreign = await task.code(3, { kind: 'code', code: `await browser.page(${id})`, timeoutMs: 15000 }, new AbortController().signal);
    assert.match(foreign.error.message, /another conversation/);
    userPage.presentation = 'stream';
    userPage.show({ x: 0, y: 0, width: 800, height: 600 });
    await assert.rejects(userPage.userInput(userPage.lease.generation - 1, { kind: 'text', text: 'stale' }), /control changed/);
    assert.equal(userPage.lease.driver, 'you');
    assert.equal(userPage.lease.agentPaused, false);
    assert.equal(userPage.lease.waiting, false);
    userPage.hide();
    assert.ok((await run('return await state.userPage.title()')).error);
    const reacquired = await run(`state.userPage=await browser.page(${id});return await state.userPage.title()`);
    assert.equal(reacquired.error, undefined, JSON.stringify(reacquired));
    assert.equal(reacquired.value, 'Native Playwright');
    await task.command({ kind: 'focus', tabId: userPage.id });
    assert.equal((await run(`state.userPage=await browser.page(${id})`)).error, undefined);
    const requested = await run(`return await human.requestAction(state.userPage,{message:'Optional manual step'})`);
    assert.equal(requested.error, undefined, JSON.stringify(requested));
    assert.equal(userPage.lease.driver, 'needs');
    assert.equal(userPage.lease.agentPaused, false);
    assert.equal((await run(`state.userPage=await browser.page(${id})`)).error, undefined);
    assert.equal(task.humanResults().find(request => request.id === requested.value.id).status, 'cancelled');
    await task.command({ kind: 'takeover', tabId: userPage.id });
    assert.ok((await run('return await state.userPage.title()')).error);
    assert.match((await run(`await browser.page(${id})`)).error.message, /stopped/);
    assert.match((await run(`await browser.tabs.get(${id})`)).error.message, /stopped/);
    await task.code(2, { kind: 'code', code: '', reset: true, timeoutMs: 15000 }, new AbortController().signal);
    assert.match((await run(`await browser.page(${id})`)).error.message, /stopped/);
    await task.command({ kind: 'handoff', tabId: userPage.id, sessionId: 2 });
    const resumed = await run(`state.userPage=await browser.page(${id});return await state.userPage.getByLabel('Name',{exact:true}).inputValue()`);
    assert.equal(resumed.error, undefined, JSON.stringify(resumed));
    assert.equal(resumed.value, 'Acquired');
    assert.match((await run(`const tab=await browser.tabs.get(${id});await tab.close()`)).error.message, /User-created/);
    userPage.lease.takeOver(false, false);
    const helper = await run(`state.userTab=await browser.tabs.get(${id});return await state.userTab.evaluate(()=>document.title)`);
    assert.equal(helper.error, undefined, JSON.stringify(helper));
    assert.equal(helper.value, 'Native Playwright');
    await task.command({ kind: 'close', tabId: userPage.id });
    console.log('Native Playwright: starting page and locator checks');
    const result = await run(`
      state.page=await context.newPage();const label='Native real Playwright';
      await state.page.route('**/api',route=>route.fulfill({json:{label}}));
      await state.page.goto(${JSON.stringify(base)});
      await browser.step(state.page,{n:1,total:3,text:'Native feedback: choose Save',status:'running'});
      await state.page.getByLabel('Name',{exact:true}).fill('Native text');
      const save=state.page.getByRole('button',{name:'Save',exact:true});
      await browser.cursor.move(state.page,save,{highlight:true,label:'Save'});
      await browser.step(state.page,{n:2,total:3,text:'Native feedback: verify result',status:'waiting'});
      await save.click();
      await expect(state.page.getByRole('heading')).toHaveText(label);
      await state.page.frameLocator('iframe').getByRole('button').click();
      await expect(state.page.frameLocator('iframe').getByRole('button')).toHaveText('Frame done');
      await browser.step(state.page,{n:3,total:3,text:'Native feedback verified',status:'done'});
      await emitImage(await state.page.screenshot({fullPage:true}));
      return await state.page.getByLabel('Name',{exact:true}).inputValue();
    `);
    assert.equal(result.error, undefined, JSON.stringify(result));
    assert.equal(result.value, 'Native text');
    assert.equal(result.images.length, 1);
    assert.ok(presentationUpdates.some(update => update.cursor && update.highlight), JSON.stringify(presentationUpdates));
    assert.equal(task.snapshot().tabs.at(-1).step.status, 'done');
    assert.equal(task.snapshot().tabs.at(-1).agentCursor, undefined);
    const cursorShown = await run("await browser.cursor.move(state.page,{x:45,y:55},{pulse:true});return await state.page.evaluate(()=>document.querySelector('.agent-cursor')===null)");
    assert.equal(cursorShown.error, undefined, JSON.stringify(cursorShown));
    assert.equal(cursorShown.value, true, 'Decorations belong to trusted app chrome, not the website');
    assert.equal(task.snapshot().tabs.at(-1).agentCursor.x, 45);
    await run('await browser.cursor.hide(state.page)');
    assert.equal(task.snapshot().tabs.at(-1).agentCursor, undefined);
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
