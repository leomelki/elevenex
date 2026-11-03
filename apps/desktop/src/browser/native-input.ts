import { randomUUID } from 'node:crypto';
import type { WebContents } from 'electron';

/** Confirm our own trusted mouse delivery, never page content, text or field values. */
export async function nativeBrowserInput(contents: WebContents, dispatch: () => Promise<void>, assertCurrent: () => void, kind: 'click' | 'wheel'): Promise<boolean> {
  const token = randomUUID();
  try {
    assertCurrent();
    await contents.executeJavaScriptInIsolatedWorld(1003, [{ code: `(() => {
      globalThis.__elevenexInputReceipt?.remove();
      const receipt = { token: ${JSON.stringify(token)}, down: false, up: false, wheel: false, notify: () => {}, finish: undefined, remove: () => { window.removeEventListener('mousedown', down, true); window.removeEventListener('mouseup', up, true); window.removeEventListener('wheel', wheel, true); receipt.finish?.(false); } };
      const down = event => { if (event.isTrusted) receipt.down = true; receipt.notify(); };
      const up = event => { if (event.isTrusted) receipt.up = true; receipt.notify(); };
      const wheel = event => { if (event.isTrusted) receipt.wheel = true; receipt.notify(); };
      window.addEventListener('mousedown', down, true); window.addEventListener('mouseup', up, true); window.addEventListener('wheel', wheel, true);
      globalThis.__elevenexInputReceipt = receipt;
    })()` }]);
    assertCurrent(); await dispatch(); assertCurrent();
    const delivered: unknown = await contents.executeJavaScriptInIsolatedWorld(1003, [{ code: `new Promise(resolve => {
      const r = globalThis.__elevenexInputReceipt;
      const done = () => r?.token === ${JSON.stringify(token)} && (${JSON.stringify(kind)} === 'click' ? r.down === true && r.up === true : r.wheel === true);
      if (done()) { resolve(true); return; }
      if (!r || r.token !== ${JSON.stringify(token)}) { resolve(false); return; }
      const timer = setTimeout(() => r.finish(false), 500);
      r.finish = value => { clearTimeout(timer); r.notify = () => {}; resolve(value); };
      r.notify = () => { if (done()) r.finish(true); };
    })` }]);
    assertCurrent(); return delivered === true;
  } finally {
    if (!contents.isDestroyed()) void contents.executeJavaScriptInIsolatedWorld(1003, [{ code: `(() => {
      const r = globalThis.__elevenexInputReceipt;
      if (r?.token === ${JSON.stringify(token)}) { r.remove(); delete globalThis.__elevenexInputReceipt; }
    })()` }]).catch(() => undefined);
  }
}
