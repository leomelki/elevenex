import assert from 'node:assert/strict';

/** Background reconciliation must preserve the mounted view and reading position. */
export default async function* (capture) {
  await capture.evaluate(() => { location.href = '/connected-workspace'; });
  await capture.waitFor(() => document.querySelector('ex-workspace-navigation ex-task-list'));
  await capture.component('ex-connected-workspace-demo', component => {
    component.fixture.chat.scenario('history', 101);
    component.fixture.archivedHistory();
  });
  await capture.component('ex-machine-workspace', async component => {
    await component.store.refresh();
    await component.store.loadArchivedSessions({ taskId: '11', page: 'latest' });
    component.store.selectSession({ taskId: '11', sessionId: '101' });
  });
  await capture.waitFor(() => {
    const chat = document.querySelector('ex-session-chat');
    return chat && window.ng.getComponent(chat).store.items().length;
  });
  for (const theme of ['light', 'dark']) {
    await capture.theme(theme);
    for (const narrow of [false, true]) {
      await capture.viewport(narrow ? 980 : 1440, 900);
      await capture.reducedMotion(narrow);
      await capture.fill('ex-composer textarea', 'Keep my draft and cursor');
      await capture.evaluate(() => {
        const viewport = document.querySelector('ex-chat-scroll .viewport');
        viewport.scrollTop = 150;
        viewport.dispatchEvent(new window.Event('scroll'));
      });
      await capture.waitFor(() => document.getAnimations().every(animation =>
        !Number.isFinite(animation.effect?.getComputedTiming().endTime) || animation.playState !== 'running'));
      for (const [mode, revision] of [['unchanged', 1], ['failure', 2], ['recovery', 2]]) {
        const probe = await capture.component('ex-connected-workspace-demo', async (demo, { mode, revision }) => {
          const fixture = demo.fixture;
          const original = { revision: fixture.workspaceRevision, tasks: fixture.workspaceTasks,
            sessions: fixture.workspaceSessions, git: fixture.workspaceGit };
          let taskReads = 0, gitReads = 0;
          const delayed = () => new Promise(resolve => setTimeout(resolve, 350));
          fixture.workspaceRevision = async () => {
            const result = await original.revision();
            return result.ok ? { ...result, value: { ...result.value, revision } } : result;
          };
          fixture.workspaceTasks = async (...args) => {
            taskReads++; await delayed(); return original.tasks(...args);
          };
          const failure = { ok: false, error: { code: 'transport', message: 'Temporary background failure' } };
          fixture.workspaceSessions = async (...args) => mode === 'failure' ? failure : original.sessions(...args);
          fixture.workspaceGit = async (...args) => {
            gitReads++; await delayed(); return mode === 'failure' ? failure : original.git(...args);
          };
          const workspace = document.querySelector('ex-machine-workspace');
          const owner = window.ng.getComponent(workspace);
          const header = window.ng.getComponent(workspace.querySelector('ex-workspace-task-header'));
          const chat = document.querySelector('ex-session-chat');
          const viewport = chat.querySelector('ex-chat-scroll .viewport');
          const composer = chat.querySelector('textarea');
          const mounted = [...workspace.querySelectorAll('ex-session-chat, ex-turn, ex-session-row, ex-workspace-task-header')];
          const selectors = ['ex-workspace-task-header', 'ex-session-chat', 'ex-composer',
            'ex-workspace-navigation header', 'ex-workspace-navigation ex-status-summary'];
          const boxes = selectors.map(selector => workspace.querySelector(selector).getBoundingClientRect());
          const scrollTop = viewport.scrollTop, scrollHeight = viewport.scrollHeight;
          const selection = [composer.selectionStart, composer.selectionEnd];
          const controls = [...workspace.querySelectorAll('button, textarea')];
          const disabled = controls.map(control => control.disabled);
          const violations = new Set();
          let frames = 0;
          try {
            window.dispatchEvent(new window.Event('focus'));
            const start = performance.now();
            do {
              await new Promise(requestAnimationFrame); frames++;
              if (owner.store.loading()) violations.add('workspace loading');
              if (header.git.loading()) violations.add('git loading');
              if (owner.store.tasks().some(task => task.archive?.loading)) violations.add('archive loading');
              if (mounted.some(element => !element.isConnected)) violations.add('remounted content');
              if (viewport.scrollTop !== scrollTop || viewport.scrollHeight !== scrollHeight) violations.add('reading position');
              if (document.activeElement !== composer || composer.value !== 'Keep my draft and cursor' ||
                  composer.selectionStart !== selection[0] || composer.selectionEnd !== selection[1]) violations.add('draft or focus');
              if (controls.some((control, index) => control.disabled !== disabled[index])) violations.add('disabled control flash');
              if ([...workspace.querySelectorAll('[role="alert"]')].some(element => {
                const box = element.getBoundingClientRect();
                return box.width && box.height && !element.closest('[inert]') && getComputedStyle(element).visibility !== 'hidden';
              })) violations.add('error flash');
              selectors.forEach((selector, index) => {
                const box = workspace.querySelector(selector).getBoundingClientRect();
                if (['x', 'y', 'width', 'height'].some(key => Math.abs(box[key] - boxes[index][key]) > 0.5)) violations.add(`layout: ${selector}`);
              });
            } while (performance.now() - start < 900);
            return { violations: [...violations], taskReads, gitReads, frames, scrollTop };
          } finally {
            fixture.workspaceRevision = original.revision; fixture.workspaceTasks = original.tasks;
            fixture.workspaceSessions = original.sessions; fixture.workspaceGit = original.git;
          }
        }, { mode, revision });
        assert.ok(probe.frames > 5, 'Observe real frames through delayed reads');
        assert.ok(probe.taskReads > 0 && probe.gitReads > 0, JSON.stringify(probe));
        assert.deepEqual(probe.violations, []);
        yield { name: `${theme}-${narrow ? 'narrow-reduced' : 'full'}-${mode}`,
          inspect: ['ex-workspace-navigation', 'ex-workspace-task-header', 'ex-session-chat', 'ex-composer'], metadata: probe };
      }
    }
  }
}
