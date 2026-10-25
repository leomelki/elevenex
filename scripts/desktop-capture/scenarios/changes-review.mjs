import assert from 'node:assert/strict';

// Uses real review components; all supplied data stays in the isolated preview.
export default async function* (capture) {
  await capture.viewport(1240, 1000);
  await capture.waitFor(() => document.querySelector('a[href="/machines"]'));
  await capture.click('a[href="/machines"]');
  await capture.waitFor(() => document.querySelector('ex-diff-review .line'));
  const owner = (fn, data) => capture.component('ex-machines-views-demo', fn, data);
  const initial = await owner(component => ({ files: component.files(), contents: component.contents() }));
  const finish = async () => {
    await capture.evaluate(async () => {
      await Promise.all(document.querySelector('ex-diff-review').getAnimations({ subtree: true })
        .filter(animation => Number.isFinite(animation.effect?.getComputedTiming().endTime))
        .map(animation => animation.finished.catch(() => undefined)));
    });
    await capture.settle();
  };
  const position = width => capture.evaluate(width => {
    const panel = document.querySelector('.review-demo');
    panel.style.width = width ? `${width}px` : '';
    panel.scrollIntoView({ block: 'center' });
  }, width);
  const fits = () => capture.evaluate(() => {
    const root = document.querySelector('ex-diff-review'), bounds = root.getBoundingClientRect();
    return [...root.querySelectorAll('.toolbar, .file-navigation, .review-tools, .jump, .viewed-count, .modes, .stream, ex-diff-file header')]
      .filter(element => element.checkVisibility()).map(element => {
        const rect = element.getBoundingClientRect();
        return { element: element.className || element.tagName, overflow: Math.max(0, bounds.left - rect.left, rect.right - bounds.right) };
      });
  });
  const assertFits = async () => {
    const layout = await fits();
    assert.ok(layout.every(element => element.overflow < 1), JSON.stringify(layout));
    return layout;
  };
  for (const theme of ['light', 'dark']) {
    await capture.theme(theme);
    await capture.reducedMotion(false);
    await owner((component, initial) => {
      component.files.set(initial.files); component.contents.set(initial.contents);
      component.currentFile.set('retry'); component.mode.set('changes'); component.wide.set(false); component.wrap.set(true);
    }, initial);
    await position(440); await finish();
    const exact = await capture.evaluate(() => [...document.querySelectorAll('[data-file-id="retry"] .code')].map(element => element.textContent));
    assert.equal(exact[1], '  return await send(charge);');
    assert.equal(exact[5], '  });');
    assert.equal(exact[6], '}');
    const filename = await capture.evaluate(() => {
      const label = document.querySelector('ex-diff-review .jump > span');
      return { scroll: label.scrollWidth, width: label.clientWidth };
    });
    assert.ok(filename.scroll <= filename.width, 'A short filename must fit at panel width');
    yield { name: `${theme}-compact`, inspect: ['ex-diff-review .toolbar', 'ex-diff-review .jump', 'ex-diff-file .body'], metadata: { layout: await assertFits() } };

    await capture.click('ex-diff-review .jump');
    await capture.waitFor(() => document.activeElement?.getAttribute('role') === 'listbox');
    await capture.press('ArrowDown');
    assert.equal(await capture.evaluate(() => !!document.querySelector('.file-menu')), true);
    assert.equal(await owner(component => component.currentFile()), 'tests');
    yield { name: `${theme}-file-picker`, inspect: ['.file-menu', '.file-menu [role="listbox"]'] };
    await capture.press('Enter');
    await capture.waitFor(() => !document.querySelector('.file-menu'));
    assert.equal(await capture.evaluate(() => document.activeElement?.classList.contains('jump')), true);

    await capture.component('ex-diff-review', component => component.goTo('retry')); await finish();
    const comment = '[data-file-id="retry"] [data-line-id="remove"] .comment';
    await capture.hover('[data-file-id="retry"] [data-line-id="remove"]');
    await capture.click(comment);
    await capture.waitFor(() => document.activeElement?.tagName === 'TEXTAREA');
    yield { name: `${theme}-line-question`, inspect: ['.comment-form', '.comment-form textarea'] };
    await capture.press('Escape');
    await capture.waitFor(selector => document.activeElement === document.querySelector(selector), comment);

    await capture.component('ex-diff-review', component => component.goTo('retry')); await finish();
    await capture.evaluate(() => document.querySelector('ex-diff-review .review').focus());
    for (let step = 0; step < 6; step++) await capture.press('F7');
    assert.equal(await owner(component => component.currentFile()), 'tests', 'Change navigation updates the active file across file boundaries');
    await capture.component('ex-diff-review', component => component.goTo('retry')); await finish();

    await owner(component => {
      const changes = component.contents().find(content => content.fileId === 'retry' && content.mode === 'changes');
      component.contents.update(contents => [...contents, { ...changes, mode: 'full', hunks: changes.hunks.map(hunk => ({
        ...hunk, before: undefined, after: undefined, lines: [
          ...Array.from({ length: 53 }, (_, index) => ({ id: `full-${index}`, kind: 'context', oldNumber: index + 1, newNumber: index + 1, text: `// Payment setup ${index + 1}` })),
          ...hunk.lines,
        ],
      })) }]);
    });
    const lineY = () => capture.evaluate(() => document.querySelector('[data-file-id="retry"] [data-line-id="remove"]').getBoundingClientRect().top);
    const beforeMode = await lineY();
    await capture.click('ex-diff-review .modes button:last-child'); await finish();
    assert.ok(Math.abs(await lineY() - beforeMode) < 1, 'Full files keeps the line being read in place');
    assert.equal(await capture.evaluate(() => !!document.querySelector('[data-file-id="retry"] [data-line-id="full-0"]')), true);
    yield { name: `${theme}-full-files`, inspect: ['ex-diff-review .modes', '[data-file-id="retry"] header'] };
    await capture.click('ex-diff-review .modes button:first-child'); await finish();
    assert.ok(Math.abs(await lineY() - beforeMode) < 1, 'Returning to Changes preserves the same reading position');

    await capture.click('ex-diff-review [aria-label="Wider review (⇧⌘R)"]');
    await position(); await finish();
    yield { name: `${theme}-wide`, inspect: ['ex-diff-review aside', '.old-number', '.new-number'], metadata: { layout: await assertFits() } };
    await capture.click('ex-diff-review [aria-label="Leave wider review (⇧⌘R)"]'); await finish();
    await position(320); await finish();
    yield { name: `${theme}-narrow`, metadata: { layout: await assertFits() } };

    await owner(component => {
      component.currentFile.set('retry');
      component.contents.update(contents => contents.map(content => content.fileId === 'retry' ? {
        ...content, hunks: content.hunks.map(hunk => ({ ...hunk, lines: [...hunk.lines, {
          id: 'long', kind: 'context', oldNumber: 123456, newNumber: 123456, text: '  const detail = "' + 'long-value-'.repeat(40) + '";',
        }] })),
      } : content));
    });
    await position(440); await capture.component('ex-diff-review', component => component.goTo('retry')); await finish();
    const gutter = await capture.evaluate(() => {
      const number = document.querySelector('[data-line-id="long"] .new-number');
      return { width: number.clientWidth, text: number.scrollWidth };
    });
    assert.ok(gutter.text <= gutter.width, 'Six-digit line numbers stay inside their gutter');
    yield { name: `${theme}-long-lines`, metadata: { layout: await assertFits(), gutter } };
    await capture.click('ex-diff-review [aria-label="Wrap lines"]'); await finish();
    assert.equal(await capture.evaluate(() => {
      const lines = document.querySelector('[data-file-id="retry"] .lines');
      return lines.scrollWidth > lines.clientWidth;
    }), true, 'Unwrapped code scrolls horizontally');
    yield { name: `${theme}-unwrapped`, metadata: { layout: await assertFits() } };
    await capture.click('ex-diff-review [aria-label="Wrap lines"]');

    await owner((component, initial) => { component.files.set(initial.files); component.contents.set(initial.contents); }, initial);
    await capture.component('ex-diff-review', component => component.goTo('error')); await finish();
    yield { name: `${theme}-error-binary-large`, inspect: ['[data-file-id="error"] .load', '[data-file-id="binary"] .notice', '[data-file-id="large"] .load'] };
    await capture.click('[data-file-id="error"] .load button'); await finish();
    assert.equal(await capture.evaluate(() => !!document.querySelector('[data-file-id="error"] .line')), true);

    await owner(component => {
      component.files.set([{ id: 'deleted', path: 'src/obsolete.ts', status: 'D', add: 0, del: 3 }]);
      component.currentFile.set('deleted'); component.contents.set([]);
    });
    await finish();
    assert.equal(await capture.evaluate(() => document.querySelector('[data-file-id="deleted"] .load button').textContent.trim()), 'Show deleted lines');
    yield { name: `${theme}-deleted`, inspect: ['[data-file-id="deleted"] .load'] };
    await capture.click('[data-file-id="deleted"] .load button'); await finish();
    assert.equal(await capture.evaluate(() => !!document.querySelector('[data-file-id="deleted"] .line')), true);
    await owner(component => {
      component.files.set([{ id: 'loading', path: 'src/pending.ts', status: 'M', add: 8, del: 2 }]);
      component.currentFile.set('loading'); component.contents.set([{ fileId: 'loading', mode: 'changes', state: 'loading' }]);
    });
    await finish();
    yield { name: `${theme}-loading`, inspect: ['[aria-label="Loading file"]'] };

    await owner(component => {
      const files = Array.from({ length: 1000 }, (_, index) => ({ id: `file-${index}`, path: `src/module-${index}/file.ts`, status: 'M', add: 1, del: 1 }));
      component.files.set(files); component.contents.set([]); component.currentFile.set(files[0].id);
    });
    await finish(); await capture.click('ex-diff-review .jump');
    await capture.waitFor(() => document.activeElement?.getAttribute('role') === 'listbox');
    await capture.press('End'); await finish();
    assert.equal(await owner(component => component.currentFile()), 'file-999');
    const bounded = await capture.evaluate(() => ({
      rows: document.querySelectorAll('.file-menu [role="option"]').length,
      cards: document.querySelectorAll('ex-diff-review .stream > [data-file-id]').length,
    }));
    assert.ok(bounded.rows < 50); assert.ok(bounded.cards <= 12);
    yield { name: `${theme}-thousand-files`, metadata: bounded };
    await capture.press('Enter');
    await capture.waitFor(() => !document.querySelector('.file-menu'));
    await capture.evaluate(() => { document.querySelector('ex-diff-review .scroller').scrollTop = 0; });
    await capture.waitFor(() => document.querySelector('ex-diff-review .jump small').textContent.trim() === '997 of 1000');
    await owner(component => { component.files.set([]); component.contents.set([]); });
    await finish();
    assert.equal(await capture.evaluate(() => document.querySelector('ex-diff-review .jump').disabled), true);
    yield { name: `${theme}-empty`, inspect: ['ex-diff-review .empty'] };

    await capture.reducedMotion(true);
    await owner((component, initial) => { component.files.set(initial.files); component.contents.set(initial.contents); component.currentFile.set('retry'); }, initial);
    await capture.click('[data-file-id="retry"] .viewed'); await finish();
    assert.equal(await capture.evaluate(() => document.querySelector('[data-file-id="retry"] .fold').getAttribute('aria-expanded')), 'false');
    yield { name: `${theme}-viewed-reduced-motion`, inspect: ['[data-file-id="retry"] .viewed', '[data-file-id="retry"] ex-fold'] };
  }
}
