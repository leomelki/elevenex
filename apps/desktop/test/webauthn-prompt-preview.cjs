/* global __filename, __dirname, Response */
// Renders every phase of the WebAuthn sheet (PasskeyAsk) with the real document,
// controller and tokens, in light and dark, to PNGs under ignored artifacts/.
// Build first (`pnpm desktop:build`), then: node apps/desktop/test/webauthn-prompt-preview.cjs
const { spawn } = require('node:child_process');
const { mkdir, writeFile } = require('node:fs/promises');
const { join } = require('node:path');

async function parent() {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  await new Promise((resolve, reject) => {
    const child = spawn(require('electron'), [__filename], { env, stdio: 'inherit', timeout: 60000 });
    child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(new Error('Preview failed: ' + code)));
  });
}

async function preview() {
  const { app, BrowserWindow, nativeTheme, session } = require('electron');
  await app.whenReady();
  const { loadPromptAssets } = require('../dist/browser/webauthn-broker');
  const { promptDocument, promptBackground, PROMPT_WIDTH } = require('../dist/browser/webauthn-prompt-document');
  const { WebAuthnPrompt } = require('../dist/browser/webauthn-prompt');
  const views = require('../dist/browser/webauthn-prompt-view');
  const assets = await loadPromptAssets();
  if (!assets.tokens) throw new Error('dist/browser/tokens.css is missing; build the desktop app first');
  const profile = session.fromPartition('webauthn-prompt-preview', { cache: false });
  const current = promptDocument(assets, 'preview' + Date.now().toString(36));
  profile.protocol.handle('https', () => new Response(current.html, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': current.policy, 'Cache-Control': 'no-store' } }));
  const get = { id: 'preview', origin: 'https://accounts.example.com', operation: 'get' };
  const create = { ...get, origin: 'https://github.com', operation: 'create' };
  const accounts = [{ displayName: 'Léo Martin', name: 'leo@example.com' }, { displayName: 'Build bot', name: 'ci@example.com' }, { name: 'admin' }];
  const phases = {
    'confirm-sign-in': views.confirmView(get),
    'confirm-create': views.confirmView(create),
    'waiting': views.waitingView(get, 'other'),
    'waiting-windows': views.waitingView(get, 'win32'),
    'accounts': views.accountsView(get, accounts),
    'failed-timeout': views.failedView(get, 'NotAllowedError'),
    'failed-registered': views.failedView(create, 'InvalidStateError'),
  };
  const output = join(__dirname, '../../../artifacts/webauthn-prompt');
  await mkdir(output, { recursive: true });
  const report = { verified: true, captures: [] };
  try {
    // One window, as in a ceremony: each phase replaces the last. The theme
    // follows nativeTheme live, exactly as the sheet does in the app.
    const window = new BrowserWindow({ show: false, useContentSize: true, width: PROMPT_WIDTH, height: 240, webPreferences: { session: profile, sandbox: true, contextIsolation: true } });
    await window.loadURL('https://accounts.example.com/.elevenex-webauthn');
    const prompt = new WebAuthnPrompt(window);
    await prompt.install();
    for (const theme of ['light', 'dark']) {
      nativeTheme.themeSource = theme;
      window.setBackgroundColor(promptBackground(assets.tokens, theme === 'dark'));
      for (const [name, view] of Object.entries(phases)) {
        await prompt.render(view);
        await new Promise(resolve => setTimeout(resolve, 500));
        const focused = await window.webContents.executeJavaScript('document.activeElement?.id || document.activeElement?.className || ""');
        const image = await window.webContents.capturePage();
        const file = join(output, theme + '-' + name + '.png');
        await writeFile(file, image.toPNG());
        report.captures.push({ theme, name, file, size: window.getContentSize(), focused });
      }
    }
    window.destroy();
    await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2));
    console.log('WebAuthn sheet previews: ' + output);
  } finally { app.quit(); }
}
if (process.versions.electron) preview().catch(error => { console.error(error); require('electron').app.exit(1); });
else parent().catch(error => { console.error(error); process.exitCode = 1; });
