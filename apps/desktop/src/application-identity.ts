import { app, Menu, nativeImage, Tray } from 'electron';
import { join } from 'node:path';

// Included inside app.asar, at the same relative location as in development.
export const applicationIcon = join(__dirname, '../assets/icons/icon.png');

/** Application owns the tray; callers release it on failure and before quitting. */
export function installApplicationIdentity(showWindow: () => void, newWindow: () => void): () => void {
  app.setAppUserModelId('app.elevenex.desktop');
  if (process.platform === 'darwin' && !app.isPackaged) app.dock?.setIcon(applicationIcon);
  const image = nativeImage.createFromPath(join(__dirname, '../assets/icons',
    process.platform === 'darwin' ? 'trayTemplate.png' : 'tray.png'));
  if (image.isEmpty()) throw new Error('Desktop tray icon is missing. Run pnpm desktop:icons.');
  image.setTemplateImage(process.platform === 'darwin');
  const tray = new Tray(image);
  tray.setToolTip('Elevenex');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Show Elevenex', click: showWindow },
    { label: 'New Window', click: newWindow },
    { type: 'separator' },
    { label: 'Quit Elevenex', click: () => app.quit() },
  ]));
  tray.on('click', showWindow);
  return () => { tray.removeAllListeners(); tray.destroy(); };
}
