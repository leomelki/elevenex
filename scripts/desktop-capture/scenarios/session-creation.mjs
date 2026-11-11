import assert from 'node:assert/strict';

/** Local creation, trusted typing and durable handoff through the production owners. */
export default async function* (capture) {
  await capture.evaluate(() => { location.href = '/connected-workspace'; });
  await capture.waitFor(() => document.querySelector('ex-workspace-navigation ex-task-list'));
  const task = '[data-task-id="11"]';
  const add = `${task} header .add button`;
  const textarea = 'ex-session-chat ex-composer textarea';
  const inspect = [task, 'ex-session-chat', '.start', '.creation-feedback', 'ex-composer', textarea];
  const finish = async () => {
    await capture.evaluate(() => { for (const a of document.getAnimations()) if (Number.isFinite(a.effect?.getComputedTiming().endTime)) a.finish(); });
    await capture.settle();
  };
  for (const theme of ['light', 'dark']) {
    await capture.theme(theme); await capture.viewport(1440, 960); await capture.reducedMotion(false);
    await capture.component('ex-machine-workspace', c => c.store.selectSession({ taskId: '11', sessionId: '101' }));
    await capture.component('ex-connected-workspace-demo', c => c.fixture.holdSessionCreation(true));
    await capture.component('ex-machine-workspace', c => { c.panelOpen.set(true); c.wideReview.set(true); });
    await finish();
    await capture.click(add);
    await capture.waitFor(() => document.querySelector('ex-session-chat .start h1'));
    assert.equal(await capture.evaluate(() => document.activeElement.matches('ex-composer textarea')), true, 'Typing is focused before the create reply');
    assert.equal(await capture.component('ex-machine-workspace', c => c.wideReview()), false, 'New session reveals a composer covered by an expanded panel');
    await capture.component('ex-machine-workspace', c => c.closePanel()); await finish();
    await capture.fill(textarea, 'Investigate the retry path while the session gets ready.');
    await capture.evaluate(() => {
      document.querySelector('ex-session-chat').dataset.retained = 'chat';
      document.querySelector('ex-composer textarea').dataset.retained = 'draft';
      document.querySelector('[data-session-id^="starting-"]').dataset.retained = 'row';
    });
    await capture.press('ArrowLeft'); await capture.press('ArrowLeft');
    const caret = await capture.evaluate(() => document.querySelector('ex-composer textarea').selectionStart);
    const before = await capture.inspect([textarea]);
    await capture.press('Enter');
    assert.equal(await capture.evaluate(() => document.querySelector('ex-composer textarea').value), 'Investigate the retry path while the session gets ready.', 'Enter cannot send or erase a pending draft');
    yield { name: `${theme}-instant-typing`, inspect, metadata: { before } };
    await capture.component('ex-machine-workspace', c => { void c.store.createSession('11'); });
    assert.equal(await capture.evaluate(() => document.querySelectorAll('[data-session-id^="starting-"]').length), 1, 'Repeated creation stays on one local draft');
    await capture.component('ex-connected-workspace-demo', c => c.fixture.finishSessionCreation(11));
    await capture.waitFor(() => !document.querySelector('[data-session-id^="starting-"]') && !document.querySelector('.start p')?.textContent.includes('Getting your agent ready'));
    await finish();
    const retained = await capture.evaluate(() => {
      const draft = document.querySelector('ex-composer textarea');
      return { chat: document.querySelector('ex-session-chat').dataset.retained, draft: draft.dataset.retained,
        row: document.querySelector('[data-retained="row"]')?.getAttribute('data-session-id'), text: draft.value,
        focus: document.activeElement === draft, disabled: document.querySelector('ex-composer .send').disabled };
    });
    assert.equal(retained.chat, 'chat'); assert.equal(retained.draft, 'draft'); assert.ok(retained.row && !retained.row.startsWith('starting-'));
    assert.equal(await capture.evaluate(() => document.querySelector('ex-composer textarea').selectionStart), caret, 'The receipt preserves the caret');
    const after = await capture.inspect([textarea]);
    assert.equal(after.elements[textarea][0].rect.y, before.elements[textarea][0].rect.y, 'Typing does not move when the session becomes ready');
    assert.equal(retained.text, 'Investigate the retry path while the session gets ready.'); assert.equal(retained.focus, true); assert.equal(retained.disabled, false);
    yield { name: `${theme}-ready-same-composer`, inspect, metadata: { retained, after: await capture.inspect([textarea]) } };

    // A definite rejection retains writing, supports explicit retry and does not disable navigation.
    await capture.click(add); await capture.fill(textarea, 'Keep this draft through a rejected create.');
    await capture.component('ex-connected-workspace-demo', c => c.fixture.finishSessionCreation(11, 'failed'));
    await capture.waitFor(() => document.querySelector('.creation-error')); await finish();
    yield { name: `${theme}-creation-rejected`, inspect };
    await capture.evaluate(() => document.querySelector('.creation-feedback button').focus()); await capture.press('Enter');
    await capture.waitFor(() => !document.querySelector('.creation-error'));
    await capture.component('ex-connected-workspace-demo', c => c.fixture.finishSessionCreation(11));
    await capture.waitFor(() => !document.querySelector('[data-session-id^="starting-"]'));
    assert.equal(await capture.evaluate(() => document.querySelector('ex-composer textarea').value), 'Keep this draft through a rejected create.');

    // Unknown writes can be inspected, never replayed by Refresh or another plus click.
    await capture.click(add); await capture.fill(textarea, 'Keep this draft when creation is unconfirmed.');
    await capture.component('ex-connected-workspace-demo', c => c.fixture.finishSessionCreation(11, 'unknown'));
    await capture.waitFor(() => document.querySelector('.creation-error')); await finish();
    const calls = await capture.component('ex-connected-workspace-demo', c => c.fixture.sentSessionCreates.length);
    await capture.component('ex-machine-workspace', c => { void c.store.createSession('11'); });
    await capture.evaluate(() => document.querySelector('.creation-feedback button').focus()); await capture.press('Enter');
    await capture.waitFor(() => document.querySelector('ex-workspace-navigation .sidebar')?.getAttribute('aria-busy') === 'false'); await finish();
    assert.equal(await capture.component('ex-connected-workspace-demo', c => c.fixture.sentSessionCreates.length), calls);
    yield { name: `${theme}-creation-unconfirmed`, inspect };
    await capture.evaluate(() => document.querySelector('.creation-feedback button:last-child').focus()); await capture.press('Enter');
    await capture.waitFor(() => !document.querySelector('.creation-feedback') && document.activeElement.matches('ex-composer textarea'));

    // Completing after the user moves elsewhere never steals selection or writing.
    await capture.click(add); await capture.fill(textarea, 'Draft from a background creation.');
    await capture.component('ex-machine-workspace', c => c.store.selectSession({ taskId: '11', sessionId: '101' }));
    await capture.component('ex-connected-workspace-demo', c => c.fixture.finishSessionCreation(11));
    await capture.waitFor(() => !document.querySelector('[data-session-id^="starting-"]'));
    assert.equal(await capture.component('ex-machine-workspace', c => c.store.selected().sessionId), 101);
    yield { name: `${theme}-background-completion`, inspect };

    await capture.viewport(680, 760); await capture.reducedMotion(true);
    await capture.component('ex-machine-workspace', c => c.panelOpen.set(true));
    await capture.click(add); await capture.fill(textarea, 'Typing remains available in a compact layout.');
    assert.equal(await capture.component('ex-machine-workspace', c => c.panelOpen()), false, 'Compact takeover closes so typing is visible');
    assert.equal(await capture.evaluate(() => document.activeElement.matches('ex-composer textarea')), true);
    yield { name: `${theme}-compact-reduced-motion`, inspect };
    await capture.component('ex-connected-workspace-demo', c => c.fixture.finishSessionCreation(11));
    await capture.waitFor(() => !document.querySelector('[data-session-id^="starting-"]'));

    // Even a receipt before the next paint focuses the new, empty composer.
    await capture.component('ex-connected-workspace-demo', c => c.fixture.holdSessionCreation(false));
    await capture.evaluate(selector => document.querySelector(selector).focus(), add); await capture.press('Enter');
    await capture.waitFor(() => document.querySelector('.start h1') && !document.querySelector('ex-composer .send')?.getAttribute('aria-busy')?.includes('true'));
    assert.equal(await capture.evaluate(() => document.activeElement.matches('ex-composer textarea')), true);
    assert.equal(await capture.evaluate(() => document.querySelector('ex-composer textarea').value), '');
    yield { name: `${theme}-fast-receipt-keyboard`, inspect };
  }
}
