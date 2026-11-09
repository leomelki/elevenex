import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

/** Run the native smoke and runtime element-snapshot integration fixture first to produce a fresh real browser crop. */
export default async function* (capture) {
  const snapshot = JSON.parse(await readFile(new URL('../../../artifacts/element-mentions/native-snapshot.json', import.meta.url), 'utf8'));
  assert.ok(snapshot.jpeg);
  const second = JSON.parse(await readFile(new URL('../../../artifacts/element-mentions/runtime-snapshot.json', import.meta.url), 'utf8'));
  assert.ok(second.jpeg);
  await capture.evaluate(() => { location.href = '/element-mentions'; });
  await capture.waitFor(() => document.querySelector('ex-element-mentions-demo ex-composer'));
  yield { name: 'empty' };
  await capture.component('ex-element-mentions-demo', (component, value) => component.stage(value), snapshot);
  await capture.waitFor(() => document.querySelector('ex-element-reference img')?.complete);
  for (const theme of ['light', 'dark']) {
    await capture.theme(theme);
    await capture.viewport(1000, 780);
    yield { name: `${theme}-ready`, inspect: ['ex-element-reference', 'ex-composer textarea'] };
    await capture.click('ex-element-reference .preview');
    await capture.waitFor(() => document.querySelector('[role=dialog] img')?.complete);
    await capture.motion.finish();
    yield { name: `${theme}-preview`, inspect: ['[role=dialog]', '[role=dialog] .target'] };
    await capture.press('Escape');
    await capture.waitFor(() => !document.querySelector('[role=dialog]'));
    assert.ok((await capture.evaluate(() => document.activeElement?.className)).includes('preview'));
    await capture.component('ex-element-mentions-demo', component => component.state('uploading'));
    yield { name: `${theme}-uploading` };
    await capture.component('ex-element-mentions-demo', component => component.state('error'));
    yield { name: `${theme}-error` };
    await capture.component('ex-element-mentions-demo', component => component.state('ready'));
  }
  await capture.motion.freeze();
  await capture.click('ex-element-reference .preview');
  await capture.waitFor(() => document.querySelector('[role=dialog]'));
  await capture.motion.seek(70);
  yield { name: 'preview-interrupted-opening' };
  await capture.press('Escape');
  await capture.motion.seek(70);
  await capture.component('ex-element-reference', component => component.open());
  await capture.motion.finish();
  yield { name: 'preview-reopened', inspect: ['[role=dialog]'] };
  await capture.press('Escape'); await capture.motion.finish(); await capture.motion.play();
  await capture.waitFor(() => !document.querySelector('[role=dialog]'));
  await capture.component('ex-element-mentions-demo', component => component.disabled.set(true));
  yield { name: 'disabled' };
  await capture.component('ex-element-mentions-demo', component => component.disabled.set(false));
  await capture.reducedMotion(true);
  await capture.viewport(380, 780);
  await capture.component('ex-element-mentions-demo', (component, value) => component.stage(value), second);
  yield { name: 'narrow-multiple', inspect: ['ex-element-reference', 'ex-composer textarea'] };
  await capture.click('ex-element-reference:first-child .actions > button');
  await capture.waitFor(() => document.querySelector('textarea')?.value.includes('@element-'));
  yield { name: 'narrow-mentioned' };
  await capture.fill('ex-composer textarea', 'Align @');
  await capture.waitFor(() => document.querySelector('ex-mention-menu [role=option]'));
  yield { name: 'narrow-at-menu' };
  await capture.press('ArrowDown'); await capture.press('Enter');
  await capture.click('ex-composer .send');
  await capture.waitFor(() => document.querySelector('.sent ex-element-reference'));
  yield { name: 'narrow-sent-readonly', inspect: ['.sent', 'ex-composer textarea'] };
  await capture.evaluate(() => { location.href = '/task-browser'; });
  await capture.waitFor(() => document.querySelector('ex-task-browser .start-page'));
  await capture.component('ex-task-browser', (component, value) => {
    const state = component.store.state();
    component.store.state.set({ ...state, revision: state.revision + 1, elementSnapshots: 1, active: value.reference.tabId, tabs: [{ ...state.tabs[0], id: value.reference.tabId, title: 'Checkout', url: value.reference.page, ready: true }], picked: { ...value.reference.target, selector: value.reference.selector, tag: value.reference.tag, snapshot: value } });
  }, snapshot);
  await capture.waitFor(() => document.querySelector('textarea[aria-label="Add a note (optional)"]'));
  assert.equal(await capture.evaluate(() => document.querySelector('ex-task-browser button[type="submit"]').disabled), false);
  await capture.theme('light');
  yield { name: 'browser-optional-note-light', inspect: ['ex-task-browser form'] };
  await capture.theme('dark');
  yield { name: 'browser-optional-note-dark', inspect: ['ex-task-browser form'] };

}
