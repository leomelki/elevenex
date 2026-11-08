import type { BrowserContext } from 'playwright-core';
import { workflowLimit } from './runtime-workflows.js';

/** Chromium disk/network admission, including unknown content lengths and chunked responses. */
export async function installDownloadPolicy(context: BrowserContext, downloadPath: string): Promise<void> {
  const browser = context.browser();
  if (!browser) throw new Error('Download supervision unavailable');
  const cdp = await browser.newBrowserCDPSession();
  const pending = new Map<string, ReturnType<typeof setTimeout>>();
  const cancel = (guid: string) => { void cdp.send('Browser.cancelDownload', { guid }).catch(() => undefined); };
  cdp.on('Browser.downloadWillBegin', event => {
    if (pending.size >= 2) { cancel(event.guid); return; }
    const timer = setTimeout(() => cancel(event.guid), 120000);
    timer.unref(); pending.set(event.guid, timer);
  });
  cdp.on('Browser.downloadProgress', event => {
    if (event.receivedBytes > workflowLimit || event.totalBytes > workflowLimit) cancel(event.guid);
    if (event.state !== 'inProgress') { clearTimeout(pending.get(event.guid)); pending.delete(event.guid); }
  });
  await cdp.send('Browser.setDownloadBehavior', { behavior: 'allowAndName', downloadPath, eventsEnabled: true });
  context.once('close', () => { for (const timer of pending.values()) clearTimeout(timer); pending.clear(); void cdp.detach().catch(() => undefined); });
}
