import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
const require = createRequire(new URL('../../apps/desktop/package.json', import.meta.url));

/** Capture real native child surfaces at their live bounds. Page.captureScreenshot
 * sees only the app renderer, so native WebContentsViews require a separate copy
 * of their actual pixels. No fixture HTML or synthetic product pixels are used. */
export async function captureWindowPixels(capture, params) {
  const { data } = await capture.cdp('Page.captureScreenshot', params);
  const children = capture.window.contentView.children.filter(view => view.webContents && view.webContents !== capture.window.webContents && !view.webContents.isDestroyed() && view.getVisible());
  if (!children.length) return { bytes: Buffer.from(data, 'base64'), surfaces: [] };
  const { nativeImage } = require('electron');
  const image = nativeImage.createFromBuffer(Buffer.from(data, 'base64'), { scaleFactor: 1 });
  const size = image.getSize(), bitmap = image.toBitmap(), clip = params.clip ?? { x: 0, y: 0, width: capture.options.width, height: capture.options.height };
  const scaleX = size.width / clip.width, scaleY = size.height / clip.height;
  const surfaces = [];
  for (const view of children) {
    const bounds = view.getBounds();
    const left = Math.round((bounds.x - clip.x) * scaleX), top = Math.round((bounds.y - clip.y) * scaleY);
    const width = Math.round(bounds.width * scaleX), height = Math.round(bounds.height * scaleY);
    if (!width || !height || left >= size.width || top >= size.height || left + width <= 0 || top + height <= 0) continue;
    let raw;
    // A newly attached view can have its DOM ready before Viz has submitted its
    // first compositor frame. Wait for actual pixels rather than capturing a blank.
    for (let attempt = 0; attempt < 30; attempt++) {
      try {
        await view.webContents.capturePage(undefined, { stayAwake: true });
        // The first copy wakes an occluded compositor but can contain its last
        // submitted frame. Await the child's next paint before retaining pixels.
        await Promise.race([
          view.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))'),
          delay(500),
        ]);
        raw = await view.webContents.capturePage(undefined, { stayAwake: true }); break;
      }
      catch (error) {
        if (attempt === 29) throw new Error(`Native surface ${view.webContents.id} could not capture: windowVisible=${capture.window.isVisible()} bounds=${JSON.stringify(bounds)} contentSize=${capture.window.getContentSize()} (${error})`, { cause: error });
        await delay(100);
      }
    }
    const normalized = nativeImage.createFromBuffer(raw.toPNG(), { scaleFactor: 1 }).resize({ width, height, quality: 'best' });
    const pixels = normalized.toBitmap();
    for (let y = Math.max(0, -top); y < Math.min(height, size.height - top); y++) {
      for (let x = Math.max(0, -left); x < Math.min(width, size.width - left); x++) {
        const source = (y * width + x) * 4, target = ((top + y) * size.width + left + x) * 4, alpha = pixels[source + 3];
        if (alpha === 255) pixels.copy(bitmap, target, source, source + 4);
        else if (alpha) {
          // Native bitmaps use premultiplied color channels.
          const inverse = 1 - alpha / 255;
          for (let channel = 0; channel < 3; channel++) bitmap[target + channel] = Math.round(pixels[source + channel] + bitmap[target + channel] * inverse);
          bitmap[target + 3] = Math.round(alpha + bitmap[target + 3] * inverse);
        }
      }
    }
    surfaces.push({ webContentsId: view.webContents.id, bounds });
  }
  return { bytes: nativeImage.createFromBitmap(bitmap, { width: size.width, height: size.height, scaleFactor: 1 }).toPNG(), surfaces };
}

import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Electron root screenshots omit WebContentsView children. Keep the real source
 * captures and compose them at registered native bounds. This is explicitly
 * surface evidence, not an OS-compositor screenshot or a replacement page mock. */
export async function captureNativeSurfaces(capture, config, stem, rootData) {
  const require = createRequire(join(config.root, 'apps/desktop/package.json'));
  const { nativeImage } = require('electron');
  const root = nativeImage.createFromDataURL('data:image/png;base64,' + rootData);
  const { width, height } = root.getSize();
  const bitmap = root.toBitmap({ scaleFactor: 1 });
  if (bitmap.length !== width * height * 4) throw new Error('Unexpected root bitmap scale');
  const views = capture.window.contentView.children.filter(view => view.webContents && view.getVisible());
  if (views.length > 16) throw new Error('Too many native surfaces for one checkpoint');
  const surfaces = [];
  for (const [index, view] of views.entries()) {
    const bounds = view.getBounds();
    if (bounds.x < 0 || bounds.y < 0 || bounds.width < 1 || bounds.height < 1 || bounds.x + bounds.width > width || bounds.y + bounds.height > height) throw new Error('Native surface escapes the trusted viewport');
    let captured;
    for (let attempt = 0; attempt < 5; attempt++) {
      try { captured = await view.webContents.capturePage(); break; }
      catch (error) { if (!String(error).includes('UnknownVizError') || attempt === 4) throw error; await delay(40); }
    }
    const image = captured.resize({ width: bounds.width, height: bounds.height, quality: 'best' });
    const source = image.toBitmap({ scaleFactor: 1 });
    if (source.length !== bounds.width * bounds.height * 4) throw new Error('Unexpected native bitmap scale');
    if (!capture.window.contentView.children.includes(view) || JSON.stringify(view.getBounds()) !== JSON.stringify(bounds)) throw new Error('Native surface changed during capture');
    const file = `${stem}-native-${index + 1}.png`;
    await writeFile(join(config.out, file), image.toPNG());
    surfaces.push({ file, bounds, contentsId: view.webContents.id });
    for (let y = 0; y < bounds.height; y++) {
      for (let x = 0; x < bounds.width; x++) {
        const from = (y * bounds.width + x) * 4, to = ((y + bounds.y) * width + x + bounds.x) * 4;
        const alpha = source[from + 3];
        if (alpha === 255) source.copy(bitmap, to, from, from + 4);
        else if (alpha > 0) {
          for (let channel = 0; channel < 3; channel++) bitmap[to + channel] = Math.min(255, source[from + channel] + Math.round(bitmap[to + channel] * (255 - alpha) / 255));
          bitmap[to + 3] = 255;
        }
      }
    }
  }
  const image = nativeImage.createFromBitmap(bitmap, { width, height, scaleFactor: 1 });
  await writeFile(join(config.out, `${stem}.png`), image.toPNG());
  return { method: 'electron-surface-composition', surfaces };
}
