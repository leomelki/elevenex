import assert from 'node:assert/strict';

// Production TerminalView/ViewTabs through their existing preview owner.
export default async function* (capture) {
  await capture.viewport(1100, 900);
  await capture.evaluate(() => document.querySelector('a[href="/machines"]').scrollIntoView());
  await capture.click('a[href="/machines"]');
  await capture.waitFor(() => document.querySelector('ex-machines-views-demo ex-terminal-view'));
  const owner = fn => capture.component('ex-machines-views-demo', fn);
  const root = 'ex-terminal-view';
  const settled = async () => {
    await capture.waitFor(() => !document.querySelector('ex-terminal-view').getAnimations({ subtree: true })
      .some(animation => animation.playState === 'running' && Number.isFinite(animation.effect?.getComputedTiming().endTime)));
    await capture.settle();
  };
  const state = () => capture.evaluate(() => {
    const root = document.querySelector('ex-terminal-view');
    const list = root.querySelector('[role="tablist"]');
    const selected = root.querySelector('[role="tab"][aria-selected="true"]');
    const bounds = list.getBoundingClientRect(), tab = selected?.parentElement.getBoundingClientRect();
    const button = selector => {
      const control = root.querySelector(selector);
      return control ? { disabled: control.disabled, label: control.getAttribute('aria-label') } : null;
    };
    return {
      active: selected?.dataset.tabId, scroll: list.scrollLeft,
      strip: { left: bounds.left, right: bounds.right, width: bounds.width },
      tab: tab ? { left: tab.left, right: tab.right, width: tab.width } : null,
      visible: !!tab && tab.left >= bounds.left - 1 && tab.right <= bounds.right + 1,
      previous: button('.scroll.previous'), next: button('.scroll.next'),
      focused: document.activeElement?.getAttribute('aria-label'),
      documentScroll: document.scrollingElement.scrollTop,
    };
  });
  for (const theme of ['light', 'dark']) {
    await capture.theme(theme);
    await capture.reducedMotion(false);
    await capture.evaluate(() => { document.querySelector('.terminal-demo').style.width = '440px'; });
    await owner(component => {
      component.terminalTabs.set([{ id: 'one', title: 'Shell 1', status: 'idle' }]);
      component.terminalActive.set('one');
    });
    await settled();
    await capture.evaluate(() => document.querySelector('ex-terminal-view').scrollIntoView({ block: 'center' }));
    assert.equal((await state()).previous, null, 'No overflow controls for a fitting tab');
    for (let index = 0; index < 7; index++) {
      const before = await state();
      await capture.click(`${root} [aria-label="New terminal (⌘T)"]`);
      await settled();
      const after = await state();
      assert.equal(after.visible, true, 'Every newly selected terminal is fully visible after entry');
      assert.equal(after.documentScroll, before.documentScroll, 'Tab revelation leaves ancestors still');
      assert.equal(after.focused, 'New terminal (⌘T)', 'Revelation does not move keyboard focus');
    }
    let current = await state();
    assert.ok(current.scroll > 0);
    assert.equal(current.previous.disabled, false);
    assert.equal(current.next.disabled, true);
    yield { name: `${theme}-new-terminal-visible`, selector: root, metadata: current };

    const active = current.active;
    await capture.click(`${root} .scroll.previous`);
    await capture.settle();
    current = await state();
    assert.equal(current.active, active, 'Browsing does not change selection');
    assert.equal(current.next.disabled, false, 'Hidden later tabs remain discoverable');
    const browsed = current.scroll;
    await owner(component => component.terminalTabs.update(tabs => tabs.map(tab => ({ ...tab }))));
    assert.equal((await state()).scroll, browsed, 'Metadata refresh preserves manual browsing');
    yield { name: `${theme}-browse-earlier`, selector: root, metadata: current };

    await owner(component => component.terminalActive.set('one'));
    await capture.evaluate(() => document.querySelector('ex-terminal-view [data-tab-id="one"]').focus({ preventScroll: true }));
    await capture.press('End');
    await capture.settle();
    assert.equal((await state()).visible, true, 'End reveals and focuses the last terminal');
    await capture.press('Home');
    await capture.settle();
    assert.equal((await state()).active, 'one');
    assert.equal((await state()).visible, true);
    await capture.press('Delete');
    await settled();
    assert.equal((await state()).visible, true, 'Closing reveals the selected neighbour');

    await capture.click(`${root} [aria-label="New terminal (⌘T)"]`);
    await capture.evaluate(() => {
      for (const animation of document.querySelector('ex-terminal-view .tab-shell.on').getAnimations()) {
        animation.pause();
        animation.currentTime = 140;
      }
    });
    await capture.settle();
    assert.equal((await state()).visible, true, 'Selection follows a tab during entry');
    yield { name: `${theme}-entering`, selector: root, metadata: await state() };
    await capture.click(`${root} [aria-label="New terminal (⌘T)"]`);
    await capture.evaluate(() => {
      for (const animation of document.querySelector('ex-terminal-view').getAnimations({ subtree: true })) {
        if (Number.isFinite(animation.effect?.getComputedTiming().endTime)) animation.finish();
      }
    });
    await settled();
    assert.equal((await state()).visible, true, 'A second creation interrupts revelation safely');

    await capture.reducedMotion(true);
    await capture.evaluate(() => { document.querySelector('.terminal-demo').style.width = '320px'; });
    await capture.click(`${root} [aria-label="New terminal (⌘T)"]`);
    await settled();
    const narrow = await state();
    assert.equal(narrow.visible, true, `New selection fits a narrow reduced-motion strip: ${JSON.stringify(narrow)}`);
    yield { name: `${theme}-narrow-reduced-motion`, selector: root, metadata: await state() };

    await owner(component => { component.terminalTabs.set([]); component.terminalActive.set(''); });
    await settled();
    assert.equal((await state()).previous, null, 'Empty strips remove overflow controls');
    yield { name: `${theme}-empty`, selector: root };
  }
}
