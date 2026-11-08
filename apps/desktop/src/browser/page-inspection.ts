import type { BrowserElement } from '@elevenex/shared';
import type { WebContents } from 'electron';
import { record } from './validation';
import { detectBrowserSource } from '@elevenex/browser-inspection';

/** Fixed structural code in a separate world. Never returns text, values, IDs, URLs, attributes or pixels.
 * All text/image/log observation is withheld, including when no secret field is detected.
 * Cross-origin frames and editable controls are intentionally opaque. */
export async function elementAt(contents: WebContents, x: number, y: number, sourceCurrent?: () => boolean): Promise<BrowserElement | null> {
  const pageUrl = contents.getURL();
  const result: unknown = await contents.executeJavaScriptInIsolatedWorld(1001, [{ code: `(() => {
    const node = document.elementFromPoint(${JSON.stringify(x)}, ${JSON.stringify(y)});
    if (!node || node.closest('input,textarea,select,iframe,object,embed,[contenteditable]') || node.shadowRoot) return null;
    const known = new Set('a article aside b blockquote body button canvas caption code dd details div dl dt em fieldset figcaption figure footer form h1 h2 h3 h4 h5 h6 header hr html i img label legend li main nav ol p picture pre section small span strong summary svg table tbody td th thead tr ul video audio path g rect circle line polygon polyline ellipse text tspan'.split(' '));
    const safeTag = element => known.has(element.localName) ? element.localName : '*';
    const r = node.getBoundingClientRect();
    const parts = []; let el = node;
    while (el && el !== document.documentElement && parts.length < 20) {
      const tag = safeTag(el);
      parts.unshift(tag + ':nth-child(' + (Array.prototype.indexOf.call(el.parentElement?.children || [], el) + 1) + ')');
      el = el.parentElement;
    }
    if (el !== document.documentElement) return null;
    return {x:r.x,y:r.y,width:r.width,height:r.height,selector:'html > '+parts.join(' > '),tag:safeTag(node) === '*' ? 'element' : safeTag(node)};
  })()` }]);
  if (result === null) return null;
  const raw = record(result);
  if (typeof raw['selector'] !== 'string' || !/^html(?: > (?:[a-z][a-z0-9-]{0,40}|\*):nth-child\([1-9][0-9]*\)){1,20}$/.test(raw['selector']) || typeof raw['tag'] !== 'string' || !/^[a-z][a-z0-9-]{0,40}$/.test(raw['tag'])) return null;
  const { x: left, y: top, width, height } = raw;
  if ([left, top, width, height].some(v => typeof v !== 'number' || !Number.isFinite(v) || Math.abs(v) > 1_000_000)) return null;
  const element: BrowserElement = { x: Number(left), y: Number(top), width: Number(width), height: Number(height), selector: raw['selector'], tag: raw['tag'] };
  if (!sourceCurrent) return element;
  const current = () => !contents.isDestroyed() && contents.getURL() === pageUrl && sourceCurrent();
  const source = await detectBrowserSource(async expression => {
    if (!current()) return undefined;
    // MAIN world is necessary for Fiber; no preload, Node access or privileged binding is added.
    // The tab owns this debugger attachment and detaches it on destruction.
    if (!contents.debugger.isAttached()) contents.debugger.attach('1.3');
    const reply: unknown = await contents.debugger.sendCommand('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, timeout: 900 });
    return record(record(reply)['result'])['value'];
  }, element.selector, pageUrl, current);
  return source && current() ? { ...element, source } : element;
}
