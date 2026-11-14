import type { Locator, Page } from 'playwright-core';
import type { BrowserAgentHighlight, BrowserPresentationCommand } from '@elevenex/shared';
import { object } from './host.js';
import { browserPresentationCommand } from './presentation.js';

/** Resolve decoration against the real page viewport. This never clicks,
 * scrolls, injects markup or waits for decorative animation to finish. */
export async function browserCursorCommand(page: Page, target: { locator: Locator } | { point: unknown }, rawOptions: unknown): Promise<BrowserPresentationCommand> {
  const options = object(rawOptions);
  if (Object.keys(options).some(key => !['highlight', 'pulse', 'label'].includes(key)) ||
      (options['highlight'] !== undefined && typeof options['highlight'] !== 'boolean') ||
      (options['pulse'] !== undefined && typeof options['pulse'] !== 'boolean') ||
      (options['label'] !== undefined && (typeof options['label'] !== 'string' || options['label'].length > 120)))
    throw new Error('Unsupported browser cursor options');
  const viewport = await page.evaluate<{ width: number; height: number }>('({width:innerWidth,height:innerHeight})');
  let point: { x: number; y: number }, highlight: BrowserAgentHighlight | undefined;
  if ('locator' in target) {
    const box = await target.locator.boundingBox();
    if (!box) throw new Error('Cursor target is hidden or detached');
    const left = Math.max(0, box.x), top = Math.max(0, box.y), right = Math.min(viewport.width, box.x + box.width), bottom = Math.min(viewport.height, box.y + box.height);
    if (right <= left || bottom <= top) throw new Error('Cursor target is outside the viewport. Scroll it into view first.');
    point = { x: (left + right) / 2, y: (top + bottom) / 2 };
    if (options['highlight'] === true) highlight = { x: left, y: top, width: right - left, height: bottom - top, ...(typeof options['label'] === 'string' ? { label: options['label'] } : {}) };
  } else {
    const raw = object(target.point);
    if (Object.keys(raw).some(key => key !== 'x' && key !== 'y') || typeof raw['x'] !== 'number' || typeof raw['y'] !== 'number') throw new Error('Cursor position requires numeric x and y');
    point = { x: raw['x'], y: raw['y'] };
    if (options['highlight'] === true) throw new Error('Highlight requires a locator');
  }
  if (point.x >= viewport.width || point.y >= viewport.height) throw new Error('Cursor position is outside the viewport');
  return browserPresentationCommand({ kind: 'cursor', point, ...(highlight ? { highlight } : {}), ...(options['pulse'] === undefined ? {} : { pulse: options['pulse'] }) });
}
