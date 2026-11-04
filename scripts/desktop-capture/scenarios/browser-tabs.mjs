import assert from 'node:assert/strict';

// Shared ViewTabs inside the real BrowserView, using only its isolated preview owner.
export default async function* (capture) {
  await capture.viewport(1100, 900);
  await capture.evaluate(() => document.querySelector('a[href="/machines"]').scrollIntoView());
  await capture.click('a[href="/machines"]');
  await capture.waitFor(() => document.querySelector('ex-browser-demo'));
  const root = 'ex-browser-demo';
  const owner = fn => capture.component(root, fn);
  const settled = async () => {
    await capture.waitFor(() => !document.querySelector('ex-browser-demo').getAnimations({ subtree: true })
      .some(animation => animation.playState === 'running' && Number.isFinite(animation.effect?.getComputedTiming().endTime)));
    await capture.settle();
  };
  const revealed = () => capture.waitFor(() => {
    const list = document.querySelector('ex-browser-demo [role="tablist"]');
    const tab = list.querySelector('[aria-selected="true"]')?.parentElement.getBoundingClientRect();
    const bounds = list.getBoundingClientRect();
    return !!tab && tab.left >= bounds.left - 1 && tab.right <= bounds.right + 1;
  });
  const state = () => capture.evaluate(() => {
    const root = document.querySelector('ex-browser-demo');
    const list = root.querySelector('[role="tablist"]');
    const selected = list.querySelector('[aria-selected="true"]');
    const bounds = list.getBoundingClientRect(), tab = selected?.parentElement.getBoundingClientRect();
    return {
      active: selected?.dataset.tabId, scroll: list.scrollLeft,
      visible: !!tab && tab.left >= bounds.left - 1 && tab.right <= bounds.right + 1,
      before: list.classList.contains('more-before'), after: list.classList.contains('more-after'),
      focused: document.activeElement?.getAttribute('aria-label'), documentScroll: document.scrollingElement.scrollTop,
      dividers: Array.from(list.children, shell => Number(getComputedStyle(shell, '::before').opacity)),
    };
  });
  for (const theme of ['light', 'dark']) {
    await capture.theme(theme);
    await capture.reducedMotion(false);
    await capture.evaluate(() => { document.querySelector('ex-browser-demo').style.width = '700px'; });
    await owner(component => {
      component.selectDriver('you');
      component.tabs.set(['App', 'Docs', 'Checkout', 'Logs', 'Settings'].map((title, i) => ({
        id: `tab-${i}`, title, url: 'localhost:3000', by: 'you',
      })));
      component.active.set('tab-2');
    });
    await settled();
    await capture.evaluate(() => document.querySelector('ex-browser-demo').scrollIntoView({ block: 'center' }));
    await capture.hover('ex-browser-demo .shop-header');
    let current = await state();
    assert.equal(current.before || current.after, false, 'Fitting tabs have no edge fades');
    assert.equal(current.dividers[1], .45, 'Idle neighbours have a divider');
    assert.equal(current.dividers[2], 0, 'No divider before selection');
    assert.equal(current.dividers[3], 0, 'No divider after selection');
    assert.equal(current.dividers[4], .45, 'Remaining idle neighbours retain their divider');
    yield { name: `${theme}-middle-selected`, selector: root, metadata: current };

    await capture.hover(`${root} [data-tab-id="tab-3"]`);
    await settled();
    current = await state();
    assert.equal(current.dividers[4], 0, 'Hover hides the adjacent divider under Angular CSS scoping');
    assert.equal(current.active, 'tab-2', 'Hover preserves selection');
    yield { name: `${theme}-middle-hover`, selector: root, metadata: current };

    await capture.evaluate(() => { document.querySelector('ex-browser-demo').style.width = '440px'; });
    for (let i = 0; i < 4; i++) {
      const before = await state();
      await capture.click(`${root} [aria-label="New browser tab (⌘T)"]`);
      await settled();
      await revealed();
      current = await state();
      assert.equal(current.documentScroll, before.documentScroll, 'Revelation leaves the document still');
      assert.equal(current.focused, 'New browser tab (⌘T)', 'Revelation does not steal focus');
    }
    assert.equal(current.before, true);
    assert.equal(current.after, false);
    yield { name: `${theme}-new-tab-visible`, selector: root, metadata: current };

    // A partly hidden current tab can be clicked to reveal it without changing selection.
    await capture.evaluate(() => document.querySelector('ex-browser-demo [role="tablist"]').dispatchEvent(
      new window.WheelEvent('wheel', { deltaY: -24, bubbles: true, cancelable: true })));
    const activeId = current.active;
    await capture.click(`${root} [data-tab-id="${activeId}"]`);
    await revealed();
    assert.equal((await state()).active, activeId);
    await capture.evaluate(() => document.querySelector('ex-browser-demo [role="tablist"]').dispatchEvent(
      new window.WheelEvent('wheel', { deltaY: -120, bubbles: true, cancelable: true })));
    await capture.evaluate(() => document.querySelector('ex-browser-demo [aria-selected="true"]').focus({ preventScroll: true }));
    await capture.press('End');
    await revealed();
    assert.equal((await state()).active, activeId, 'End reveals the last tab even when it is already selected');

    const browsedFrom = current.scroll;
    await capture.evaluate(() => document.querySelector('ex-browser-demo [role="tablist"]').dispatchEvent(
      new window.WheelEvent('wheel', { deltaY: -120, bubbles: true, cancelable: true })));
    await capture.settle();
    current = await state();
    assert.ok(current.scroll < browsedFrom, 'A vertical wheel browses horizontally');
    assert.equal(current.before && current.after, true, 'Both fades appear in the middle');
    const browsed = current.scroll, active = current.active;
    await owner(component => component.tabs.update(tabs => tabs.map(tab => ({ ...tab, title: `${tab.title} · updated` }))));
    assert.equal((await state()).scroll, browsed, 'Title updates preserve manual browsing');
    assert.equal((await state()).active, active, 'Browsing preserves selection');
    yield { name: `${theme}-browse-earlier`, selector: root, metadata: await state() };

    // Real horizontal trackpad input uses native scrolling, without selecting a tab.
    const point = await capture.evaluate(() => {
      const box = document.querySelector('ex-browser-demo [role="tablist"]').getBoundingClientRect();
      return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    });
    const beforeTrackpad = (await state()).scroll;
    await capture.cdp('Input.dispatchMouseEvent', { type: 'mouseWheel', ...point, deltaX: -60, deltaY: 0 });
    await capture.waitFor(before => document.querySelector('ex-browser-demo [role="tablist"]').scrollLeft < before, beforeTrackpad);
    assert.equal((await state()).active, active);

    await owner(component => component.active.set('tab-0'));
    await revealed();
    await capture.evaluate(() => document.querySelector('ex-browser-demo [data-tab-id="tab-0"]').focus({ preventScroll: true }));
    await capture.press('End');
    await revealed();
    await capture.press('Home');
    await revealed();
    assert.equal((await state()).active, 'tab-0');
    await capture.press('Delete');
    await settled();
    await revealed();
    assert.equal((await state()).active, 'tab-1');

    await capture.click(`${root} [aria-label="New browser tab (⌘T)"]`);
    await capture.evaluate(() => {
      for (const animation of document.querySelector('ex-browser-demo .tab-shell.on').getAnimations()) {
        animation.pause(); animation.currentTime = 140;
      }
    });
    await capture.settle();
    assert.equal((await state()).visible, true, 'Selection follows animated entry');
    yield { name: `${theme}-entering`, selector: root, metadata: await state() };
    await capture.click(`${root} [aria-label="New browser tab (⌘T)"]`);
    await capture.evaluate(() => {
      for (const animation of document.querySelector('ex-browser-demo').getAnimations({ subtree: true })) {
        if (Number.isFinite(animation.effect?.getComputedTiming().endTime)) animation.finish();
      }
    });
    await settled();
    await revealed();

    await capture.reducedMotion(true);
    await capture.evaluate(() => { document.querySelector('ex-browser-demo').style.width = '320px'; });
    await capture.click(`${root} [aria-label="New browser tab (⌘T)"]`);
    await settled();
    assert.equal((await state()).visible, true, 'New selection fits a narrow strip with reduced motion');
    yield { name: `${theme}-narrow-reduced-motion`, selector: root, metadata: await state() };

    await owner(component => { component.tabs.set([]); component.active.set(''); });
    await settled();
    current = await state();
    assert.equal(current.before || current.after, false, 'Empty strips have no fades');
    yield { name: `${theme}-empty`, selector: root, metadata: current };
  }
}
