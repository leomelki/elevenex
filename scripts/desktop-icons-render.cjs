// Tool-only Electron process. Never loaded by the application or its preload.
const { app, BrowserWindow } = require('electron');
const { mkdir, readFile, writeFile } = require('node:fs/promises');
const { dirname, join } = require('node:path');

let window;
void (async () => {
  const { root, source, temporary } = JSON.parse(await readFile(process.argv[2], 'utf8'));
  app.setPath('userData', temporary);
  await app.whenReady();
  app.dock?.hide();
  const { iconSvg, encodeIco, encodeIcns } = await import('./desktop-icons.mjs');
  // A non-persistent partition avoids disk-cache work outliving this short render.
  window = new BrowserWindow({ show: false, webPreferences: {
    sandbox: true, contextIsolation: true, nodeIntegration: false, partition: 'elevenex-icon-generator',
  } });
  await window.loadURL('data:text/html,' + encodeURIComponent('<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src data:">'));
  const outputs = [];
  const save = async (path, bytes) => {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), bytes);
    outputs.push(path);
  };
  const render = async (svg, size) => {
    const url = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
    const data = await window.webContents.executeJavaScript(`(async () => {
      const image = new Image(); image.src = ${JSON.stringify(url)}; await image.decode();
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = ${size};
      canvas.getContext('2d').drawImage(image, 0, 0, ${size}, ${size});
      return canvas.toDataURL('image/png').split(',')[1];
    })()`);
    return Buffer.from(data, 'base64');
  };
  const svg = iconSvg(source);
  const assets = 'apps/desktop/assets/icons';
  const publicIcons = 'apps/renderer/public/icons';
  await save(`${assets}/icon.svg`, svg);
  await save(`${publicIcons}/icon.svg`, svg);
  await save(`${publicIcons}/logo.svg`, source);
  const sizes = [16, 24, 32, 48, 64, 128, 256, 512, 1024];
  const pngs = new Map();
  for (const size of sizes) {
    const png = await render(svg, size);
    pngs.set(size, png);
    await save(`${assets}/png/${size}x${size}.png`, png);
  }
  await save(`${assets}/icon.png`, pngs.get(512));
  await save(`${assets}/icon.ico`, encodeIco(sizes.filter(size => size <= 256).map(size => ({ size, png: pngs.get(size) }))));
  await save(`${publicIcons}/favicon.ico`, encodeIco([16, 32, 48].map(size => ({ size, png: pngs.get(size) }))));
  await save(`${publicIcons}/apple-touch-icon.png`, await render(svg, 180));
  const icns = [
    ['icp4', 16], ['icp5', 32], ['icp6', 64], ['ic07', 128], ['ic08', 256], ['ic09', 512], ['ic10', 1024],
    ['ic11', 32], ['ic12', 64], ['ic13', 256], ['ic14', 512],
  ];
  await save(`${assets}/icon.icns`, encodeIcns(icns.map(([type, size]) => ({ type, png: pngs.get(size) }))));
  await save(`${assets}/trayTemplate.png`, await render(iconSvg(source, true), 22));
  await save(`${assets}/trayTemplate@2x.png`, await render(iconSvg(source, true), 44));
  await save(`${assets}/tray.png`, pngs.get(32));
  await save(`${assets}/tray@2x.png`, pngs.get(64));
  await writeFile(join(temporary, 'outputs.json'), JSON.stringify(outputs));
  window.destroy();
  app.quit();
})().catch(error => {
  console.error(error);
  if (window && !window.isDestroyed()) window.destroy();
  app.exit(1);
});
