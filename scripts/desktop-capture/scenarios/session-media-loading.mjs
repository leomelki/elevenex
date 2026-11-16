import assert from 'node:assert/strict';

export default async function* (capture) {
  await capture.evaluate(() => { location.href = '/conversation'; });
  await capture.waitFor(() => document.querySelector('.async-gallery .image-slot'));
  const phase = value => capture.component('ex-conversation-demo', (owner, value) => owner.mediaPhase.set(value), value);
  const geometry = () => capture.evaluate(() => [...document.querySelectorAll('.async-media .image-slot, .async-media .compare-images, .async-media .media-window')].map(element => {
    const rect = element.getBoundingClientRect();
    return { width: rect.width, height: rect.height };
  }));
  for (const theme of ['light', 'dark']) {
    await capture.theme(theme);
    for (const narrow of [false, true]) {
      await capture.viewport(narrow ? 1000 : 1440, narrow ? 760 : 960);
      await capture.reducedMotion(narrow);
      await phase('loading');
      const before = await geometry();
      assert.equal(before.length, 5, 'Three gallery slots, one comparison and one recording must be reserved');
      for (const value of ['partial', 'ready', 'error', 'ready']) {
        await phase(value);
        assert.deepEqual(await geometry(), before, `${value} changed media geometry`);
      }
      await capture.evaluate(() => document.querySelector('.async-gallery').scrollIntoView({ block: 'center' }));
      await capture.evaluate(() => document.querySelector('.async-gallery .image').focus());
      await capture.press('Enter');
      await capture.waitFor(() => document.querySelector('.async-gallery dialog[open]'));
      await capture.press('ArrowRight');
      await capture.press('Escape');
      await capture.waitFor(() => !document.querySelector('.async-gallery dialog[open]'));
      assert.equal(await capture.evaluate(() => !!document.activeElement?.closest('.async-gallery')), true);
      const prefix = `${theme}-${narrow ? 'narrow-reduced' : 'wide'}`;
      yield { name: `${prefix}-gallery-ready`, inspect: ['.async-gallery .image-slot'], metadata: { frames: before } };
      await capture.evaluate(() => document.querySelector('.async-comparison').scrollIntoView({ block: 'center' }));
      yield { name: `${prefix}-comparison-ready`, inspect: ['.async-comparison .compare-images', '.async-comparison input'] };
      await phase('error');
      await capture.evaluate(() => document.querySelector('.async-recording').scrollIntoView({ block: 'center' }));
      yield { name: `${prefix}-recording-unavailable`, inspect: ['.async-recording .media-window', '.async-recording .controls'] };
    }
  }
}
