import type { BrowserElement } from '@elevenex/shared';
import type { WebContents } from 'electron';
import { record } from './validation';

/** Fixed code in a separate world. Never returns text, values, IDs, URLs, attributes, source or pixels.
 * All text/image/log observation is withheld, including when no secret field is detected.
 * Cross-origin frames and editable controls are intentionally opaque. */
export async function elementAt(contents: WebContents, x: number, y: number): Promise<BrowserElement | null> {
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
  return { x: Number(left), y: Number(top), width: Number(width), height: Number(height), selector: raw['selector'], tag: raw['tag'] };
}
