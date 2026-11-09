import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

/**
 * Element pins in the real Composer, chips, snapshot popover and sent message,
 * plus the task browser's pin mode. Run the native smoke and runtime
 * element-snapshot fixtures first so the crops are fresh, real browser pixels.
 */
export default async function* (capture) {
  const snapshot = JSON.parse(await readFile(new URL('../../../artifacts/element-mentions/native-snapshot.json', import.meta.url), 'utf8'));
  const second = JSON.parse(await readFile(new URL('../../../artifacts/element-mentions/runtime-snapshot.json', import.meta.url), 'utf8'));
  assert.ok(snapshot.jpeg && second.jpeg);
  const type = text => capture.cdp('Input.insertText', { text });
  const draft = () => capture.evaluate(() => document.querySelector('ex-composer textarea').value);

  await capture.viewport(760, 720);
  await capture.evaluate(() => { location.href = '/element-mentions'; });
  await capture.waitFor(() => document.querySelector('ex-element-mentions-demo ex-composer textarea'));
  yield { name: 'empty', inspect: ['ex-composer'] };

  // Pointing reads as part of the sentence: each pick drops its pin at the caret.
  await capture.click('ex-composer textarea');
  await type('Align');
  await capture.component('ex-element-mentions-demo', (component, value) => component.stage(value), snapshot);
  await type('with');
  await capture.component('ex-element-mentions-demo', (component, value) => component.stage(value), second);
  await type('and match its height.');
  assert.equal(await draft(), 'Align ❶ with ❷ and match its height.');
  await capture.waitFor(() => [...document.querySelectorAll('ex-element-chip img')].every(image => image.complete) && document.querySelectorAll('.marker-text mark').length === 2);

  for (const theme of ['light', 'dark']) {
    await capture.theme(theme);
    await capture.settle();
    yield { name: `${theme}-pinned`, inspect: ['ex-element-chip', '.marker-text mark', 'ex-composer textarea'] };
    await capture.hover('ex-element-chip:nth-of-type(2) .face');
    await capture.waitFor(() => document.querySelector('.marker-text mark.hot'));
    yield { name: `${theme}-chip-hover-lights-pin`, inspect: ['.marker-text mark.hot'] };
    await capture.click('ex-element-chip:first-of-type .face');
    await capture.waitFor(() => document.querySelector('.element-popover img')?.complete);
    await capture.motion.finish();
    yield { name: `${theme}-snapshot`, inspect: ['.element-popover', '.element-popover .outline', '.element-popover footer button'] };
    await capture.press('Escape');
    await capture.waitFor(() => !document.querySelector('.element-popover'));
    assert.ok(await capture.evaluate(() => document.activeElement?.classList.contains('face')), 'Escape returns focus to the chip');
    await capture.component('ex-element-mentions-demo', component => component.state('uploading'));
    yield { name: `${theme}-uploading`, inspect: ['ex-element-chip .progress'] };
    await capture.component('ex-element-mentions-demo', component => component.state('error'));
    yield { name: `${theme}-error`, inspect: ['ex-element-chip .retry'] };
    await capture.component('ex-element-mentions-demo', component => component.state('ready'));
  }

  // An interrupted opening reverses cleanly and reopens.
  await capture.motion.freeze();
  await capture.click('ex-element-chip:first-of-type .face');
  await capture.waitFor(() => document.querySelector('.element-popover'));
  await capture.motion.seek(90);
  yield { name: 'snapshot-interrupted-opening' };
  await capture.press('Escape');
  await capture.motion.seek(60);
  await capture.click('ex-element-chip:first-of-type .face');
  await capture.motion.finish();
  yield { name: 'snapshot-reopened', inspect: ['.element-popover'] };
  await capture.press('Escape');
  await capture.motion.finish();
  await capture.motion.play();
  await capture.waitFor(() => !document.querySelector('.element-popover'));

  // Unreferenced pins turn hollow; removing a chip removes its pins.
  await capture.evaluate(() => {
    const textarea = document.querySelector('ex-composer textarea');
    textarea.focus();
    textarea.setSelectionRange(0, textarea.value.length);
  });
  await type('Make it wider.');
  await capture.waitFor(() => document.querySelectorAll('ex-element-pin.hollow').length === 2);
  yield { name: 'unreferenced-hollow', inspect: ['ex-element-pin.hollow'] };
  await capture.evaluate(() => document.querySelector('ex-composer textarea').setSelectionRange(5, 5));
  await capture.click('ex-composer ex-icon-button[label="Point at an element in the browser"] button');
  assert.equal(await capture.evaluate(() => document.querySelector('.pick-note') !== null), true);

  await capture.component('ex-element-mentions-demo', component => component.disabled.set(true));
  yield { name: 'disabled' };
  await capture.component('ex-element-mentions-demo', component => component.disabled.set(false));

  // Narrow, reduced motion: the @ menu reuses staged pins and offers a pick.
  await capture.reducedMotion(true);
  await capture.viewport(380, 760);
  await capture.evaluate(() => {
    const textarea = document.querySelector('ex-composer textarea');
    textarea.focus();
    textarea.setSelectionRange(0, textarea.value.length);
  });
  await type('Align ');
  await type('@');
  await capture.waitFor(() => document.querySelector('ex-mention-menu .action'));
  yield { name: 'narrow-at-menu', inspect: ['ex-mention-menu [role=option]'] };
  await capture.press('Enter');
  await capture.waitFor(() => document.querySelector('ex-composer textarea').value.startsWith('Align ❶ '));
  await type('with ');
  await type('@');
  await capture.waitFor(() => document.querySelector('ex-mention-menu [role=option]'));
  await capture.press('ArrowDown');
  await capture.press('Enter');
  await capture.waitFor(() => document.querySelector('ex-composer textarea').value.includes('❷'));
  yield { name: 'narrow-two-pins', inspect: ['ex-element-chip', '.marker-text mark'] };
  await capture.click('ex-element-chip:nth-of-type(2) .act');
  await capture.waitFor(() => document.querySelectorAll('ex-composer ex-element-chip').length === 1);
  assert.equal(await draft(), 'Align ❶ with ');
  await type('the heading.');
  await capture.click('ex-composer .send');
  await capture.waitFor(() => document.querySelector('.sent ex-element-chip img')?.complete);
  yield { name: 'narrow-sent', inspect: ['.sent', '.sent ex-element-prose .pin'] };
  await capture.click('.sent ex-element-chip .face');
  await capture.waitFor(() => document.querySelector('.element-popover img')?.complete);
  assert.equal(await capture.evaluate(() => document.querySelector('.element-popover footer')), null, 'Sent snapshots are read-only');
  yield { name: 'narrow-sent-snapshot', inspect: ['.element-popover'] };
  await capture.press('Escape');
  await capture.reducedMotion(false);

  // The task browser stages a pick directly; no question card grows from it.
  await capture.viewport(900, 720);
  await capture.evaluate(() => { location.href = '/task-browser'; });
  await capture.waitFor(() => document.querySelector('ex-task-browser .start-page'));
  await capture.component('ex-task-browser', (component, value) => {
    const state = component.store.state();
    component.store.state.set({ ...state, revision: state.revision + 1, elementSnapshots: 1, picking: true, active: value.reference.tabId, tabs: [{ ...state.tabs[0], id: value.reference.tabId, title: 'Checkout', url: value.reference.page, ready: true }] });
  }, snapshot);
  await capture.waitFor(() => document.querySelector('ex-browser-view .pointing-hint'));
  assert.match(await capture.evaluate(() => document.querySelector('ex-browser-view .pointing-hint').textContent), /point at it in your message/);
  for (const theme of ['light', 'dark']) {
    await capture.theme(theme);
    yield { name: `browser-pointing-${theme}`, inspect: ['ex-browser-view .pointing-hint'] };
  }
  assert.equal(await capture.evaluate(() => document.querySelector('ex-browser-view form.question')), null);

  // An agent-requested pick shows the same snapshot, compactly, before Confirm.
  await capture.component('ex-task-browser', (component, value) => {
    const state = component.store.state();
    const { x, y, width, height } = value.reference.target;
    component.store.state.set({ ...state, revision: state.revision + 1, picking: false, agentRequests: [{ id: 'request-1', sessionId: 2, tabId: value.reference.tabId, kind: 'element', message: 'Which field should hold the display name?', status: 'pending', expiresAt: Date.now() + 600000, selection: { snapshot: value, selector: value.reference.selector, frames: [], tag: value.reference.tag, x, y, width, height, documentId: value.reference.documentId } }] });
  }, snapshot);
  await capture.waitFor(() => document.querySelector('ex-browser-agent-requests ex-element-preview img')?.complete);
  yield { name: 'browser-agent-request-dark', inspect: ['ex-browser-agent-requests ex-element-preview'] };
  await capture.theme('light');
  yield { name: 'browser-agent-request-light', inspect: ['ex-browser-agent-requests ex-element-preview'] };
}
