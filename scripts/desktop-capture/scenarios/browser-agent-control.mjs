import assert from 'node:assert/strict';

/** Real browser chrome/owner, with the isolated preview transport. Engine
 * acquisition and revocation are covered by native Electron/Chromium tests. */
export default async function* browserAgentControl(capture) {
  await capture.waitFor(() => document.querySelector('ex-task-browser .start-page'));
  for (const theme of ['light', 'dark']) {
    await capture.theme(theme);
    for (const narrow of [false, true]) {
      await capture.viewport(narrow ? 440 : 1000, narrow ? 560 : 720);
      await capture.reducedMotion(narrow);
      await capture.component('ex-task-browser', component => {
        component.store.bridge.drive(component.store.state().active);
      });
      await capture.waitFor(() => document.querySelector('[aria-label="Stop browser agent"]'));
      await capture.motion.finish();
      await capture.settle();
      const stop = '[aria-label="Stop browser agent"]';
      assert.equal(await capture.evaluate(() => !!document.querySelector('.agent-step')?.closest('ex-fold')?.hasAttribute('inert')), false);
      yield { name: `${theme}-${narrow ? 'narrow-reduced' : 'wide'}-driving-without-steps`, selector: 'ex-task-browser', inspect: [stop, '.agent-step', '.toolbar'] };

      // Reach Stop with trusted keyboard input and activate it without page input.
      let focused = false;
      const focusTrace = [];
      for (let index = 0; index < 48; index++) {
        focusTrace.push(await capture.evaluate(() => ({ label: document.activeElement?.getAttribute('aria-label'), text: document.activeElement?.textContent?.trim().slice(0, 60) })));
        if (await capture.evaluate(() => document.activeElement?.getAttribute('aria-label') === 'Stop browser agent')) { focused = true; break; }
        await capture.press('Tab');
      }
      assert.ok(focused, 'Stop is reachable by keyboard: ' + JSON.stringify(focusTrace));
      await capture.press('Enter');
      await capture.waitFor(() => document.querySelector('[aria-label="Hand back browser"]'));
      assert.equal(await capture.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'Hand back browser');
      assert.equal(await capture.component('ex-task-browser', component => component.store.state().tabs[0].driver), 'you');
      await capture.motion.finish();
      yield { name: `${theme}-${narrow ? 'narrow-reduced' : 'wide'}-stopped`, selector: 'ex-task-browser', inspect: ['[aria-label="Hand back browser"]', '.agent-step'] };
      await capture.press('Enter');
      await capture.waitFor(() => document.querySelector('[aria-label="Stop browser agent"]'));
      assert.equal(await capture.component('ex-task-browser', component => component.store.state().tabs[0].driver), 'agent');
    }
  }
}
