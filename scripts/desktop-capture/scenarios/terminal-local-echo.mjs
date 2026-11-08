import assert from 'node:assert/strict';

/** Real terminal pixels and trusted keys with the remote echo deliberately held.
 * Uses only the isolated component preview; never sends a shell command. */
export default async function* (capture) {
  const owner = operation => capture.component('ex-terminal-rendering-demo', operation);
  await capture.waitFor(() => document.querySelector('.terminal[data-ready=true]'));
  for (const theme of ['light', 'dark']) {
    await capture.theme(theme);
    for (const width of [960, 420]) {
      await capture.viewport(width, 600);
      await capture.reducedMotion(width === 420);
      await capture.settle();
      await owner(async component => {
        component.input.set('');
        const surface = component.surface;
        surface.reset(); surface.setEnabled(true);
        await surface.write('server ~/project $ ');
        surface.localEcho.reconcile(100);
        surface.focus();
      });
      for (const key of ['e', 'c', 'h', 'o', ' ', 's', 'n', 'a', 'p', 'p', 'y']) await capture.press(key);
      await capture.waitFor(() => document.querySelector('.ex-terminal-local-echo')?.textContent === 'echo snappy ');
      const before = await owner(component => ({ input: component.input(), output: component.surface.context() }));
      assert.deepEqual(before, { input: 'echo snappy', output: 'server ~/project $' });
      yield { name: `${theme}-${width}-before-remote-echo`, selector: '.terminal[data-ready=true]', metadata: before };

      // Confirm only a prefix; remaining keys stay visible with no duplicates.
      await owner(async component => {
        await component.surface.write('echo ');
        component.surface.localEcho.reconcile(100);
      });
      assert.equal(await capture.evaluate(() => document.querySelector('.ex-terminal-local-echo')?.textContent), 'echo snappy ');
      for (const type of ['keyDown', 'keyUp']) await capture.cdp('Input.dispatchKeyEvent', {
        type, key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8,
      });
      await capture.settle();
      assert.equal(await capture.evaluate(() => document.querySelector('.ex-terminal-local-echo')?.textContent), 'echo snapp ');
      await owner(async component => {
        await component.surface.write('snappy\b \b');
        component.surface.localEcho.reconcile(100);
      });
      assert.equal(await capture.evaluate(() => document.querySelector('.ex-terminal-local-echo')), null);
      assert.equal(await owner(component => component.surface.context()), 'server ~/project $ echo snapp');
      yield { name: `${theme}-${width}-confirmed`, selector: '.terminal[data-ready=true]' };

      await capture.press('Enter');
      await owner(async component => {
        await component.surface.write('\r\nPassword: ');
        component.surface.localEcho.reconcile(100); // Stale pre-Enter grant.
      });
      for (const key of ['s', 'e', 'c', 'r', 'e', 't']) await capture.press(key);
      assert.equal(await capture.evaluate(() => document.querySelector('.ex-terminal-local-echo')), null);
      const password = await owner(component => component.surface.context());
      assert.equal(password.split('\n').map(line => line.trimEnd()).join('\n'), 'server ~/project $ echo snapp\nPassword:');
      yield { name: `${theme}-${width}-password-no-echo`, selector: '.terminal[data-ready=true]' };
    }
  }
}
