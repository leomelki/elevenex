import assert from 'node:assert/strict';

export default async function* (capture) {
  await capture.waitFor(() => document.readyState === 'complete');
  await capture.waitFor(() => document.querySelector('a[href="/machines"]'));
  await capture.click('a[href="/machines"]');
  await capture.waitFor(() => document.querySelector('ex-diff-review .line'));
  const owner = (change, data) => capture.component('ex-machines-views-demo', change, data);
  const scroll = top => capture.evaluate(top => { document.querySelector('ex-diff-review .scroller').scrollTop = top; }, top);
  const pose = () => capture.evaluate(() => {
    const root = document.querySelector('ex-diff-review'), scroller = root.querySelector('.scroller');
    const viewport = scroller.getBoundingClientRect();
    return [...root.querySelectorAll('.stream > [data-file-id]')].map(card => {
      const header = card.querySelector('header'), rect = header.getBoundingClientRect(), style = getComputedStyle(header);
      const children = [...header.children].map(child => child.getBoundingClientRect());
      return { id: card.dataset.fileId, top: rect.top - viewport.top, bottom: rect.bottom - viewport.top,
        height: rect.height, stuck: header.classList.contains('stuck'), shadow: style.boxShadow,
        topRadius: style.borderTopLeftRadius, rowHeight: parseFloat(style.getPropertyValue('--row-height')),
        overflow: children.some(child => child.left < rect.left - .5 || child.right > rect.right + .5),
        foldFill: getComputedStyle(card.querySelector('.fold')).backgroundColor,
      };
    });
  });
  for (const theme of ['light', 'dark']) {
    await capture.theme(theme); await capture.reducedMotion(true);
    for (const [layout, width, windowWidth] of [['compact', 440, 740], ['narrow', 320, 560], ['wide', 0, 1240]]) {
      await capture.viewport(windowWidth, 900);
      await owner((component, state) => {
        const revision = `${state.theme}-${state.layout}`;
        const files = [
          { id: 'retry', path: 'src/payments/retry.ts', status: 'M', add: 12, del: 5, rev: revision },
          { id: 'tests', path: 'src/payments/retry.spec.ts', status: 'A', add: 24, del: 0, rev: revision, changedSinceViewed: true },
        ];
        component.files.set(files); component.currentFile.set('retry'); component.wide.set(state.layout === 'wide'); component.wrap.set(true);
        component.contents.set(files.map(file => ({ fileId: file.id, rev: revision, mode: 'changes', state: 'ready', hunks: [{
          id: `${file.id}-hunk`, heading: '@@ -1,180 +1,180 @@ payment retry',
          lines: Array.from({ length: 180 }, (_, index) => ({
            id: `${file.id}-${index}`, kind: index % 7 === 0 ? 'add' : 'context',
            oldNumber: index + 1, newNumber: index + 1, text: `  const attempt${index} = retryPayment(charge);`,
          })),
        }] })));
      }, { theme, layout });
      await capture.evaluate(width => {
        const panel = document.querySelector('.review-demo'); panel.style.width = width ? `${width}px` : '';
        panel.closest('section').scrollIntoView({ block: 'center' });
      }, width);
      await scroll(0); await capture.waitFor(() => !document.querySelector('ex-diff-review header.stuck'));
      await capture.hover('[data-file-id="retry"] .fold');
      const resting = await pose();
      for (const header of resting) {
        assert.equal(header.height, header.rowHeight, 'One token-sized row for every file header');
        assert.equal(header.overflow, false, 'Controls stay inside narrow headers');
        assert.equal(header.foldFill, 'rgba(0, 0, 0, 0)', 'Hover must not paint a large inset block');
      }
      yield { name: `${theme}-${layout}-hover`, metadata: { headers: resting }, inspect: ['ex-diff-review .toolbar', '.updated', '[data-file-id="retry"] header'] };
      await capture.hover('[data-file-id="retry"] .viewed');
      const actionHover = await pose();
      assert.equal(actionHover[0].height, resting[0].height);
      assert.equal(actionHover[0].top, resting[0].top);

      await scroll(140); await capture.waitFor(() => document.querySelector('[data-file-id="retry"] header.stuck'));
      const pinned = await pose();
      assert.ok(Math.abs(pinned[0].top) < .5, 'Pinned header sits flush below the toolbar');
      assert.equal(pinned[0].height, resting[0].height);
      assert.equal(pinned[0].topRadius, '0px'); assert.notEqual(pinned[0].shadow, resting[0].shadow);
      await capture.hover('[data-file-id="retry"] .fold');
      yield { name: `${theme}-${layout}-pinned`, metadata: { headers: pinned }, inspect: ['ex-diff-review .scroller', 'header.stuck'] };

      await capture.evaluate(() => {
        const scroller = document.querySelector('ex-diff-review .scroller'), first = scroller.querySelector('[data-file-id="retry"]');
        scroller.scrollTop += first.getBoundingClientRect().bottom - scroller.getBoundingClientRect().top - 16;
      });
      await capture.settle();
      const boundary = await pose();
      assert.ok(boundary[0].top < 0, 'Outgoing header is pushed out by its own file boundary');
      assert.ok(boundary[0].bottom <= boundary[1].top, 'File headers never cover each other');
      yield { name: `${theme}-${layout}-handoff`, metadata: { headers: boundary } };
      await capture.evaluate(() => { document.querySelector('ex-diff-review .scroller').scrollTop += 160; });
      await capture.waitFor(() => document.querySelector('[data-file-id="tests"] header.stuck'));
      const next = await pose(); assert.ok(Math.abs(next[1].top) < .5); assert.equal(next[0].stuck, false);

      await scroll(140); await capture.waitFor(() => document.querySelector('[data-file-id="retry"] header.stuck'));
      await capture.click('[data-file-id="retry"] .fold');
      await capture.waitFor(() => document.querySelector('[data-file-id="retry"] .fold').getAttribute('aria-expanded') === 'false');
      await capture.waitFor(() => !document.querySelector('[data-file-id="retry"] header.stuck'));
      const collapsed = await pose();
      assert.ok(Math.abs(collapsed[0].top) < 1, 'Collapsing from a pinned header keeps that header in place');
      yield { name: `${theme}-${layout}-collapsed`, metadata: { headers: collapsed } };
      await capture.click('[data-file-id="retry"] .fold');
      await capture.waitFor(() => document.querySelector('[data-file-id="retry"] .fold').getAttribute('aria-expanded') === 'true');
      await owner(component => component.files.update(files => files.map(file => file.id === 'retry' ? {
        ...file, path: 'src/payments/very/deep/folder/PaymentRetryWithAnExtremelyLongFilename.component.ts', add: 245, del: 32,
      } : file)));
      const longName = await pose(); assert.equal(longName[0].overflow, false);
      yield { name: `${theme}-${layout}-long-path`, metadata: { headers: longName } };
    }
    await capture.reducedMotion(false);
    await scroll(140); await capture.waitFor(() => document.querySelector('[data-file-id="retry"] header.stuck'));
    await capture.click('[data-file-id="retry"] .viewed');
    await capture.waitFor(() => document.querySelector('[data-file-id="retry"] .viewed').getAttribute('aria-pressed') === 'true');
    await capture.waitFor(() => document.querySelector('[data-file-id="retry"] .fold').getAttribute('aria-expanded') === 'false');
    await capture.evaluate(async () => {
      await Promise.all(document.querySelector('ex-diff-review').getAnimations({ subtree: true })
        .filter(animation => Number.isFinite(animation.effect?.getComputedTiming().endTime)).map(animation => animation.finished.catch(() => undefined)));
    });
    yield { name: `${theme}-viewed-motion`, inspect: ['[data-file-id="retry"] header'] };
  }
}
