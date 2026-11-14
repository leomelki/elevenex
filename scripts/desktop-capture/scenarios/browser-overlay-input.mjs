import assert from 'node:assert/strict';

/** Real browser layout owner and CDK tooltip/modal overlays. The preview records
 * layout receipts only; actual streamed pixels/input have browser-stream.mjs. */
export default async function* browserOverlayInput(capture) {
  await capture.evaluate(() => { location.href = '/task-browser'; });
  await capture.waitFor(() => document.querySelector('.start-page'));
  const clearReceipt = () => capture.component('ex-task-browser', component => { component.store.bridge.lastLayout = null; });
  const ready = value => capture.waitFor(expected => {
    const owner = globalThis.ng.getComponent(document.querySelector('ex-task-browser'));
    return owner.store.bridge.lastLayout?.inputReady === expected;
  }, value);
  for (const [theme, width] of [['light', 1100], ['dark', 520]]) {
    await capture.theme(theme); await capture.viewport(width, 800);
    await capture.reducedMotion(theme === 'dark');
    await capture.settle();
    await clearReceipt(); await ready(true);
    await capture.hover('[aria-label="More browser actions"]');
    await capture.waitFor(() => document.querySelector('[role="tooltip"]'));
    // Exercise a tooltip repositioned over the page, as can happen near a
    // window edge. Its entire CDK pane must remain informational and inert.
    await capture.evaluate(() => {
      const pane = document.querySelector('[role="tooltip"]').closest('.cdk-overlay-pane');
      const page = document.querySelector('.native-page').getBoundingClientRect(), box = pane.getBoundingClientRect();
      pane.style.translate = `${page.x + 12 - box.x}px ${page.y + 12 - box.y}px`;
    });
    await clearReceipt(); await ready(true);
    assert.equal(await capture.evaluate(() => {
      const pane = document.querySelector('[role="tooltip"]').closest('.cdk-overlay-pane'), box = pane.getBoundingClientRect();
      return getComputedStyle(pane).pointerEvents === 'none' && !document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)?.closest('.cdk-overlay-pane');
    }), true, 'Tooltip pixels cannot swallow gestures or disable the page');
    yield { name: `${theme}-tooltip-keeps-input`, inspect: ['[role="tooltip"]', '.native-page'], metadata: { inputReady: true } };
    await capture.hover('.native-page');
    await capture.waitFor(() => !document.querySelector('[role="tooltip"]'));
    await capture.click('[aria-label="More browser actions"]');
    await capture.waitFor(() => document.querySelector('[role="dialog"]'));
    await clearReceipt(); await ready(false);
    yield { name: `${theme}-dialog-blocks-input`, inspect: ['[role="dialog"]'], metadata: { inputReady: false } };
    await capture.press('Escape');
    await capture.waitFor(() => !document.querySelector('[role="dialog"]'));
    await clearReceipt(); await ready(true);
    assert.equal(await capture.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'More browser actions');
  }
}
