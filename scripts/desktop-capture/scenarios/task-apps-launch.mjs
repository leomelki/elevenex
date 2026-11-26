import assert from 'node:assert/strict';

// Production setup controls with a preview-only host that keeps setup blocked.
export default async function* (capture) {
  await capture.evaluate(() => { location.href = '/task-apps'; });
  await capture.waitFor(() => document.querySelector('ex-task-apps-demo'));
  const host = (fn, ...args) => capture.component('ex-task-apps-demo', fn, ...args);
  const refresh = () => capture.component('ex-task-apps', component => component.refresh());
  const button = '.setup-actions button[data-variant=primary]';
  for (const theme of ['light', 'dark']) {
    await capture.theme(theme);
    await capture.viewport(theme === 'dark' ? 360 : 440, 900);
    await capture.reducedMotion(theme === 'dark');
    await host(c => {
      c.fixture.requireSetup('macos-screen-recording');
      c.fixture.setupBlocked = true;
      c.fixture.holdApproval = true;
    });
    await refresh();
    await capture.waitFor(() => document.querySelector('.setup-actions button[data-variant=primary]')?.textContent.trim() === 'Check and launch');
    await capture.click(button);
    await capture.waitFor(() => document.querySelector('.setup-actions button[data-variant=primary]')?.textContent.trim() === 'Checking…');
    assert.equal(await capture.evaluate(() => document.querySelector('.setup-actions button[data-variant=primary]').disabled), true);
    yield { name: theme + '-checking', selector: 'ex-task-apps', inspect: [button, 'ex-task-app-setup [role=status]'] };
    await host(c => c.fixture.releaseApproval());
    await capture.waitFor(() => document.querySelector('ex-task-app-setup [role=status]')?.textContent.includes("hasn't launched"));
    assert.equal(await capture.evaluate(() => document.querySelector('.setup-actions button[data-variant=primary]').disabled), false);
    yield { name: theme + '-still-blocked', selector: 'ex-task-apps', inspect: [button, 'ex-task-app-setup [role=status]'] };
    await host(c => c.fixture.requireSetup('macos-desktop-connection'));
    await refresh();
    await capture.click(button);
    await capture.waitFor(() => document.querySelector('ex-task-app-setup [role=status]')?.textContent.includes("hasn't launched"));
    yield { name: theme + '-desktop-connection', selector: 'ex-task-apps', inspect: ['ex-task-app-setup h2', button] };
    await host(c => { c.fixture.setupBlocked = false; });
    await capture.click(button);
    await capture.waitFor(() => document.querySelector('ex-task-apps h2')?.textContent === 'Starting…');
    yield { name: theme + '-starting', selector: 'ex-task-apps' };
  }
}
