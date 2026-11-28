import type { BrowserWindow } from 'electron';

const WM_NCLBUTTONDOWN = 0x00a1;
const HTCAPTION = 2;

export function observeTitleBarPress(window: BrowserWindow, pressed: () => void): void {
  if (process.platform !== 'win32') return;

  // Electron owns this hook for the window's lifetime. Observing the caption
  // message leaves Windows in charge of dragging, snapping and double-clicks.
  window.hookWindowMessage(WM_NCLBUTTONDOWN, hitTest => {
    if (hitTest.readUInt32LE() === HTCAPTION) pressed();
  });
}
