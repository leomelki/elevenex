import assert from 'node:assert/strict';

/** Shared harness identity in connected replies, turns and standalone messages. */
export default async function* (capture) {
  await capture.evaluate(() => { location.href = '/connected-workspace'; });
  await capture.waitFor(() => document.querySelector('ex-workspace-navigation ex-task-list'));
  await capture.component('ex-machine-workspace', c => c.store.selectSession({ taskId: '11', sessionId: '101' }));
  await capture.waitFor(() => document.querySelector('ex-session-chat ex-turn .mark svg path'));
  assert.equal(await capture.evaluate(() => document.querySelector('ex-session-chat ex-turn .mark ex-agent-mark').textContent.trim()), '');
  yield { name: 'connected-codex', inspect: ['ex-session-chat ex-turn .mark', 'ex-agent-picker'] };

  await capture.evaluate(() => { location.href = '/conversation'; });
  await capture.waitFor(() => document.querySelector('ex-conversation-demo ex-chat'));
  await capture.component('ex-conversation-demo', c => c.exchanges.set([
    { id: 'claude', harness: 'claude', author: 'Claude Code', mark: 'CL', status: 'live', answer: 'Working with Claude Code.' },
    { id: 'codex', harness: 'codex', author: 'Codex', mark: 'CX', status: 'done', answer: 'The Codex reply uses the same mark as the agent picker.' },
    { id: 'opencode', harness: 'opencode', author: 'OpenCode', mark: 'OC', status: 'done', answer: 'OpenCode keeps its own harness identity.' },
    { id: 'pi', harness: 'pi', author: 'Pi', mark: 'PI', status: 'done', answer: 'Pi uses its bundled logo on a quiet neutral tile.' },
    { id: 'custom', harness: 'custom-agent', author: 'Custom agent', mark: 'CA', status: 'done', answer: 'Unknown agents keep a monogram.' },
    { id: 'legacy', author: 'Legacy agent', mark: 'LA', status: 'done', answer: 'Older callers without a harness ID keep their monogram too.' },
  ].map(exchange => ({ ...exchange, prompt: '', steps: [] }))));

  for (const theme of ['light', 'dark']) {
    await capture.theme(theme);
    await capture.viewport(1280, 960);
    await capture.reducedMotion(false);
    await capture.settle();
    const marks = await capture.evaluate(() => [...document.querySelectorAll('.demo-chat ex-turn .mark')].map(mark => {
      const inner = mark.querySelector('ex-agent-mark');
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 1;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      // Canvas resolves theme colour-mix/oklab values into sRGB for contrast.
      const luminance = colour => {
        context.fillStyle = colour;
        context.fillRect(0, 0, 1, 1);
        const rgb = [...context.getImageData(0, 0, 1, 1).data].slice(0, 3).map(value => {
          const channel = value / 255;
          return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
        });
        return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
      };
      const background = getComputedStyle(inner).backgroundColor;
      const stops = [...inner.querySelectorAll('stop')];
      const colours = stops.length ? stops.map(stop => getComputedStyle(stop).stopColor) : [getComputedStyle(inner).color];
      const tileLuminance = luminance(background);
      const contrast = Math.min(...colours.map(colour => {
        const glyphLuminance = luminance(colour);
        return (Math.max(tileLuminance, glyphLuminance) + 0.05) / (Math.min(tileLuminance, glyphLuminance) + 0.05);
      }));
      return {
        background, contrast,
        role: mark.getAttribute('role'), author: mark.getAttribute('aria-label'), title: mark.getAttribute('title'),
        logo: !!inner.querySelector('svg path'), text: inner.textContent.trim(),
        width: mark.getBoundingClientRect().width, height: mark.getBoundingClientRect().height,
        innerWidth: inner.getBoundingClientRect().width, innerHeight: inner.getBoundingClientRect().height,
        hidden: inner.getAttribute('aria-hidden'),
      };
    }));
    assert.equal(marks.length, 6);
    assert.deepEqual(marks.map(mark => mark.logo), [true, true, true, true, false, false]);
    assert.deepEqual(marks.slice(4).map(mark => mark.text), ['CA', 'LA']);
    assert.ok(marks.every(mark => mark.width === 28 && mark.height === 28 && mark.innerWidth === 28 && mark.innerHeight === 28));
    assert.ok(marks.every(mark => mark.title === mark.author && mark.role === 'img' && mark.hidden === 'true'));
    assert.ok(marks.every(mark => mark.contrast >= 3), JSON.stringify(marks.map(({author, contrast}) => ({author, contrast}))));
    await capture.evaluate(() => document.querySelector('.demo-chat ex-turn').focus());
    await capture.press('c');
    assert.equal(await capture.component('ex-conversation-demo', c => c.lastAction()), 'copy');
    yield { name: theme + '-reply-logos', selector: '.demo-chat', inspect: ['.demo-chat ex-turn .mark', '.demo-chat ex-agent-mark'], metadata: { marks } };

    await capture.viewport(520, 900);
    await capture.reducedMotion(true);
    await capture.settle();
    assert.equal(await capture.evaluate(() => document.querySelector('.demo-chat').scrollWidth > document.querySelector('.demo-chat').clientWidth), false);
    assert.equal(await capture.evaluate(() => getComputedStyle(document.querySelector('.demo-chat ex-turn.live .mark')).animationName), 'none');
    yield { name: theme + '-narrow-reduced', selector: '.demo-chat', inspect: ['.demo-chat ex-turn .mark'] };

    await capture.viewport(1280, 960);
    await capture.evaluate(() => document.querySelector('ex-side-thread ex-message.agent').scrollIntoView({ block: 'center' }));
    await capture.settle();
    assert.equal(await capture.evaluate(() => !!document.querySelector('ex-side-thread ex-message.agent .mark svg path')), true);
    yield { name: theme + '-standalone-agent', selector: 'ex-side-thread', inspect: ['ex-side-thread ex-message.agent .mark'] };
    await capture.evaluate(() => document.querySelector('.demo-chat').scrollIntoView({ block: 'start' }));
  }
}
