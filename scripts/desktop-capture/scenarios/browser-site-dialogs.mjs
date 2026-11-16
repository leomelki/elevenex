import assert from 'node:assert/strict';

// Site requests and dialogs in the preview task browser: the request bar, each dialog type in
// both themes, prompt focus/selection, the safe default on leave prompts, Esc and a narrow window.
// Run against `pnpm desktop:preview` with `--url http://127.0.0.1:4310`.
export default async function* (capture) {
  await capture.evaluate(() => { location.href = '/task-browser'; });
  await capture.waitFor(() => !!document.querySelector('ex-task-browser .start-page'));
  const setTab = patch => capture.component('ex-task-browser', (component, patch) => {
    component.store.state.update(state => ({ ...state, workflows: true, tabs: state.tabs.map(tab => ({ ...tab, ...patch })) }));
  }, patch);
  const dialog = { id: '11111111-1111-4111-8111-111111111111', kind: 'dialog', defaultValue: '' };
  const requests = [
    { ...dialog, type: 'confirm', message: 'Remove this item from your workspace?' },
    { id: '22222222-2222-4222-8222-222222222222', kind: 'upload', multiple: true },
    { id: '33333333-3333-4333-8333-333333333333', kind: 'download', name: 'project-export.zip', status: 'ready' },
    { id: '44444444-4444-4444-8444-444444444444', kind: 'download', name: 'receiving.txt', status: 'receiving' },
  ];
  const cases = [
    ['alert', 'Your changes have been saved.', ''],
    ['confirm', 'Remove this item from your workspace?', ''],
    ['prompt', 'Enter a name for this workspace.', 'My workspace'],
    ['beforeunload', 'Your account will be deleted unless you stay!', ''],
  ];
  for (const theme of ['light', 'dark']) {
    await capture.theme(theme);
    await capture.reducedMotion(false);
    await setTab({ url: 'https://shop.example.com/cart', workflows: requests });
    await capture.waitFor(() => document.querySelectorAll('.site-request').length === 4);
    assert.match(await capture.evaluate(() => document.querySelector('.site-request').textContent), /shop\.example\.com asks you to confirm/);
    yield { name: `${theme}-request-bar`, selector: 'ex-task-browser', inspect: ['.site-request'] };
    for (const [type, message, defaultValue] of cases) {
      const request = { ...dialog, type, message, defaultValue };
      await setTab({ url: 'https://shop.example.com/cart', workflows: [request] });
      await capture.waitFor(() => document.querySelectorAll('.site-request').length === 1);
      await capture.click('.site-request button:last-of-type');
      await capture.motion.finish();
      await capture.waitFor(() => !!document.querySelector('.site-dialog'));
      const state = await capture.evaluate(() => {
        const surface = document.querySelector('.site-dialog');
        return {
          title: surface.querySelector('h2').textContent,
          text: surface.textContent,
          focused: String(document.activeElement?.textContent?.trim() || document.activeElement?.getAttribute('class') || document.activeElement?.tagName),
          selection: document.activeElement instanceof HTMLInputElement ? document.activeElement.value.slice(document.activeElement.selectionStart, document.activeElement.selectionEnd) : null,
        };
      });
      if (type === 'beforeunload') {
        assert.equal(state.title, 'Leave this site?');
        assert.ok(!state.text.includes('deleted'), 'leave prompts never show site text');
        assert.equal(state.focused, 'Stay');
      } else {
        assert.equal(state.title, 'shop.example.com says');
        assert.ok(state.text.includes(message));
      }
      if (type === 'prompt') { assert.equal(state.focused, 'response'); assert.equal(state.selection, 'My workspace'); }
      if (type === 'confirm' || type === 'alert') assert.equal(state.focused, 'OK');
      yield { name: `${theme}-${type}`, selector: '.site-dialog', inspect: ['.site-dialog'] };
      await capture.press('Escape');
      await capture.motion.finish();
      await capture.waitFor(() => !document.querySelector('.site-dialog'));
    }
  }
  await capture.theme('light');
  await capture.viewport(380, 640);
  await setTab({ url: 'https://a-very-long-subdomain.staging.shop.example.com:8443/cart', workflows: [{ ...dialog, type: 'prompt', message: 'Name this workspace.\nIt shows in the sidebar and in shared links.', defaultValue: 'My workspace' }] });
  await capture.waitFor(() => document.querySelectorAll('.site-request').length === 1);
  yield { name: 'light-narrow-request-bar', selector: '.site-request', inspect: ['.site-request'] };
  await capture.click('.site-request button:last-of-type');
  await capture.motion.finish();
  await capture.waitFor(() => !!document.querySelector('.site-dialog'));
  yield { name: 'light-narrow-prompt', inspect: ['.site-dialog'] };
  await capture.press('Escape');
  await capture.motion.finish();
  await setTab({ workflows: [] });
}
