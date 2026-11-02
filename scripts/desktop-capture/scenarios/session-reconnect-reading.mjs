import assert from 'node:assert/strict';

/** Same real window/session survives a transport generation while reading higher. */
export default async function* (capture) {
  const quiet = async () => {
    await capture.settle();
    await capture.waitFor(() => document.getAnimations().every(animation => !Number.isFinite(animation.effect?.getComputedTiming().endTime) || animation.playState !== 'running'));
  };
  for (const theme of ['light', 'dark']) {
    await capture.evaluate(() => { location.href = '/reconnect'; });
    await capture.waitFor(() => document.querySelector('ex-reconnect-demo [data-machine="local"]'));
    await capture.theme(theme); await capture.viewport(1280, 860);
    await capture.component('ex-machine-app', async component => { const host = await component.connection.addHost({ name: 'dev-box', host: 'dev-box.internal' }); await component.launcher.choose(host.id); });
    await capture.component('ex-reconnect-demo', component => { component.platform.ready(); component.platform.chat.scenario('history'); });
    await capture.waitFor(() => document.querySelector('.launch.open ex-machine-workspace'));
    await capture.component('ex-machine-workspace', component => component.store.selectSession({ taskId: '11', sessionId: '101' }));
    await capture.waitFor(() => document.querySelectorAll('ex-session-chat ex-message').length >= 20);
    await quiet();
    const before = await capture.evaluate(() => {
      const viewport = document.querySelector('ex-session-chat ex-chat-scroll .viewport');
      viewport.scrollTop = viewport.scrollHeight * .35; viewport.dispatchEvent(new window.Event('scroll'));
      return viewport.scrollTop;
    });
    await capture.component('ex-reconnect-demo', component => component.platform.recover());
    await capture.waitFor(() => document.querySelector('.workspace-frame.ex-offline')); await quiet();
    await capture.component('ex-reconnect-demo', component => { component.platform.chat.appendAssistant('A recovered update while you were reading.'); component.platform.ready(); });
    await capture.waitFor(() => !document.querySelector('.workspace-frame.ex-offline'));
    await capture.waitFor(() => document.querySelector('ex-session-chat').textContent.includes('A recovered update while you were reading.'));
    await quiet();
    const recovered = await capture.evaluate(() => ({ top: document.querySelector('ex-session-chat ex-chat-scroll .viewport').scrollTop, unread: !!document.querySelector('ex-session-chat .unread-dot') }));
    assert.ok(Math.abs(before - recovered.top) < 2, `Reconnection must keep the reading position: ${before} → ${recovered.top}`);
    assert.equal(recovered.unread, true);
    yield { name: `${theme}-recovered-reading-position`, inspect: ['ex-chat-scroll .viewport', 'ex-chat-scroll .return'], metadata: { before, recovered } };
    await capture.component('ex-session-chat', component => component.store.older());
    const historical = await capture.component('ex-session-chat', component => ({ first: component.store.items()[0]?.id, view: component.store.viewRevision() }));
    await capture.component('ex-reconnect-demo', component => component.platform.recover());
    await capture.waitFor(() => document.querySelector('.workspace-frame.ex-offline'));
    await capture.component('ex-reconnect-demo', component => component.platform.ready());
    await capture.waitFor(() => !document.querySelector('.workspace-frame.ex-offline')); await quiet();
    const after = await capture.component('ex-session-chat', component => ({ first: component.store.items()[0]?.id, view: component.store.viewRevision(), historical: component.store.historical() }));
    assert.equal(after.first, historical.first); assert.equal(after.view, historical.view); assert.equal(after.historical, true);
    yield { name: `${theme}-recovered-history-window`, inspect: ['ex-session-chat .history-controls'], metadata: { historical, after } };
  }
}
