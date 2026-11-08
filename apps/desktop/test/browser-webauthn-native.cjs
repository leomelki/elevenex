/* global __filename, __dirname, window, navigator, PublicKeyCredential */
// Node entry spawns native Electron with disposable profiles. Only this test uses
// a virtual authenticator / automatic consent; neither is in the production path.
const assert = require('node:assert/strict');
const { mkdtemp, rm, writeFile, mkdir } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { spawn } = require('node:child_process');
const { createHash, createPublicKey, verify } = require('node:crypto');

async function parent() {
  const root = await mkdtemp(join(tmpdir(), 'ex-auth-native-'));
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  try {
    await new Promise((resolve, reject) => {
      const child = spawn(require('electron'), [__filename, root], { env, stdio: 'inherit', timeout: 60000 });
      child.once('error', reject); child.once('exit', (code, signal) => code === 0 ? resolve() : reject(new Error('Native authentication failed: ' + (signal ?? code))));
    });
  } finally { await rm(root, { recursive: true, force: true }); }
}

async function native() {
  const { app, BrowserWindow, dialog } = require('electron');
  app.setPath('userData', process.argv[2]);
  await app.whenReady();
  const { chromium } = require('../../backend/node_modules/playwright-core');
  const { prepareWebAuthnExtension } = require('../../backend/dist/desktop-browser/runtime-webauthn-extension');
  const { RuntimeWebAuthn } = require('../../backend/dist/desktop-browser/runtime-webauthn');
  const { WebAuthnBroker } = require('../dist/browser/webauthn-broker');
  const { webAuthnOptions } = require('../dist/browser/webauthn-validation');
  let context, relay, broker, owner;
  let credentials = [], localDebugger, authenticatorId;
  let consent = 1;
  const originalDialog = dialog.showMessageBox;
  dialog.showMessageBox = async (_parent, options) => ({ response: options.title === 'Choose a passkey' ? 0 : consent });
  try {
    const extension = await prepareWebAuthnExtension(process.argv[2]);
    context = await chromium.launchPersistentContext(join(process.argv[2], 'remote-profile'), {
      channel: 'chromium', headless: true, chromiumSandbox: true, ignoreDefaultArgs: ['--disable-extensions'],
      args: ['--load-extension=' + extension, '--disable-extensions-except=' + extension],
    });
    relay = new RuntimeWebAuthn(() => undefined, origin => origin === 'http://login.localhost');
    await relay.start(context); assert.equal(relay.available, true); await relay.configure(true, true);
    const page = await context.newPage();
    await page.route('http://login.localhost/**', route => route.fulfill({ body: '<!doctype html><title>WebAuthn fixture</title>', contentType: 'text/html' }));
    await page.goto('http://login.localhost/');
    const remoteDebugger = await context.newCDPSession(page);
    await remoteDebugger.send('Emulation.setFocusEmulationEnabled', { enabled: true });
    owner = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
    broker = new WebAuthnBroker();
    // Install virtual credentials before the fixed broker program starts. Main
    // authentication code and origin/RP validation are otherwise unmodified.
    app.on('web-contents-created', (_event, contents) => {
      if (contents === owner.webContents) return;
      const execute = contents.executeJavaScript.bind(contents);
      contents.executeJavaScript = async (...args) => {
        const result = await execute(...args);
        const value = await contents.debugger.sendCommand('WebAuthn.getCredentials', { authenticatorId });
        if (value.credentials.length) credentials = value.credentials;
        return result;
      };
      const load = contents.loadURL.bind(contents);
      contents.loadURL = async (...args) => {
        localDebugger = contents.debugger;
        localDebugger.attach('1.3');
        await localDebugger.sendCommand('WebAuthn.enable');
        ({ authenticatorId } = await localDebugger.sendCommand('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } }));
        for (const credential of credentials) await localDebugger.sendCommand('WebAuthn.addCredential', { authenticatorId, credential });
        return load(...args);
      };
    });
    const wait = async condition => { for (let i = 0; i < 200 && !condition(); i++) await new Promise(resolve => setTimeout(resolve, 25)); assert.ok(condition()); };
    const begin = async operation => {
      await page.evaluate(operation => {
        const publicKey = operation === 'create' ? {
          challenge: new Uint8Array([1, 2, 3]), rp: { id: 'login.localhost', name: 'Example' }, user: { id: new Uint8Array([4]), name: 'Alice', displayName: 'Alice' },
          pubKeyCredParams: [{ alg: -7, type: 'public-key' }], authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
        } : { challenge: new Uint8Array([5, 6, 7]), rpId: 'login.localhost', userVerification: 'required' };
        window.outcome = navigator.credentials[operation]({ publicKey }).then(value => ({ credential: value.toJSON(), native: value instanceof PublicKeyCredential }), error => ({ error: error.name }));
      }, operation);
      await wait(() => !!relay.snapshot());
      const metadata = relay.snapshot();
      return { metadata, options: webAuthnOptions(relay.read(metadata.id), metadata) };
    };
    const registration = await begin('create');
    const created = await broker.run(owner, registration.options, new AbortController().signal);
    assert.ok(created.responseJson, JSON.stringify(created));
    await relay.complete(registration.metadata.id, created);
    const registered = await page.evaluate(() => window.outcome);
    assert.equal(registered.native, true);
    const publicKey = registered.credential.response.publicKey;
    assert.ok(publicKey); assert.ok(credentials.length);
    const client = JSON.parse(Buffer.from(registered.credential.response.clientDataJSON, 'base64url'));
    assert.equal(client.origin, 'http://login.localhost'); assert.equal(client.challenge, 'AQID'); assert.equal(client.type, 'webauthn.create');
    const authentication = await begin('get');
    const signed = await broker.run(owner, authentication.options, new AbortController().signal);
    assert.ok(signed.responseJson, JSON.stringify(signed)); await relay.complete(authentication.metadata.id, signed);
    const authenticated = await page.evaluate(() => window.outcome);
    assert.equal(authenticated.native, true);
    const response = authenticated.credential.response;
    const authData = Buffer.from(response.authenticatorData, 'base64url');
    assert.deepEqual(authData.subarray(0, 32), createHash('sha256').update('login.localhost').digest());
    assert.equal(verify('sha256', Buffer.concat([authData, createHash('sha256').update(Buffer.from(response.clientDataJSON, 'base64url')).digest()]), createPublicKey({ key: Buffer.from(publicKey, 'base64url'), format: 'der', type: 'spki' }), Buffer.from(response.signature, 'base64url')), true);
    consent = 0;
    const canceled = await begin('get');
    await relay.complete(canceled.metadata.id, await broker.run(owner, canceled.options, new AbortController().signal));
    assert.equal((await page.evaluate(() => window.outcome)).error, 'NotAllowedError');
    consent = 1;
    const secureOptions = JSON.parse(registration.options.optionsJson);
    secureOptions.rp.id = 'example.test';
    const secure = await broker.run(owner, { ...registration.options, origin: 'https://login.example.test', optionsJson: JSON.stringify(secureOptions) }, new AbortController().signal);
    assert.ok(secure.responseJson, 'the broker also handles a delegated HTTPS origin without a TLS bypass');
    assert.equal(JSON.parse(Buffer.from(JSON.parse(secure.responseJson).response.clientDataJSON, 'base64url')).origin, 'https://login.example.test');
    secureOptions.rp.id = 'attacker.test';
    const spoofed = await broker.run(owner, { ...registration.options, origin: 'https://login.example.test', optionsJson: JSON.stringify(secureOptions) }, new AbortController().signal);
    assert.ok(spoofed.error, 'the local browser independently rejects an unrelated RP');
    const output = join(__dirname, '../../../artifacts/webauthn');
    await mkdir(output, { recursive: true });
    await writeFile(join(output, 'native-result.json'), JSON.stringify({ verified: true, registration: true, assertionSignature: true, originalOrigin: true, nativeCredential: true, cancellation: true, authenticator: 'test-only virtual', platform: process.platform }, null, 2));
    console.log('WebAuthn: remote Chromium → native broker → original page; registration, signed assertion and cancellation verified');
  } finally {
    dialog.showMessageBox = originalDialog;
    broker?.dispose(); owner?.destroy(); await relay?.destroy(); await context?.close(); app.quit();
  }
}
if (process.versions.electron) native().catch(error => { console.error(error); require('electron').app.exit(1); });
else parent().catch(error => { console.error(error); process.exitCode = 1; });
