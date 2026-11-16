import { captureElementSnapshot } from './element-snapshot.js';
import { randomUUID } from 'node:crypto';
import { chromium, type Frame } from 'playwright-core';
import type { BrowserHumanElement } from '@elevenex/shared';
import { selectedBrowserElement, frameLoader, selectionFingerprintExpression } from './element-selection.js';
import { PlaywrightTransport } from './playwright-transport.js';
import { object, type BrowserAgentTarget } from './host.js';

export async function validatePickedBrowserElement(
  target: BrowserAgentTarget,
  selection: BrowserHumanElement,
  current: () => boolean,
  version = '140.0.0.0',
): Promise<void> {
  const transport = new PlaywrightTransport(
    {
      version: () => Promise.resolve(version),
      list: () => [{ id: target.id, owned: current() }],
      get: () => Promise.resolve(target),
      open: () => Promise.reject(new Error('Inspection cannot create pages')),
    },
    1,
  );
  const browser = await chromium.connectOverCDP(transport, {
    noDefaults: true,
    timeout: 10000,
  });
  try {
    const page = browser.contexts()[0]?.pages()[0];
    if (!page || !current()) throw new Error('Selection changed');
    await selectedBrowserElement(page, selection);
    if (!current()) throw new Error('Selection changed');
  } finally {
    transport.close();
    await browser.close().catch(() => undefined);
  }
}

const POINT = String.raw`({x,y,marker}) => {
  let node=document.elementFromPoint(x,y);
  while(node?.shadowRoot){const next=node.shadowRoot.elementFromPoint(x,y);if(!next||next===node)break;node=next;}
  if(!node)return null;
  const previous=globalThis[Symbol.for('elevenex.user-selection')]?.deref?.();
  previous?.removeAttribute('data-elevenex-picked');
  node.setAttribute('data-elevenex-picked',marker);
  globalThis[Symbol.for('elevenex.user-selection')]=new WeakRef(node);
  const r=node.getBoundingClientRect();
  return {selector:'css=[data-elevenex-picked="'+marker+'"]',tag:node.localName,x:r.x,y:r.y,width:r.width,height:r.height,borderX:node.clientLeft,borderY:node.clientTop,offsetWidth:node.offsetWidth,offsetHeight:node.offsetHeight,transform:getComputedStyle(node).transform};
}`;

/** Main-only inspection, created by an explicit human selection gesture. No
 * agent can request this privileged connection or read field values through it. */
export async function pickBrowserElement(
  target: BrowserAgentTarget,
  x: number,
  y: number,
  documentId: string,
  current: () => boolean,
  version = '140.0.0.0',
  capture = true,
  fingerprint?: unknown,
): Promise<BrowserHumanElement> {
  const transport = new PlaywrightTransport(
    {
      version: () => Promise.resolve(version),
      list: () => [{ id: target.id, owned: current() }],
      get: () => Promise.resolve(target),
      open: () => Promise.reject(new Error('Inspection cannot create pages')),
    },
    1,
  );
  const browser = await chromium.connectOverCDP(transport, {
    noDefaults: true,
    timeout: 10000,
  });
  try {
    if (!current()) throw new Error('Element request changed');
    const page = browser.contexts()[0]?.pages()[0];
    if (!page) throw new Error('Inspection page unavailable');
    if (fingerprint !== undefined) {
      const actual = object(await page.evaluate(selectionFingerprintExpression(x, y))), expected = object(fingerprint);
      // Native CDP may reorder object keys while relaying values.
      if (Object.keys(actual).length !== Object.keys(expected).length || Object.keys(expected).some(key => actual[key] !== expected[key])) throw new Error('The page moved before selection; pick the element again');
    }
    let frame: Frame = page.mainFrame(),
      localX = x,
      localY = y;
    const marker = randomUUID();
    const frames: string[] = [];
    let picked: Record<string, unknown> | null = null;
    for (let depth = 0; depth < 16; depth++) {
      if (!current()) throw new Error('Element request changed');
      const result: unknown = await frame.evaluate(
        `(${POINT})(${JSON.stringify({ x: localX, y: localY, marker })})`,
      );
      if (!result) throw new Error('No element at that point');
      picked = object(result);
      if (picked['tag'] !== 'iframe' && picked['tag'] !== 'frame') break;
      if (
        typeof picked['transform'] === 'string' &&
        picked['transform'] !== 'none' &&
        !/^matrix\([^,]+, 0, 0,/u.test(picked['transform'])
      )
        throw new Error('Select an element in an unrotated frame');
      const selector = String(picked['selector']),
        handle = await frame.locator(selector).elementHandle();
      const child = await handle?.contentFrame(),
        box = await handle?.boundingBox();
      await handle?.dispose();
      if (!child || !box) break;
      const scaleX = box.width / Number(picked['offsetWidth'] || box.width),
        scaleY = box.height / Number(picked['offsetHeight'] || box.height);
      localX = (x - box.x) / scaleX - Number(picked['borderX'] ?? 0);
      localY = (y - box.y) / scaleY - Number(picked['borderY'] ?? 0);
      frames.push(selector);
      frame = child;
    }
    if (
      !picked ||
      !current() ||
      typeof picked['selector'] !== 'string' ||
      picked['selector'].length > 2048 ||
      (typeof picked['tag'] !== 'string' || picked['tag'].length > 64)
    )
      throw new Error('Element selection is stale or too deep');
    const hit = object(
      await target.send('DOM.getNodeForLocation', {
        x: Math.round(x),
        y: Math.round(y),
        includeUserAgentShadowDOM: true,
      }),
    );
    const tree = await target.send('Page.getFrameTree', {});
    const frameId =
      typeof hit['frameId'] === 'string' ? hit['frameId'] : undefined;
    const loaderId = frameId ? frameLoader(tree, frameId) : undefined;
    if (!frameId || !loaderId)
      throw new Error('Cannot establish the selected document identity');
    const locator = frame.locator(picked['selector']);
    const snapshot = capture ? await captureElementSnapshot(page, locator, { selector: picked['selector'], tag: picked['tag'], frames, documentId }, target.id, { x, y }, current, target) : undefined;
    if (!current() || frameLoader(await target.send('Page.getFrameTree', {}), frameId) !== loaderId) throw new Error('Selected document changed during capture');
    return {
      ...(snapshot ? { snapshot } : {}),
      selector: picked['selector'],
      tag: picked['tag'],
      frames,
      ...(snapshot?.reference.target ?? { x, y, width: Number(picked['width']), height: Number(picked['height']) }),
      documentId,
      frameId,
      loaderId,
    };
  } finally {
    transport.close();
    await browser.close().catch(() => undefined);
  }
}
