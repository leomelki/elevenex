import { randomUUID } from 'node:crypto';
import type { BrowserHumanElement, BrowserRect } from '@elevenex/shared';
import { object, type BrowserAgentTarget } from './host.js';
import { captureSnapshot, type SnapshotViewport } from './element-snapshot.js';
import { frameLoader } from './element-selection.js';

const SAMPLE = String.raw`node => {
  if (!node?.isConnected) return null;
  const r=node.getBoundingClientRect();
  return {tag:node.localName,box:{x:r.x,y:r.y,width:r.width,height:r.height},
    viewport:{width:innerWidth,height:innerHeight,scrollX,scrollY,dpr:devicePixelRatio,scale:visualViewport?.scale,x:visualViewport?.offsetLeft,y:visualViewport?.offsetTop}};
}`;
function sample(value: unknown): { tag: string; box: BrowserRect; viewport: SnapshotViewport } {
  const raw = object(value), box = object(raw['box']), viewport = object(raw['viewport']);
  const number = (row: Record<string, unknown>, key: string): number => {
    const n = row[key];
    if (typeof n !== 'number' || !Number.isFinite(n) || Math.abs(n) > 1_000_000) throw new Error('Invalid picker geometry');
    return n;
  };
  if (typeof raw['tag'] !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(raw['tag'])) throw new Error('Invalid picker element');
  return {
    tag: raw['tag'],
    box: { x: number(box, 'x'), y: number(box, 'y'), width: number(box, 'width'), height: number(box, 'height') },
    viewport: { width: number(viewport, 'width'), height: number(viewport, 'height'), scrollX: number(viewport, 'scrollX'), scrollY: number(viewport, 'scrollY'), dpr: number(viewport, 'dpr'), scale: number(viewport, 'scale'), x: number(viewport, 'x'), y: number(viewport, 'y') },
  };
}

/** Common main-document/open-shadow selection needs no Playwright connection or
 * worker startup. Framed picks retain the existing worker path. The live marker,
 * document loader, geometry and screenshot guards are shared with that path. */
export async function pickBrowserElementDirect(
  target: BrowserAgentTarget, x: number, y: number, documentId: string, current: () => boolean,
): Promise<BrowserHumanElement | undefined> {
  const evaluate = async (expression: string): Promise<unknown> => {
    if (!current()) throw new Error('Element selection changed');
    const reply = object(await target.send('Runtime.evaluate', { expression, returnByValue: true, timeout: 1000 }));
    if (reply['exceptionDetails'] || !current()) throw new Error('Page changed during selection');
    return object(reply['result'])['value'];
  };
  const marker = randomUUID();
  const selected = 'globalThis[Symbol.for("elevenex.user-selection")]?.deref?.()';
  const initial = await evaluate(`(() => {
    let node=document.elementFromPoint(${JSON.stringify(x)},${JSON.stringify(y)});
    while(node?.shadowRoot){const next=node.shadowRoot.elementFromPoint(${JSON.stringify(x)},${JSON.stringify(y)});if(!next||next===node)break;node=next;}
    if(!node || node.localName==='iframe' || node.localName==='frame')return null;
    const previous=${selected}; previous?.removeAttribute('data-elevenex-picked');
    node.setAttribute('data-elevenex-picked',${JSON.stringify(marker)});
    globalThis[Symbol.for('elevenex.user-selection')]=new WeakRef(node);
    const editable=!!node.closest('input,textarea,select,[contenteditable]');
    const label=String(node.getAttribute('aria-label')||(editable?node.getAttribute('placeholder'):node.textContent)||'').replace(/[\\x00-\\x1f]/g,' ').replace(/\\s+/g,' ').trim().slice(0,110);
    return {...(${SAMPLE})(node),label,page:location.origin+location.pathname};
  })()`);
  if (initial === null) return undefined;
  const raw = object(initial);
  let latest = sample(raw), first = true;
  if (typeof raw['page'] !== 'string' || raw['page'].length > 2048 || typeof raw['label'] !== 'string' || raw['label'].length > 110) throw new Error('Invalid picker metadata');
  const page = raw['page'], label = raw['label'];
  const tree = object(await target.send('Page.getFrameTree', {}));
  const frame = object(object(tree['frameTree'])['frame']), frameId = frame['id'];
  const loaderId = typeof frameId === 'string' ? frameLoader(tree, frameId) : undefined;
  if (typeof frameId !== 'string' || !loaderId) throw new Error('Selected document unavailable');
  const selection = { selector: `css=[data-elevenex-picked="${marker}"]`, tag: latest.tag, frames: [], documentId };
  const snapshot = await captureSnapshot({
    viewport: async () => {
      if (first) first = false;
      else latest = sample(await evaluate(`(${SAMPLE})(${selected})`));
      return latest.viewport;
    },
    box: () => Promise.resolve(latest.box), label: () => Promise.resolve(label), url: () => page,
  }, selection, target.id, { x, y }, current, target);
  if (!current() || frameLoader(await target.send('Page.getFrameTree', {}), frameId) !== loaderId) throw new Error('Selected document changed');
  return { ...selection, ...snapshot.reference.target, frameId, loaderId, snapshot };
}
