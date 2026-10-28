import assert from 'node:assert/strict';

async function settleMotion(capture) {
  await capture.settle();
  await capture.motion.finish();
  await capture.waitFor(() => document.getAnimations().every(animation =>
    !Number.isFinite(animation.effect?.getComputedTiming().endTime) || animation.playState !== 'running'));
}

async function homeGeometry(capture) {
  return capture.evaluate(() => Object.fromEntries(
    [...document.querySelectorAll('ex-machine-app ex-machine-home, ex-machine-app [data-machine]')].map(element => {
      const rect = element.getBoundingClientRect();
      return [element.getAttribute('data-machine') ?? 'home', { x: rect.x, y: rect.y, width: rect.width, height: rect.height }];
    }),
  ));
}

function assertHomeStill(before, after) {
  assert.deepEqual(Object.keys(after), Object.keys(before));
  for (const id of Object.keys(before)) for (const axis of ['x', 'y', 'width', 'height']) {
    assert.ok(Math.abs(before[id][axis] - after[id][axis]) < .05, `${id} ${axis} shifted on selection: ${before[id][axis]} → ${after[id][axis]}`);
  }
}

/** Real production composition with the isolated preview platform adapter. */
export default async function* (capture) {
  await capture.evaluate(() => { location.href = '/machine-startup'; });
  await capture.waitFor(() => document.querySelector('ex-machine-app ex-machine-home [data-machine="local"]'));
  await capture.viewport(1100, 820);
  await capture.theme('light');
  yield { name: 'startup-light', inspect: ['ex-machine-app', 'ex-machine-home', '[data-machine="local"]'] };
  const initialHome = await homeGeometry(capture);
  await capture.click('[data-machine="local"]');
  await capture.waitFor(() => document.querySelector('[data-machine="local"] .pending-tag'));
  assertHomeStill(initialHome, await homeGeometry(capture));
  assert.equal(await capture.evaluate(() => [...document.querySelectorAll('ex-machine-app button')].some(button => button.textContent.includes('Cancel opening'))), false);
  yield { name: 'startup-will-open', inspect: ['[data-machine="local"]', 'ex-title-island', 'ex-machine-home'], metadata: { stableHome: initialHome } };
  await capture.component('ex-machine-startup-demo', component => component.platform.ready());
  await capture.waitFor(() => document.querySelector('ex-machine-launch .launch.open .zoom:not([inert])'));
  await settleMotion(capture);
  await capture.waitFor(() => !document.querySelector('ex-machine-launch .faces')?.childElementCount);
  yield { name: 'startup-machine-workspace', inspect: ['ex-machine-workspace', 'ex-title-island', 'ex-new-project'] };
  await capture.component('ex-machine-startup-demo', component => component.platform.setLocal({ phase: 'downloading', version: 'a'.repeat(40), receivedBytes: 70, totalBytes: 100 }));
  await capture.waitFor(() => document.querySelector('.update ex-getting-ready'));
  await settleMotion(capture);
  yield { name: 'startup-open-machine-update', inspect: ['ex-getting-ready', 'ex-title-island'] };
  await capture.component('ex-machine-startup-demo', component => component.platform.ready());
  await capture.waitFor(() => !document.querySelector('.update'));
  await capture.click('ex-machine-app ex-title-island .trigger');
  await capture.waitFor(() => document.querySelector('ex-machine-panel header button'));
  await settleMotion(capture);
  await capture.click('ex-machine-panel header button');
  await capture.waitFor(() => document.querySelector('ex-machine-home h1')?.textContent === 'Machines');
  await settleMotion(capture);
  await capture.click('ex-machine-home footer button:first-child');
  await capture.waitFor(() => document.querySelector('.ex-modal-layer ex-add-machine input'));
  await settleMotion(capture);
  await capture.fill('ex-add-machine input', 'leo@dev-box:2222');
  await capture.press('Enter');
  await capture.waitFor(() => !document.querySelector('ex-add-machine footer button:last-child')?.disabled);
  await settleMotion(capture);
  yield { name: 'startup-server-details', inspect: ['ex-add-machine', 'ex-add-machine footer'] };
  await capture.click('ex-add-machine footer button:last-child');
  await capture.waitFor(() => document.querySelector('[data-machine="server-1"]'));
  await settleMotion(capture);
  await capture.component('ex-machine-startup-demo', component => component.platform.challenge());
  await capture.waitFor(() => document.querySelector('ex-remote-challenge-dialog ex-host-key-check'));
  await settleMotion(capture);
  yield { name: 'startup-server-trust', inspect: ['ex-remote-challenge-dialog', 'ex-host-key-check'] };
  await capture.click('ex-remote-challenge-dialog button[type="submit"]');
  await capture.waitFor(() => !document.querySelector('.ex-modal-layer:not([inert]) ex-remote-challenge-dialog'));
  await capture.component('ex-machine-startup-demo', component => component.platform.challenge('credential'));
  await capture.waitFor(() => document.querySelector('ex-remote-challenge-dialog input'));
  await settleMotion(capture);
  await capture.fill('ex-remote-challenge-dialog input', 'temporary-fixture-passphrase');
  // Native form submission includes Enter's character event. The generic
  // key helper intentionally sends only keyDown/keyUp for component shortcuts.
  await capture.cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await capture.cdp('Input.dispatchKeyEvent', { type: 'char', text: '\r', key: 'Enter', windowsVirtualKeyCode: 13 });
  await capture.cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await capture.waitFor(() => !document.querySelector('.ex-modal-layer:not([inert]) ex-remote-challenge-dialog'));
  await capture.component('ex-machine-startup-demo', component => component.platform.ready());
  await capture.waitFor(() => document.querySelector('ex-machine-launch .launch.open'));
  await settleMotion(capture);
  await capture.component('ex-machine-startup-demo', component => component.platform.recover());
  await capture.waitFor(() => document.querySelector('.connection-notice'));
  yield { name: 'startup-reconnecting', inspect: ['.connection-notice', 'ex-title-island'] };
  await capture.component('ex-machine-startup-demo', component => component.platform.fail());
  await capture.waitFor(() => [...document.querySelectorAll('.connection-notice button')].some(button => button.textContent?.trim() === 'Retry'));
  yield { name: 'startup-connection-failed', inspect: ['.connection-notice'] };
  await capture.component('ex-machine-app', component => component.home());
  await settleMotion(capture);
  await capture.theme('dark');
  yield { name: 'startup-machines-dark', inspect: ['ex-machine-home'] };
  const darkHome = await homeGeometry(capture);
  await capture.click('[data-machine="server-1"]');
  await capture.waitFor(() => document.querySelector('[data-machine="server-1"] .pending-tag'));
  await settleMotion(capture);
  assertHomeStill(darkHome, await homeGeometry(capture));
  yield { name: 'startup-server-pending-dark', inspect: ['[data-machine="server-1"]', 'ex-title-island', 'ex-machine-home'], metadata: { stableHome: darkHome } };
  await capture.component('ex-machine-app', component => component.home());
  await capture.click('ex-machine-home footer button:first-child');
  await capture.waitFor(() => document.querySelector('.ex-modal-layer:not([inert]) ex-add-machine input'));
  await settleMotion(capture);
  await capture.fill('ex-add-machine input', 'dev:70000'); await capture.press('Enter');
  await capture.waitFor(() => document.querySelector('ex-add-machine .error'));
  await settleMotion(capture);
  assert.equal(await capture.evaluate(() => document.querySelector('ex-add-machine footer button:last-child').disabled), true);
  yield { name: 'startup-ssh-validation-dark', inspect: ['ex-add-machine'] };
  await capture.fill('ex-add-machine input', 'dev-box'); await capture.press('Enter');
  await capture.waitFor(() => !document.querySelector('ex-add-machine footer button:last-child').disabled);
  await settleMotion(capture);
  yield { name: 'startup-ssh-details-dark', inspect: ['ex-add-machine'] };
  await capture.press('Escape');
  await settleMotion(capture);
  await capture.viewport(480, 760);
  await capture.reducedMotion(true);
  await capture.click('ex-machine-home footer button:first-child');
  await capture.waitFor(() => document.querySelector('.ex-modal-layer:not([inert]) ex-add-machine input'));
  yield { name: 'startup-ssh-narrow-reduced-motion', inspect: ['ex-add-machine'] };
  await capture.press('Escape');
  await capture.waitFor(() => !document.querySelector('.ex-modal-layer:not([inert]) ex-add-machine'));
  assert.equal(await capture.evaluate(() => document.activeElement?.textContent?.trim()), 'Add a server');
  await capture.click('ex-machine-home footer button:last-child');
  await capture.waitFor(() => document.querySelector('.ex-modal-layer:not([inert]) .pairing'));
  yield { name: 'startup-pairing-capability-narrow', inspect: ['.pairing'] };
  await capture.press('Escape');
  await capture.waitFor(() => !document.querySelector('.ex-modal-layer:not([inert]) .pairing'));
  assert.equal(await capture.evaluate(() => document.activeElement?.textContent?.trim()), 'Pair a computer');
  yield { name: 'startup-machines-dark-narrow', inspect: ['ex-machine-home', 'ex-title-bar'] };
  const narrowHome = await homeGeometry(capture);
  await capture.click('[data-machine="server-1"]');
  await capture.waitFor(() => document.querySelector('[data-machine="server-1"] .pending-tag'));
  assertHomeStill(narrowHome, await homeGeometry(capture));
  yield { name: 'startup-server-pending-narrow', inspect: ['ex-machine-home', 'ex-title-island'], metadata: { stableHome: narrowHome } };
}
