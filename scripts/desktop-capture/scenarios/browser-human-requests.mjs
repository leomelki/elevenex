import assert from 'node:assert/strict';

/** Production request owner and controls, using the isolated preview transport. */
export default async function* browserHumanRequests(capture) {
  await capture.evaluate(() => { location.href = '/task-browser'; });
  await capture.waitFor(() => document.querySelector('.start-page'));
  const request = { id: '11111111-1111-4111-8111-111111111111', sessionId: 42, kind: 'element', message: 'Choose the price field to update. The click will only select it.', status: 'pending', expiresAt: Date.now() + 600000 };
  const setRequest = patch => capture.component('ex-task-browser', (component, value) => {
    component.store.state.update(state => ({ ...state, agentCode: 1, agentRequests: [{ ...value, tabId: state.active }] }));
  }, { ...request, ...patch });
  for (const theme of ['light', 'dark']) {
    await capture.theme(theme); await capture.viewport(1000, 720);
    await setRequest({}); await capture.motion.finish();
    await capture.waitFor(() => document.querySelector('ex-browser-agent-requests .request'));
    assert.equal(await capture.evaluate(() => [...document.querySelectorAll('ex-browser-agent-requests button')].find(button => button.textContent.includes('Confirm')).disabled), true);
    yield { name: theme + '-choose-element', selector: 'ex-task-browser', inspect: ['ex-browser-agent-requests', '.actions'] };
    await setRequest({ selection: { selector: 'css=[data-elevenex-picked="chosen"]', frames: ['iframe'], tag: 'input', x: 30, y: 50, width: 120, height: 30, documentId: 'document' } });
    await capture.waitFor(() => !!document.querySelector('ex-browser-agent-requests .selection'));
    // Native keyboard focus remains visible on the confirmation control.
    await capture.evaluate(() => [...document.querySelectorAll('ex-browser-agent-requests button')].find(button => button.textContent.includes('Choose again')).focus());
    await capture.press('Tab');
    assert.match(await capture.evaluate(() => document.activeElement.textContent), /Confirm and return/);
    yield { name: theme + '-confirm-focus', selector: 'ex-task-browser', inspect: ['ex-browser-agent-requests', ':focus'] };
    await capture.component('ex-task-browser', component => component.store.pending.set(1));
    assert.equal(await capture.evaluate(() => [...document.querySelectorAll('ex-browser-agent-requests button')].every(button => button.disabled)), true);
    yield { name: theme + '-busy', selector: 'ex-browser-agent-requests' };
    await capture.component('ex-task-browser', component => component.store.pending.set(0));
    await capture.viewport(380, 640); await capture.reducedMotion(true);
    await setRequest({ kind: 'action', message: 'Sign in to the test account, then return control when you are ready.' });
    await capture.settle();
    const bounds = await capture.evaluate(() => {
      const card = document.querySelector('ex-browser-agent-requests'); const r = card.getBoundingClientRect();
      return { right: r.right, width: r.width, overflow: card.scrollWidth > card.clientWidth };
    });
    assert.ok(bounds.width > 0 && bounds.right <= 380); assert.equal(bounds.overflow, false);
    yield { name: theme + '-narrow-action', selector: 'ex-task-browser', inspect: ['ex-browser-agent-requests'], metadata: bounds };
  }
  await capture.component('ex-task-browser', component => component.store.state.update(state => ({ ...state, agentRequests: [] })));
  await capture.waitFor(() => !document.querySelector('ex-browser-agent-requests .request'));
  yield { name: 'resolved-empty', selector: 'ex-task-browser' };
}
