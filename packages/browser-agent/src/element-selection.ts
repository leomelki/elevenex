import type { BrowserHumanElement } from '@elevenex/shared';
import { object, type BrowserAgentTarget } from './host.js';
import type { FrameLocator, Locator, Page } from 'playwright-core';

/** Hit testing can report the embedding target for an OOPIF. Also verify the
 * selected frame's document-owned DOM identity; navigation/replacement removes
 * its WeakRef even when the protocol anchor is an unchanged parent frame. */
export async function selectedBrowserElement(
  page: Page,
  selection: BrowserHumanElement,
): Promise<Locator> {
  let frame: Page | FrameLocator = page;
  for (const selector of selection.frames) frame = frame.frameLocator(selector);
  const locator = frame.locator(selection.selector);
  try {
    if (
      (await locator.count()) !== 1 ||
      !(await locator.evaluate(
        (element) => {
          const selected: unknown = Reflect.get(
            globalThis,
            Symbol.for('elevenex.user-selection'),
          );
          return selected instanceof WeakRef && selected.deref() === element;
        },
        undefined,
        { timeout: 1000 },
      ))
    )
      throw new Error('stale');
  } catch {
    throw new Error(
      'The selected frame navigated or its element changed; select the element again',
    );
  }
  return locator;
}

export function frameLoader(value: unknown, id: string): string | undefined {
  const raw = object(value),
    root = raw['frameTree'] ? object(raw['frameTree']) : raw;
  const frame = object(root['frame']);
  if (frame['id'] === id)
    return typeof frame['loaderId'] === 'string'
      ? frame['loaderId']
      : undefined;
  if (Array.isArray(root['childFrames']))
    for (const child of root['childFrames']) {
      const found = frameLoader(child, id);
      if (found) return found;
    }
  return undefined;
}
export async function validateBrowserSelection(
  target: BrowserAgentTarget,
  selection: BrowserHumanElement,
): Promise<void> {
  try {
    if (
      !selection.frameId ||
      !selection.loaderId ||
      frameLoader(
        await target.send('Page.getFrameTree', {}),
        selection.frameId,
      ) !== selection.loaderId
    )
      throw new Error('The selected frame navigated; select the element again');
  } finally {
    await target.dispose?.();
  }
}

/** Small, read-only hit identity sampled before starting an inspection worker.
 * No page text, attributes, values or pixels enter this fingerprint. */
export function selectionFingerprintExpression(x: number, y: number): string {
  return `(() => { const x=${JSON.stringify(x)}, y=${JSON.stringify(y)}; let node=document.elementFromPoint(x,y); while(node?.shadowRoot){const next=node.shadowRoot.elementFromPoint(x,y);if(!next||next===node)break;node=next;} if(!node)return null; const r=node.getBoundingClientRect(); return {tag:node.localName,x:r.x,y:r.y,width:r.width,height:r.height,viewportWidth:innerWidth,viewportHeight:innerHeight,scrollX,scrollY,dpr:devicePixelRatio}; })()`;
}
