// Run with Node after desktop:build. Two fresh Electron processes share only app data.
const assert = require('node:assert/strict');
const { mkdtemp, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { createServer } = require('node:http');
const { spawn } = require('node:child_process');

async function runParent() {
  const root = await mkdtemp(join(tmpdir(), 'elevenex-native-profile-'));
  const server = createServer((_request, response) => {
    response.setHeader('Content-Type', 'text/html');
    response.end('<!doctype html><title>Profile fixture</title>');
  });
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const url = 'http://127.0.0.1:' + server.address().port;
    const environment = { ...process.env };
    delete environment.ELECTRON_RUN_AS_NODE;
    for (const phase of ['write', 'read']) {
      await new Promise((resolve, reject) => {
        const child = spawn(require('electron'), [require.resolve('./browser-profile-native.cjs'), root, url, phase], {
          env: environment, stdio: 'inherit', timeout: 30000,
        });
        child.once('error', reject);
        child.once('exit', (code, signal) => code === 0 ? resolve() : reject(new Error('Profile phase failed: ' + (signal ?? code))));
      });
    }
    console.log('Browser profiles: cookies, localStorage, IndexedDB and caches survive Electron restart; tasks stay isolated');
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
}

async function runElectron() {
  const { app, WebContentsView } = require('electron');
  const [root, url, phase] = process.argv.slice(2);
  app.setPath('userData', root);
  await app.whenReady();
  const { BrowserTaskProfiles, BrowserTaskSession } = require('../dist/browser/task-session');
  const profiles = new BrowserTaskProfiles();
  const open = identity => new BrowserTaskSession(identity, profiles, async () => undefined, () => true, () => undefined, () => false, () => undefined);
  const view = profile => new WebContentsView({ webPreferences: { session: profile.session, sandbox: true, contextIsolation: true, nodeIntegration: false } });
  const profile = open('task-one');
  await profile.configure();
  const page = view(profile);
  const contents = page.webContents;
  try {
    await contents.loadURL(url);
    if (phase === 'write') {
      assert.throws(() => open('task-one'), /another window/);
      await contents.executeJavaScript(`(async () => {
        document.cookie = 'login=retained; Max-Age=86400; SameSite=Lax';
        localStorage.setItem('preference', 'retained');
        await new Promise((resolve, reject) => {
          const request = indexedDB.open('profile', 1);
          request.onupgradeneeded = () => request.result.createObjectStore('values');
          request.onerror = () => reject(request.error);
          request.onsuccess = () => {
            const database = request.result;
            const transaction = database.transaction('values', 'readwrite');
            transaction.objectStore('values').put('retained', 'login');
            transaction.oncomplete = () => { database.close(); resolve(); };
          };
        });
        const cache = await caches.open('profile');
        await cache.put('/cached', new Response('retained'));
      })()`);
    } else {
      assert.deepEqual(await contents.executeJavaScript(`(async () => {
        const stored = await new Promise((resolve, reject) => {
          const request = indexedDB.open('profile', 1);
          request.onerror = () => reject(request.error);
          request.onsuccess = () => {
            const database = request.result;
            const transaction = database.transaction('values', 'readonly');
            const value = transaction.objectStore('values').get('login');
            value.onsuccess = () => resolve(value.result);
            transaction.oncomplete = () => database.close();
          };
        });
        return [document.cookie, localStorage.getItem('preference'), stored, await (await caches.match('/cached'))?.text()];
      })()`), ['login=retained', 'retained', 'retained', 'retained']);
    }
    const other = open('task-two');
    const otherPage = view(other);
    await other.configure();
    await otherPage.webContents.loadURL(url);
    assert.deepEqual(await otherPage.webContents.executeJavaScript("[document.cookie, localStorage.getItem('preference')]"), ['', null]);
    otherPage.webContents.close(); other.destroy();
    contents.close(); profile.destroy();
    // Immediate reacquisition must wait for old network cleanup, without deleting storage.
    const reopened = open('task-one');
    await reopened.configure();
    assert.equal((await reopened.session.cookies.get({ url, name: 'login' }))[0]?.value, 'retained');
    reopened.destroy(); await profiles.flush();
  } finally {
    if (!contents.isDestroyed()) contents.close();
    profile.destroy(); await profiles.flush();
  }
  app.quit();
}

const running = process.versions.electron ? runElectron() : runParent();
running.catch(error => { console.error(error); process.exitCode = 1; if (process.versions.electron) require('electron').app.exit(1); });
