// A private Electron target. Its own DOM and the returned video change together
// so the viewer test can distinguish lost input from a missing decoded frame.
const { app, BrowserWindow } = require('electron');
const { join } = require('node:path');

app.setPath('userData', join(process.env.ELEVENEX_TASK_APP_RUNTIME_DIR, 'fixture-profile'));
let window;
app.whenReady().then(async () => {
  window = new BrowserWindow({
    x: 0, y: 0, width: 900, height: 650, frame: false,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  const html = '<body style="margin:0"><input autofocus aria-label="Entry" style="box-sizing:border-box;width:100vw;height:100vh"></body>';
  await window.loadURL('data:text/html,' + encodeURIComponent(html));
  await window.webContents.executeJavaScript(`document.querySelector('input').addEventListener('input', event => {
    document.title = 'fixture-text-' + event.target.value;
    event.target.style.backgroundColor = event.target.value.length % 2 ? 'black' : 'white';
  })`);
  window.on('page-title-updated', (_event, title) => console.log(title));
  window.focus();
  console.log('fixture-ready');
});
