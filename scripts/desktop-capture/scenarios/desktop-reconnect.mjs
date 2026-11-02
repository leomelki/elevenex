import assert from 'node:assert/strict';

/** Real Angular window and native input; backend/SSH responses are preview-controlled. */
export default async function* (capture) {
  const settleMotion = async () => {
    await capture.evaluate(() => {
      for (const animation of document.getAnimations()) if (Number.isFinite(animation.effect?.getComputedTiming().endTime)) animation.finish();
    });
    await capture.settle();
    await capture.waitFor(() => document.getAnimations().every(animation => !Number.isFinite(animation.effect?.getComputedTiming().endTime) || animation.playState !== 'running'));
  };
  for (const theme of ['light', 'dark']) {
    await capture.evaluate(() => { location.href = '/reconnect'; });
    await capture.waitFor(() => document.querySelector('ex-reconnect-demo [data-machine="local"]'));
    await capture.theme(theme); await capture.viewport(1280, 860); await capture.reducedMotion(false);
    await capture.component('ex-machine-app', async component => {
      const host = await component.connection.addHost({ name: 'dev-box', host: 'dev-box.internal', user: 'leo' });
      await component.launcher.choose(host.id);
    });
    await capture.component('ex-reconnect-demo', component => component.platform.ready());
    await capture.waitFor(() => document.querySelector('.launch.open ex-machine-workspace ex-app-shell'));
    await capture.waitFor(() => !document.querySelector('ex-machine-workspace').hasAttribute('inert'));
    await capture.component('ex-machine-workspace', async component => {
      component.store.selectSession({ taskId: '11', sessionId: '101' });
      await component.store.openNewTask(); component.store.closeDialog();
    });
    await capture.waitFor(() => document.querySelector('ex-session-chat ex-message'));
    await capture.component('ex-reconnect-demo', component => component.platform.chat.scenario('running'));
    await capture.waitFor(() => document.querySelector('ex-turn.live'));
    await settleMotion();
    const gitFits = await capture.evaluate(() => {
      const button = document.querySelector('ex-git-bar .primary'), ink = button?.querySelector('.action-ink');
      return !button || !ink || ink.getBoundingClientRect().right <= button.getBoundingClientRect().right + 1;
    });
    assert.equal(gitFits, true, 'Git labels remain fully visible after the scaled machine launch');
    await capture.fill('ex-composer textarea', 'Keep this unfinished draft.');
    await capture.component('ex-reconnect-demo', component => component.platform.recover());
    await capture.waitFor(() => document.querySelector('.workspace-frame.ex-offline'));
    assert.equal(await capture.evaluate(() => document.querySelector('ex-composer textarea').value), 'Keep this unfinished draft.');
    assert.equal(await capture.evaluate(() => getComputedStyle(document.querySelector('.workspace-frame ex-status-glyph.spin')).animationPlayState), 'paused', 'Only live motion freezes during the outage');
    assert.equal(await capture.evaluate(() => !!document.querySelector('ex-modal-layer .credential input')), false, 'Outages never steal typing focus');
    await capture.waitFor(() => [...document.querySelectorAll('ex-turn .reach-line')].some(line => line.getBoundingClientRect().height > 0));
    await settleMotion();
    yield { name: `${theme}-retained-live-turn`, inspect: ['ex-composer', 'ex-turn.live .reach-line', 'ex-title-island'] };
    await capture.fill('ex-composer textarea', 'This message waits locally.'); await capture.press('Enter');
    await capture.waitFor(() => document.querySelector('ex-composer-queue .item'));
    assert.equal(await capture.component('ex-reconnect-demo', component => component.platform.sentChatActions.length), 0);
    await capture.hover('ex-composer-queue .item'); await settleMotion();
    yield { name: `${theme}-waiting-message`, inspect: ['ex-composer', 'ex-composer-queue'] };
    await capture.click('ex-composer-queue button[aria-label="Edit queued message"]');
    await capture.fill('ex-composer-queue textarea', 'Edited while disconnected.');
    await capture.click('ex-composer-queue .edit button[data-variant="primary"]');
    await capture.component('ex-machine-workspace', async component => {
      await component.store.openNewTask();
      await component.store.createSession('11');
      await component.store.createTask({ title: 'Wait for the machine', repo: '1', branch: 'wait-for-machine', existing: false, base: 'main', workspace: 'auto' });
    });
    await capture.waitFor(() => document.querySelector('.waiting-task'));
    assert.equal(await capture.component('ex-reconnect-demo', component => component.platform.sentTaskCreates.length), 0);
    // A destructive/repository operation remains a deliberate future click, never a queued write.
    await capture.click('ex-git-bar button.primary');
    await capture.waitFor(() => document.querySelector('.unreachable-note')?.textContent.includes('Nothing was sent'));
    assert.equal(await capture.component('ex-reconnect-demo', component => component.platform.sentGitActions.length), 0);
    await settleMotion();
    yield { name: `${theme}-git-blocked-task-waiting`, inspect: ['ex-git-bar', '.waiting-task'] };
    await capture.component('ex-machine-app', component => component.outageSince.set(Date.now() - 31000));
    await settleMotion();
    yield { name: `${theme}-long-outage`, inspect: ['ex-title-island'] };
    await capture.component('ex-reconnect-demo', component => component.platform.stopRetries());
    await settleMotion();
    yield { name: `${theme}-retry-clock-stopped`, inspect: ['ex-title-island'] };
    await capture.component('ex-reconnect-demo', component => component.platform.challenge('credential'));
    assert.equal(await capture.evaluate(() => !!document.querySelector('ex-remote-challenge-dialog input:not(:disabled)')), false, 'SSH ask waits for an explicit island click');
    await capture.click('ex-title-island .trigger');
    await capture.waitFor(() => document.querySelector('ex-title-island .details .credential input'));
    await settleMotion();
    yield { name: `${theme}-reconnect-ask`, inspect: ['ex-title-island', 'ex-remote-challenge-dialog'] };
    await capture.fill('ex-title-island .credential input', 'preview-only-secret');
    await capture.press('Escape');
    await capture.waitFor(() => !document.querySelector('ex-title-island .details'));
    assert.equal(await capture.evaluate(() => document.activeElement === document.querySelector('ex-title-island .trigger')), true);
    await capture.click('ex-title-island .trigger');
    await capture.waitFor(() => document.querySelector('ex-title-island .credential input'));
    assert.equal(await capture.evaluate(() => document.querySelector('ex-title-island .credential input').value), '', 'Closing the panel clears transient credentials');
    await capture.press('Escape');
    await capture.component('ex-reconnect-demo', component => component.platform.ready());
    await capture.waitFor(() => !document.querySelector('.workspace-frame.ex-offline'));
    await capture.waitFor(() => !document.querySelector('.waiting-task'));
    await capture.waitFor(() => !document.querySelector('ex-composer .waiting-line'));
    const accepted = await capture.component('ex-reconnect-demo', component => ({ chat: component.platform.sentChatActions, tasks: component.platform.sentTaskCreates, git: component.platform.sentGitActions, sessions: component.platform.sentSessionCreates }));
    assert.equal(accepted.chat.length, 1); assert.equal(accepted.chat[0].action.text, 'Edited while disconnected.');
    assert.equal(accepted.sessions.filter(input => input.taskId === 11).length, 1);
    assert.equal(accepted.tasks.length, 1); assert.ok(accepted.tasks[0].requestId); assert.equal(accepted.git.length, 0);
    await settleMotion();
    yield { name: `${theme}-recovered-once`, inspect: ['ex-title-island', 'ex-composer', 'ex-workspace-navigation'], metadata: { accepted } };

    await capture.reducedMotion(true); await capture.viewport(480, 780);
    await capture.component('ex-reconnect-demo', component => component.platform.recover());
    await capture.waitFor(() => document.querySelector('.workspace-frame.ex-offline'));
    await capture.component('ex-machine-workspace', component => { component.store.panel.set('browser'); component.store.panelOpen.set(true); });
    await capture.waitFor(() => document.querySelector('ex-opens-when-back'));
    await settleMotion();
    yield { name: `${theme}-narrow-reduced-never-loaded`, inspect: ['ex-opens-when-back', 'ex-workspace-panels', 'ex-composer'] };
    assert.equal(await capture.evaluate(() => document.querySelector('ex-app-shell main').hasAttribute('inert')), true);
    await capture.press('Escape');
    await capture.waitFor(() => !document.querySelector('ex-app-shell main').hasAttribute('inert'));
    await capture.component('ex-reconnect-demo', component => component.platform.fail(true));
    await capture.click('ex-title-island .trigger'); await settleMotion();
    yield { name: `${theme}-narrow-host-identity`, inspect: ['ex-title-island'] };
    assert.equal(await capture.evaluate(() => document.querySelector('ex-title-island .island').getAttribute('data-tone')), 'danger');
    await capture.press('Escape'); await capture.reducedMotion(false);
  }
}
