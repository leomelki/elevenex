import assert from 'node:assert/strict';

/** Real xterm pixels and trusted input, with remote echoes deliberately held.
 * Fixture activity lives exclusively in the component preview. */
export default async function* (capture) {
  await capture.evaluate(() => { location.href = '/terminal-rendering'; });
  const owner = operation => capture.component('ex-terminal-rendering-demo', operation);
  const observed = () => owner(async component => {
    await new Promise(resolve => component.surface.terminal.write('', resolve));
    return { input: component.input(), output: component.surface.context(), predicting: component.surface.localEcho.predicting };
  });
  await capture.waitFor(() => document.querySelector('.terminal[data-ready=true]'));
  for (const theme of ['light', 'dark']) {
    await capture.theme(theme);
    for (const width of [960, 420]) {
      await capture.viewport(width, 600); await capture.reducedMotion(width === 420); await capture.settle();
      await owner(async component => {
        component.input.set('');
        component.paintLatency.length = 0;
        const surface = component.surface;
        surface.reset(); surface.setEnabled(true); surface.localEcho.latencyThreshold = 0;
        await surface.write('server ~/project $ '); surface.localEcho.reconcile(100); surface.focus();
      });
      for (const key of ['e', 'c', 'h', 'o', ' ', 's', 'n', 'a', 'p', 'p', 'y']) await capture.press(key);
      const before = await observed();
      assert.deepEqual(before, { input: 'echo snappy', output: 'server ~/project $ echo snappy', predicting: true });
      assert.equal(await capture.evaluate(() => document.querySelector('.ex-terminal-local-echo')), null);
      await capture.settle();
      const paintLatency = await owner(component => [...component.paintLatency]);
      yield { name: `${theme}-${width}-predicted`, selector: '.terminal[data-ready=true]', metadata: { ...before, paintLatency } };

      await owner(async component => { await component.surface.write('echo '); component.surface.localEcho.reconcile(100); });
      assert.equal((await observed()).output, 'server ~/project $ echo snappy');
      for (const type of ['keyDown', 'keyUp']) await capture.cdp('Input.dispatchKeyEvent', { type, key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
      assert.equal((await observed()).output, 'server ~/project $ echo snapp');
      await owner(async component => { await component.surface.write('snappy\b \b'); component.surface.localEcho.reconcile(100); });
      assert.equal((await observed()).predicting, false);
      yield { name: `${theme}-${width}-confirmed`, selector: '.terminal[data-ready=true]' };

      await capture.press('Enter');
      await owner(async component => { await component.surface.write('\r\nPassword: '); component.surface.localEcho.reconcile(100); });
      for (const key of ['s', 'e', 'c', 'r', 'e', 't']) await capture.press(key);
      const password = await observed();
      assert.equal(password.predicting, false);
      assert.equal(password.output.split('\n').map(line => line.trimEnd()).join('\n'), 'server ~/project $ echo snapp\nPassword:');
      yield { name: `${theme}-${width}-password`, selector: '.terminal[data-ready=true]' };

      await capture.click('#terminal-settings');
      await capture.waitFor(() => !!document.querySelector('[role=dialog]'));
      await capture.settle();
      yield { name: `${theme}-${width}-settings`, inspect: ['[role=dialog]'] };
      await owner(component => component.settingsBusy.set(true));
      assert.equal(await capture.evaluate(() => [...document.querySelectorAll('[role=dialog] input, [role=dialog] textarea, [role=dialog] [role=switch]')].every(control => control.disabled)), true);
      yield { name: `${theme}-${width}-settings-saving`, inspect: ['[role=dialog]'] };
      await owner(component => { component.settingsBusy.set(false); component.settingsError.set('Settings could not be saved. Try again.'); });
      yield { name: `${theme}-${width}-settings-error`, inspect: ['[role=dialog] [role=alert]'] };
      await owner(component => component.settingsError.set(''));
      // Native tabbing scrolls the settings body to its editable controls.
      for (let step = 0; step < 12; step++) {
        if (await capture.evaluate(() => document.activeElement === document.querySelector('[role=dialog] textarea:last-of-type'))) break;
        await capture.press('Tab');
      }
      await capture.fill('[role=dialog] textarea:last-of-type', 'bad name=value');
      await capture.press('Tab'); await capture.press('Tab'); await capture.press('Enter');
      await capture.waitFor(() => !!document.querySelector('[role=dialog] [role=alert]'));
      assert.match(await capture.evaluate(() => document.querySelector('[role=dialog] [role=alert]')?.textContent ?? ''), /NAME=value/);
      yield { name: `${theme}-${width}-settings-validation`, inspect: ['[role=dialog] [role=alert]'] };
      await capture.press('Escape');
      await capture.waitFor(() => !document.querySelector('[role=dialog]'));
      assert.equal(await capture.evaluate(() => document.activeElement?.id), 'terminal-settings');
      await capture.click('#terminal-settings');
      await capture.waitFor(() => !!document.querySelector('[role=dialog]'));
      assert.equal(await capture.evaluate(() => document.querySelector('[role=dialog] textarea:last-of-type')?.value), 'EDITOR=vim');
      await capture.press('Escape');
      await capture.waitFor(() => !document.querySelector('[role=dialog]'));
    }
  }
}
