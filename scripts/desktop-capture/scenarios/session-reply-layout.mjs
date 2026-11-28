import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

/** Capture the reply itself from its first paint, including reserved media and
 * delayed ResizeObserver delivery. A stable composer alone cannot detect this. */
export default async function* (capture) {
  const pages = process.env.ELEVENEX_SESSION_CAPTURE_PAGES
    ? JSON.parse(await readFile(process.env.ELEVENEX_SESSION_CAPTURE_PAGES, 'utf8')) : [];
  const source = Array.isArray(pages) ? pages[0] : pages;
  for (const theme of ['light', 'dark']) {
    for (const layout of ['wide', 'narrow', 'narrow-reduced']) {
      await capture.evaluate(() => { location.href = '/connected-workspace'; });
      await capture.waitFor(() => document.querySelector('ex-machine-workspace ex-task-list'));
      await capture.theme(theme);
      await capture.viewport(layout === 'wide' ? 1440 : 1000, layout === 'wide' ? 960 : 760);
      await capture.reducedMotion(layout === 'narrow-reduced');
      await capture.component('ex-connected-workspace-demo', async (owner, source) => {
        if (source) owner.fixture.chat.seed(101, source);
        else {
          owner.fixture.chat.scenario('images', 101);
          const result = await owner.fixture.chat.read({ taskId: 11, sessionId: 101, requestId: window.crypto.randomUUID() });
          if (!result.ok) throw new Error('Could not prepare the image history');
          const prompt = result.value.items.find(item => item.kind === 'user');
          const tool = result.value.items.find(item => item.kind === 'tool_result');
          const reply = result.value.items.find(item => item.kind === 'assistant');
          // The latest 80-item page starts mid-turn, just like a long real
          // session. Prefetch must replace that partial turn without moving it.
          owner.fixture.chat.seed(101, { state: result.value.state, items: [prompt,
            ...Array.from({ length: 90 }, (_, index) => ({ ...tool, id: `evidence-${index}`, text: `Checked source ${index}`, media: [] })), reply] });
        }
        owner.fixture.chat.scenario('new', 102);
      }, source);
      await capture.component('ex-machine-workspace', owner => owner.store.selectSession({ taskId: '11', sessionId: '102' }));
      for (const visit of ['cold', 'cached']) {
        const frames = await capture.component('ex-machine-workspace', async owner => {
          owner.store.selectSession({ taskId: '11', sessionId: '101' });
          window.ng.applyChanges(owner);
          const frames = [];
          for (let attempt = 0; frames.length < 60 && attempt < 180; attempt++) {
            await new Promise(requestAnimationFrame);
            const viewport = document.querySelector('ex-chat-scroll .viewport');
            const reply = document.querySelector('ex-session-chat ex-turn:last-of-type .answer');
            if (!viewport || !reply) continue;
            const rect = reply.getBoundingClientRect();
            frames.push({ top: rect.top, height: rect.height, scrollTop: viewport.scrollTop, scrollHeight: viewport.scrollHeight,
              gap: viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop,
              media: [...reply.querySelectorAll('.media-frame')].map(element => {
                const box = element.getBoundingClientRect(); return { top: box.top, height: box.height };
              }), heightAnimations: document.getAnimations().filter(animation =>
                reply.contains(animation.effect?.target) && animation.playState === 'running' &&
                animation.effect.getKeyframes().some(frame => frame.height !== undefined)).length });
          }
          return frames;
        });
        assert.equal(frames.length, 60, 'Expected a reply on the first render');
        assert.ok(frames[0].media.length, 'This regression needs a reply ending in media');
        for (const frame of frames) {
          assert.ok(Math.abs(frame.top - frames[0].top) <= 1, 'Reply moved after its first paint');
          assert.ok(Math.abs(frame.height - frames[0].height) <= 1, 'Reply changed height while media resolved');
          assert.ok(Math.abs(frame.gap) <= 1, 'Latest reply drifted from the end');
          assert.equal(frame.heightAnimations, 0, 'Opening history must not start a reply height animation');
          assert.deepEqual(frame.media, frames[0].media, 'Media moved while its reserved size stayed unchanged');
        }
        yield { name: `${theme}-${layout}-${visit}-reply`, inspect: ['ex-chat-scroll .viewport', 'ex-turn:last-of-type .answer', '.media-frame'],
          metadata: { sourceSession: source?.id ?? 'preview', frames } };
        await capture.component('ex-machine-workspace', owner => owner.store.selectSession({ taskId: '11', sessionId: '102' }));
      }
      if (!source && layout !== 'narrow-reduced') {
        await capture.component('ex-connected-workspace-demo', async owner => {
          const result = await owner.fixture.chat.read({ taskId: 11, sessionId: 101, requestId: window.crypto.randomUUID() });
          if (!result.ok) throw new Error('Could not prepare the refreshed reply');
          const table = '| Step | Result |\n| --- | --- |\n' +
            Array.from({ length: 24 }, (_, index) => `| Step ${index + 1} | Complete |`).join('\n');
          owner.fixture.chat.seed(101, { ...result.value, items: result.value.items.map(item =>
            item.kind === 'assistant' ? { ...item, text: `${item.text}\n\n${table}` } : item) });
          owner.fixture.chat.holdReads(true);
        });
        await capture.component('ex-machine-workspace', owner => owner.store.selectSession({ taskId: '11', sessionId: '101' }));
        assert.equal(await capture.evaluate(() => !!document.querySelector('ex-turn .answer table')), false,
          'The previous reply should be usable immediately from cache');
        const frames = await capture.component('ex-connected-workspace-demo', async owner => {
          owner.fixture.chat.holdReads(false);
          const frames = [];
          for (let attempt = 0; frames.length < 24 && attempt < 180; attempt++) {
            await new Promise(requestAnimationFrame);
            const viewport = document.querySelector('ex-chat-scroll .viewport');
            const reply = viewport?.querySelector('ex-turn:last-of-type .answer');
            if (!reply?.querySelector('table')) continue;
            frames.push({
              top: reply.getBoundingClientRect().top,
              gap: viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop,
              clipped: reply.clientHeight + 1 < reply.scrollHeight,
              animating: reply.getAnimations().some(animation =>
                animation.effect.getKeyframes().some(frame => frame.height !== undefined)),
            });
          }
          return frames;
        });
        assert.equal(frames.length, 24, 'The fresh saved reply should render');
        for (const frame of frames) {
          assert.ok(Math.abs(frame.gap) <= 1, JSON.stringify(frame));
          assert.equal(frame.clipped || frame.animating, false, 'The saved reply should paint at full height immediately');
          assert.ok(Math.abs(frame.top - frames[0].top) <= 1, 'The saved reply should stay in place');
        }
        yield { name: `${theme}-${layout}-refreshed-reply`, inspect: ['ex-chat-scroll .viewport', 'ex-turn:last-of-type .answer'],
          metadata: { frames } };
      }
    }
  }
}
