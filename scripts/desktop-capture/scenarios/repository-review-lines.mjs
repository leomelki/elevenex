import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import review from './repository-review.mjs';

/** Native preload/HTTP/real Git regression for incremental lines and reading geometry. */
export default async function* (capture) {
  yield* review(capture, {
    prepare: (cwd) =>
      writeFile(
        join(cwd, 'src/large.ts'),
        Array.from({ length: 1800 }, (_, i) => `export const line${i + 1} = ${i + 1};`).join('\n') + '\n',
      ),
    exercise,
  });
}
async function* exercise(capture, finish) {
  const select = async (id) => {
    await capture.component('ex-diff-review', (component, id) => component.goTo(id), id);
    await ready();
  };
  const ready = async () => {
    try {
      await capture.waitFor(() => {
        const component = window.ng.getComponent(document.querySelector('ex-repository-review'));
        return (
          component.store.page() &&
          component.store.contents().every((content) => !content.loading && content.state !== 'loading') &&
          !!document.querySelector('ex-diff-review')
        );
      });
    } catch (error) {
      const state = await capture.evaluate(() => {
        const store = window.ng.getComponent(document.querySelector('ex-repository-review')).store;
        return {
          busy: store.busy(),
          error: store.error(),
          contents: store.contents().map((content) => ({
            id: content.fileId,
            state: content.state,
            loading: content.loading,
            error: content.error,
            lines: content.hunks?.reduce((total, hunk) => total + hunk.lines.length, 0),
          })),
          skeletons: [...document.querySelectorAll('[aria-label="Loading file"]')].map(
            (node) => node.closest('[data-file-id]')?.dataset.fileId,
          ),
          busyNodes: [...document.querySelectorAll('[aria-busy="true"]')].map((node) => node.outerHTML.slice(0, 150)),
        };
      });
      throw new Error(`${error.message}: ${JSON.stringify(state)}`, { cause: error });
    }
    await finish();
  };
  const reveal = async (selector) => {
    await capture.evaluate((selector) => {
      const control = document.querySelector(selector);
      const root = control.closest('.scroller');
      root.scrollTop += control.getBoundingClientRect().top - root.getBoundingClientRect().top - root.clientHeight / 2;
    }, selector);
    await capture.settle();
  };
  const probe = async (selector) => {
    await reveal(selector);
    await capture.evaluate((selector) => {
      const root = document.querySelector('ex-diff-review .scroller');
      const control = document.querySelector(selector);
      const heading = control.closest('[data-hunk-id]');
      const container =
        heading?.nextElementSibling ??
        (control.hasAttribute('aria-label') && /below/.test(control.getAttribute('aria-label'))
          ? control.previousElementSibling
          : control.closest('ex-diff-file'));
      const lines = [...container.querySelectorAll('[data-line-id]')];
      const before = /above|previous/.test(control.getAttribute('aria-label') ?? '');
      const line = before ? lines[0] : lines.at(-1);
      const firstTop = line.getBoundingClientRect().top;
      const state = { firstTop, id: line.dataset.lineId, samples: [], node: line };
      root.__lineExpansionProbe = state;
      const started = performance.now();
      const frame = () => {
        state.samples.push({
          top: line.isConnected ? line.getBoundingClientRect().top : null,
          rows: line.closest('ex-diff-file')?.querySelectorAll('.line').length ?? 0,
        });
        if (performance.now() - started < 800 && state.samples.length < 180) requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
    }, selector);
  };
  const checkProbe = async () => {
    const result = await capture.evaluate(() => {
      const root = document.querySelector('ex-diff-review .scroller');
      const state = root.__lineExpansionProbe;
      delete root.__lineExpansionProbe;
      return {
        id: state.id,
        samples: state.samples.length,
        disconnected: state.samples.some((sample) => sample.top === null),
        shift: Math.max(0, ...state.samples.map((sample) => Math.abs(sample.top - state.firstTop))),
        maxRows: Math.max(0, ...state.samples.map((sample) => sample.rows)),
      };
    });
    assert.equal(result.disconnected, false, 'A reading line disappeared during expansion');
    assert.ok(result.shift < 2, `Reading line jumped ${result.shift}px`);
    assert.ok(result.maxRows <= 1200, 'Line window exceeded its DOM budget');
    return result;
  };
  for (const theme of ['light', 'dark']) {
    await capture.theme(theme);
    await capture.viewport(1440, 760);
    for (const wide of [false, true]) {
      const label = `${theme}-${wide ? 'wide' : 'narrow'}`;
      await capture.component(
        'ex-repository-review-demo',
        (component, wide) => {
          component.wide.set(wide);
          component.reviewVisible.set(false);
        },
        wide,
      );
      await capture.component('ex-repository-review-demo', (component) => component.reviewVisible.set(true));
      await ready();
      await select('unstaged:src/payments.ts');
      const above = '[data-file-id="unstaged:src/payments.ts"] [aria-label="Show 20 lines above"]';
      await reveal(above);
      yield { name: `${label}-controls`, selector: 'ex-repository-review' };
      await probe(above);
      await capture.click(above);
      await ready();
      yield {
        name: `${label}-expand-above`,
        selector: 'ex-repository-review',
        metadata: { anchor: await checkProbe() },
      };
      const below = '[data-file-id="unstaged:src/payments.ts"] [aria-label="Show 20 lines below"]';
      await probe(below);
      await capture.click(below);
      await ready();
      yield {
        name: `${label}-expand-below`,
        selector: 'ex-repository-review',
        metadata: { anchor: await checkProbe() },
      };
      const keyboardAbove = '[data-file-id="unstaged:src/payments.ts"] .hunk .expand-lines';
      for (let step = 0; step < 2; step++) {
        await probe(keyboardAbove);
        await capture.evaluate((selector) => document.querySelector(selector).focus(), keyboardAbove);
        await capture.press('Enter');
        await ready();
        await checkProbe();
      }
      assert.equal(
        await capture.evaluate(() => document.activeElement?.matches('.line')),
        true,
        'Exhausted control lost keyboard focus',
      );
      yield { name: `${label}-keyboard-exhausted`, selector: 'ex-repository-review', inspect: [':focus'] };
      await select('untracked:src/large.ts');
      await capture.click('[data-file-id="untracked:src/large.ts"] .load button');
      await ready();
      const more = '[data-file-id="untracked:src/large.ts"] .expand-lines:last-of-type';
      const fullPaging = theme === 'light' && !wide;
      for (let page = 1; page <= (fullPaging ? 3 : 1); page++) {
        await probe(more);
        await capture.click(more);
        await ready();
        const anchor = await checkProbe();
        const count = await capture.evaluate(
          () => document.querySelector('[data-file-id="untracked:src/large.ts"]').querySelectorAll('.line').length,
        );
        assert.equal(count, Math.min(1200, (page + 1) * 400));
        yield { name: `${label}-more-${page}`, selector: 'ex-repository-review', metadata: { anchor, count } };
      }
      if (fullPaging) {
        const previous = '[data-file-id="untracked:src/large.ts"] .body > .expand-lines:first-of-type';
        await probe(previous);
        await capture.click(previous);
        await ready();
        yield { name: `${label}-previous`, selector: 'ex-repository-review', metadata: { anchor: await checkProbe() } };
        // Last page must contain code, with an enabled route back to earlier text.
        for (let page = 0; page < 3; page++) {
          const hasMore = await capture.evaluate(() =>
            [...document.querySelectorAll('[data-file-id="untracked:src/large.ts"] .expand-lines')].some((button) =>
              button.textContent.includes('Load more lines'),
            ),
          );
          if (!hasMore) break;
          await reveal(more);
          await capture.click(more);
          await ready();
        }
        assert.equal(
          await capture.evaluate(() =>
            document.querySelector('[data-file-id="untracked:src/large.ts"]').textContent.includes('line1800'),
          ),
          true,
        );
      }
      await capture.reducedMotion(true);
      await capture.viewport(1000, 640);
      await capture.component('ex-repository-review-demo', (component) => component.wide.set(false));
      await finish();
      await select('unstaged:src/payments.ts');
      const reducedBelow = '[data-file-id="unstaged:src/payments.ts"] [aria-label="Show 20 lines below"]';
      await probe(reducedBelow);
      await capture.click(reducedBelow);
      await ready();
      yield { name: `${label}-reduced`, selector: 'ex-repository-review', metadata: { anchor: await checkProbe() } };
      await capture.reducedMotion(false);
      await capture.viewport(1440, 760);
    }
  }
}
