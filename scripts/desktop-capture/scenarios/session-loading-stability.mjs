import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

/** Exercise production ownership with deliberately held reads, including cached first paints.
 * Optional bounded recorded pages stay in ignored artifacts, never in the product bundle. */
export default async function* (capture) {
  const recorded = process.env.ELEVENEX_SESSION_CAPTURE_PAGES
    ? JSON.parse(await readFile(process.env.ELEVENEX_SESSION_CAPTURE_PAGES, 'utf8')) : [];
  const quiet = async () => {
    await capture.settle();
    await capture.waitFor(() => document.getAnimations().every(animation =>
      !Number.isFinite(animation.effect?.getComputedTiming().endTime) || animation.playState !== 'running'));
  };
  const select = id => capture.component('ex-machine-workspace', (owner, id) => owner.store.selectSession({ taskId: '11', sessionId: id }), id);
  const hold = held => capture.component('ex-connected-workspace-demo', (owner, held) => owner.fixture.chat.holdReads(held), held);
  const probe = (action = 'sample') => capture.component(action === 'release' ? 'ex-connected-workspace-demo' : 'ex-machine-workspace', async (owner, action) => {
    if (action === 'release') owner.fixture.chat.holdReads(false);
    else if (action !== 'sample') owner.store.selectSession({ taskId: '11', sessionId: action });
    window.ng.applyChanges(owner);
    const frames = [];
    for (let attempt = 0; frames.length < 40 && attempt < 180; attempt++) {
      await new Promise(requestAnimationFrame);
      if (!document.querySelector('ex-composer')) continue;
      const box = selector => {
        const element = document.querySelector(selector);
        const rect = element?.getBoundingClientRect();
        return rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null;
      };
      const viewport = document.querySelector('ex-chat-scroll .viewport');
      const controls = [...document.querySelectorAll('ex-composer .bar button')].map(element => {
        const rect = element.getBoundingClientRect();
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
      });
      frames.push({ composer: box('ex-composer'), editor: box('ex-composer textarea'), header: box('ex-workspace-task-header'), controls,
        gap: viewport ? viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop : 0 });
    }
    if (frames.length !== 40) throw new Error('Conversation never became ready');
    return frames;
  }, action);
  const stable = frames => {
    for (const frame of frames) {
      assert.deepEqual(frame.composer, frames[0].composer, 'Composer moved after its first rendered frame');
      assert.deepEqual(frame.editor, frames[0].editor, 'Editor resized after hydration');
      assert.deepEqual(frame.header, frames[0].header, 'Task header shifted');
      assert.deepEqual(frame.controls, frames[0].controls, 'Composer controls shifted after first paint');
      assert.ok(Math.abs(frame.gap) <= 1, `Latest reply is clipped: ${JSON.stringify(frame)}`);
    }
  };
  for (const theme of ['light', 'dark']) {
    for (const narrow of [false, true]) {
      const prefix = `${theme}-${narrow ? 'narrow-reduced' : 'wide'}`;
      await capture.evaluate(() => { location.href = '/connected-workspace'; });
      await capture.waitFor(() => document.querySelector('ex-machine-workspace ex-task-list'));
      await capture.theme(theme);
      await capture.viewport(narrow ? 1000 : 1440, narrow ? 760 : 960);
      await capture.reducedMotion(narrow);
      await capture.component('ex-connected-workspace-demo', owner => {
        owner.fixture.chat.scenario('history', 101);
        owner.fixture.chat.scenario('new', 102);
        owner.fixture.chat.coldModels(102, 'gpt-6');
        owner.fixture.chat.catalogBehavior(400);
      });
      await select('101');
      await capture.waitFor(() => document.querySelectorAll('ex-session-chat ex-message').length >= 20);
      await quiet();
      await hold(true);
      await select('102');
      assert.equal(await capture.evaluate(() => !!document.querySelector('ex-session-chat ex-composer')), false);
      await capture.waitFor(() => {
        const skeleton = document.querySelector('ex-chat-loading .skeleton');
        return skeleton && getComputedStyle(skeleton).opacity === '1';
      });
      yield { name: `${prefix}-cold-loading`, inspect: ['ex-chat-loading .skeleton', 'ex-workspace-task-header'] };
      const initial = await probe('release'); stable(initial);
      assert.ok(await capture.evaluate(() => document.querySelector('ex-chat.center-composer ex-preset-picker')));
      yield { name: `${prefix}-empty-ready`, inspect: ['ex-session-chat', 'ex-composer'], metadata: { frames: initial } };

      // A cached session is usable before the pending refresh returns. Sample
      // the very next paint, rather than waiting until loading has finished.
      await hold(true);
      const cached = await probe('101'); stable(cached);
      assert.equal(await capture.component('ex-session-chat', owner => owner.store.loading()), false);
      assert.equal(await capture.evaluate(() => !!document.querySelector('ex-chat-loading .skeleton')), false);
      assert.ok(cached[0].composer);
      yield { name: `${prefix}-cached-refresh-pending`, inspect: ['ex-chat-scroll .viewport', 'ex-composer'], metadata: { frames: cached } };
      await hold(false); await quiet();
      await capture.fill('ex-composer textarea', 'A retained draft\nwith several lines\nthat grows the composer');
      await quiet(); stable(await probe());
      const readingTop = await capture.evaluate(() => {
        const viewport = document.querySelector('ex-chat-scroll .viewport');
        viewport.scrollTop = Math.floor((viewport.scrollHeight - viewport.clientHeight) / 2);
        viewport.dispatchEvent(new window.Event('scroll'));
        return viewport.scrollTop;
      });
      await capture.component('ex-session-chat', owner => owner.store.refresh());
      assert.equal(await capture.evaluate(() => document.querySelector('ex-chat-scroll .viewport').scrollTop), readingTop);

      const height = await capture.evaluate(() => document.querySelector('ex-workspace-task-header').getBoundingClientRect().height);
      await capture.component('ex-workspace-task-header', owner => owner.git.summary.update(value => ({ ...value, behind: 7 })));
      assert.ok(await capture.evaluate(() => document.querySelector('ex-workspace-task-header .sync')));
      await capture.component('ex-workspace-task-header', owner => owner.git.error.set('The remote could not be reached. Refresh status to try again.'));
      await quiet();
      assert.equal(await capture.evaluate(() => document.querySelector('ex-workspace-task-header').getBoundingClientRect().height), height);
      yield { name: `${prefix}-git-error-stable`, inspect: ['ex-workspace-task-header', 'ex-composer'] };

      if (recorded.length) {
        await capture.component('ex-connected-workspace-demo', (owner, pages) => {
          for (let index = 0; index < pages.length; index++) owner.fixture.chat.seed(101 + index, pages[index]);
        }, recorded);
        let visit = 0;
        for (const id of ['102', '101', '102']) {
          await select(id); await capture.component('ex-session-chat', owner => owner.store.refresh());
          await quiet(); stable(await probe());
          yield { name: `${prefix}-recorded-${recorded[Number(id) - 101].id}-visit-${++visit}`,
            inspect: ['ex-session-chat', 'ex-composer'], metadata: { sourceSession: recorded[Number(id) - 101].id } };
        }
      }
    }
  }
}
