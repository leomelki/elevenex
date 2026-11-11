import assert from 'node:assert/strict';

/** Activity must consume the selected-session feed without opening an inspector. */
export default async function* (capture) {
  await capture.evaluate(() => { location.href = '/connected-workspace'; });
  await capture.waitFor(() => !!document.querySelector('ex-workspace-navigation ex-task-list'));
  await capture.component('ex-machine-workspace', c => c.store.selectSession({ taskId: '11', sessionId: '101' }));
  await capture.waitFor(() => document.querySelector('ex-agent-picker > button')?.disabled === false);
  const publish = work => capture.component('ex-connected-workspace-demo', (c, work) => c.fixture.chat.work(work, 101, 'codex'), work);
  for (const theme of ['light', 'dark']) {
    await capture.theme(theme);
    for (const width of [1440, 620]) {
      await capture.viewport(width, 900);
      await capture.reducedMotion(width === 620);
      const startedAt = new Date().toISOString();
      const agent = {
        id: 'subagent:live-reviewer', agentId: 'live-reviewer', kind: 'agent',
        label: 'agent', detail: '', status: 'running', startedAt,
        stoppable: true, orphaned: false, inspectable: true, background: true,
      };
      await publish({ running: [agent], recent: [], totalRunning: 1 });
      await capture.waitFor(() => !!document.querySelector('ex-session-activity .trigger'));
      // Metadata arrives while the panel and inspector are still closed.
      const loaded = { ...agent, label: 'James · reviewer', title: 'James', role: 'reviewer', detail: 'Review the live feed', model: 'child-model' };
      await publish({ running: [loaded], recent: [], totalRunning: 1 });
      await capture.click('ex-session-activity .trigger');
      await capture.waitFor(() => document.querySelector('.panel .work .title')?.textContent === 'James');
      assert.equal(await capture.evaluate(() => document.querySelector('.panel .work .role')?.textContent), 'reviewer');
      yield { name: `${theme}-${width}-metadata-without-inspection`, selector: '.cdk-overlay-container .panel', inspect: ['.panel', '.panel .work'] };

      await publish({ running: [{ ...loaded, detail: 'Checking update ownership' }], recent: [], totalRunning: 1 });
      await capture.waitFor(() => document.querySelector('.panel .work')?.textContent.includes('Checking update ownership'));
      assert.equal(await capture.evaluate(() => !!document.querySelector('.agent-dialog')), false);
      yield { name: `${theme}-${width}-live-preview`, selector: '.cdk-overlay-container .panel', inspect: ['.panel .work'] };

      await publish({ running: [], totalRunning: 0, recent: [{
        id: 'finished:live-reviewer', kind: 'finished', tone: 'success',
        title: 'James finished', detail: 'The update path is verified.', at: new Date().toISOString(), agentId: agent.agentId,
      }] });
      await capture.waitFor(() => !document.querySelector('.panel .work') && document.querySelector('.panel .event')?.textContent.includes('James finished'));
      yield { name: `${theme}-${width}-live-completion`, selector: '.cdk-overlay-container .panel', inspect: ['.panel', '.panel .event'] };
      await capture.press('Escape');
      await capture.waitFor(() => !document.querySelector('.cdk-overlay-container .panel'));
    }
  }
}
