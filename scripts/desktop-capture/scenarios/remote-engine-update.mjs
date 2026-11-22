import assert from 'node:assert/strict';

export default async function* (capture) {
  for (const theme of ['light', 'dark']) {
    await capture.evaluate(() => { location.href = '/machine-startup'; });
    await capture.waitFor(() => document.querySelector('ex-machine-app'));
    await capture.theme(theme);
    await capture.viewport(theme === 'dark' ? 420 : 1000, 720);
    await capture.reducedMotion(theme === 'dark');
    const hostId = await capture.component('ex-machine-startup-demo', async component => {
      component.platform.reset(true);
      return (await component.platform.saveRemoteHost({ name: 'Build server', host: 'build' })).id;
    });
    await capture.component('ex-machine-app', (component, id) => component.launcher.choose(id), hostId);
    await capture.component('ex-machine-startup-demo', component => component.platform.updateConnections(3));
    await capture.waitFor(() => document.querySelector('[aria-labelledby="engine-update-title"] [role="status"]')?.textContent.includes('3 connections are active'));
    await capture.waitFor(() => document.activeElement?.closest('[aria-labelledby="engine-update-title"]'));
    yield { name: `${theme}-active-connections`, inspect: ['[aria-labelledby="engine-update-title"]', '.update-actions button'] };

    await capture.component('ex-machine-startup-demo', component => component.platform.updateConnections(1));
    await capture.waitFor(() => document.querySelector('[aria-labelledby="engine-update-title"] [role="status"]')?.textContent.includes('One connection is active'));
    if (theme === 'light') await capture.press('Escape');
    else await capture.click('[aria-labelledby="engine-update-title"] button[data-variant="danger"]');
    await capture.waitFor(() => !document.querySelector('[aria-labelledby="engine-update-title"]:not([inert])'));
    const state = await capture.component('ex-machine-startup-demo', async component => (await component.platform.environmentStatus()).connection.phase);
    assert.equal(state, theme === 'light' ? 'disconnected' : 'setting-up');
  }
}
