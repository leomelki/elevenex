import type { BrowserContext } from 'playwright-core';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RuntimeBrowserPool } from './runtime-browser-pool.js';
import { RuntimeBrowserCapture } from './runtime-capture.js';

jest.setTimeout(90000);

// Real headless pixels: mocked CDP cannot detect that screenshot clipping changes
// the compositor viewport or returns white document-origin pixels after scrolling.
it('keeps a scrolled viewport stable through idle refreshes at both pixel densities', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'elevenex-capture-regression-'));
  const previous = process.env['ELEVENEX_DATA_ROOT'];
  process.env['ELEVENEX_DATA_ROOT'] = directory;
  const pool = new RuntimeBrowserPool();
  let context: BrowserContext | undefined;
  try {
    context = await pool.acquire('a'.repeat(64), {});
    const page = await context.newPage();
    await page.setViewportSize({ width: 440, height: 800 });
    await page.setContent(`<!doctype html><style>body{margin:0}section{height:1600px;background:rgb(20,200,40)}
      section:first-child{background:rgb(20,40,200)}</style><section></section><section></section>`);
    const cdp = await context.newCDPSession(page);
    for (const pixelRatio of [1, 2]) {
      await cdp.send('Emulation.setDeviceMetricsOverride', { width: 440, height: 800, deviceScaleFactor: pixelRatio, mobile: false });
      await page.evaluate(() => scrollTo(0, 1800));
      await page.waitForFunction(() => scrollY === 1800);
      // Wait for the compositor, not only the synchronous scroll offset.
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      const state = { width: 440, height: 800, pixelRatio, displayEpoch: pixelRatio, visible: true, ready: true };
      const capture = new RuntimeBrowserCapture(() => state);
      capture.attach(cdp);
      const input = new AbortController();
      let after = 0, received = 0;
      const commands = jest.spyOn(cdp, 'send');
      try {
        const deadline = Date.now() + 2600; // More than two former screenshot watchdog periods.
        while (Date.now() < deadline) {
          const frame = await capture.next(after, input.signal, 400, { width: 396, height: 720, fps: 30 });
          if (!frame) continue;
          after = frame.sequence;
          received++;
          const sample = await page.evaluate(async jpeg => {
            const bitmap = await createImageBitmap(new Blob([new Uint8Array(jpeg)], { type: 'image/jpeg' }));
            try {
              const canvas = document.createElement('canvas');
              canvas.width = bitmap.width; canvas.height = bitmap.height;
              const ctx = canvas.getContext('2d')!;
              ctx.drawImage(bitmap, 0, 0);
              return { width: bitmap.width, height: bitmap.height, pixel: [...ctx.getImageData(bitmap.width / 2, bitmap.height / 2, 1, 1).data] };
            } finally { bitmap.close(); }
          }, [...frame.jpeg]);
          expect(sample.width).toBeLessThanOrEqual(396);
          expect(sample.height).toBeLessThanOrEqual(720);
          expect(sample.pixel[1]).toBeGreaterThan(150);
          expect(sample.pixel[0]).toBeLessThan(60);
          expect(sample.pixel[2]).toBeLessThan(80);
        }
        expect(received).toBeGreaterThan(0);
        expect(commands.mock.calls.filter(([method]) => method === 'Page.startScreencast').length).toBeGreaterThanOrEqual(2);
        expect(commands.mock.calls.some(([method]) => method === 'Page.captureScreenshot')).toBe(false);
        expect(await page.evaluate(() => scrollY)).toBe(1800);
        expect(await page.evaluate(() => ({ width: innerWidth, height: innerHeight }))).toEqual({ width: 440, height: 800 });
      } finally { input.abort(); capture.detach(); await capture.stop(); commands.mockRestore(); }
    }
    await cdp.detach();
  } finally {
    await context?.close();
    await pool.onModuleDestroy();
    if (previous === undefined) delete process.env['ELEVENEX_DATA_ROOT'];
    else process.env['ELEVENEX_DATA_ROOT'] = previous;
    await rm(directory, { recursive: true, force: true });
  }
});
