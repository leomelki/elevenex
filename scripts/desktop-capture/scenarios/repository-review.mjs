import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Real disposable Git + HTTP + production main/preload + Angular review. No renderer mock data. */
export default async function* (capture, { sourcesOnly = false } = {}) {
  const require = createRequire(new URL('../../../apps/desktop/package.json', import.meta.url));
  const { ipcMain } = require('electron');
  const { BackendClient } = require('./dist/backend-client/client');
  const { registerRepositoryReviewIpc } = require('./dist/backend-client/repository-review');
  const { RepositoryReviewReader, reviewGit, reviewQuery } = require('../backend/dist/desktop-workspace/repository-review-reader');
  const reader = new RepositoryReviewReader();
  const cwd = await mkdtemp(join(tmpdir(), 'elevenex-live-review-'));
  const git = args => reviewGit(cwd, args);
  let stop;
  let client;
  let fail = false;
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://localhost');
      response.setHeader('content-type', 'application/json');
      if (fail) { response.statusCode = 503; response.end('{}'); return; }
      if (url.pathname.endsWith('/branches')) {
        const query = url.searchParams.get('query') ?? '';
        const refs = (await git(['for-each-ref', '--format=%(refname)', 'refs/heads/', 'refs/remotes/'])).trim().split('\n').filter(ref => ref.includes(query));
        response.end(JSON.stringify({ taskId: 7, refs: refs.slice(0, 50), hasMore: refs.length > 50 })); return;
      }
      assert.equal(url.pathname, '/api/desktop-workspace/tasks/7/review');
      let body = ''; for await (const chunk of request) body += chunk;
      assert.ok(body.length < 32000);
      response.end(JSON.stringify(await reader.read(cwd, 7, reviewQuery(JSON.parse(body)), 'refs/heads/trunk')));
    } catch (error) {
      response.statusCode = typeof error.getStatus === 'function' ? error.getStatus() : 500;
      response.end(JSON.stringify(typeof error.getResponse === 'function' ? error.getResponse() : { message: 'Review failed' }));
    }
  });
  try {
    await git(['init', '-b', 'trunk']); await git(['config', 'user.email', 'review@example.test']); await git(['config', 'user.name', 'Review']);
    await mkdir(join(cwd, 'src'));
    const original = Array.from({ length: 120 }, (_, i) => `export const value${i + 1} = ${i + 1};`).join('\n') + '\n';
    await writeFile(join(cwd, 'src/payments.ts'), original); await writeFile(join(cwd, 'src/obsolete.ts'), 'export const obsolete = true;\n');
    await git(['add', '-A']); await git(['commit', '-m', 'Initial payment processing']);
    await git(['checkout', '-b', 'task/reliable-payments']);
    if (sourcesOnly) {
      await writeFile(join(cwd, 'src/duplicate-guard.ts'), 'export const preventDuplicates = true;\n');
      await git(['add', '-A']); await git(['commit', '-m', 'Guard duplicate payments']);
    }
    const committed = original.replace('value10 = 10', 'value10 = 100');
    await writeFile(join(cwd, 'src/payments.ts'), committed); await git(['mv', 'src/obsolete.ts', 'src/receipt.ts']);
    await git(['add', '-A']); await git(['commit', '-m', 'Keep a durable receipt']);
    const staged = committed.replace('value30 = 30', 'value30 = 300');
    await writeFile(join(cwd, 'src/payments.ts'), staged); await git(['add', 'src/payments.ts']);
    await writeFile(join(cwd, 'src/payments.ts'), staged.replace('value60 = 60', 'value60 = 600'));
    await writeFile(join(cwd, 'src/new-retry.ts'), 'export const retry = async () => {\n  return true;\n};\n');
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${server.address().port}`;
    const contents = capture.window.webContents;
    client = new BackendClient(() => ({ url, identity: url, version: 'a'.repeat(40), environment: { kind: 'local' }, headers: {} }), () => {});
    client.attach(contents.id);
    for (const channel of ['repository-review:read', 'repository-review:branches', 'repository-review:cancel']) ipcMain.removeHandler(channel);
    stop = registerRepositoryReviewIpc(client, (frame, sender) => sender === contents && frame === contents.mainFrame);
    const target = { scopeId: client.state(contents.id).scope.id, taskId: 7 };
    await capture.evaluate(() => { location.href = '/repository-review'; });
    await capture.waitFor(() => document.querySelector('ex-repository-review-demo'));
    await capture.component('ex-repository-review-demo', (component, target) => component.target.set(target), target);
    const finish = async () => { await capture.settle(); await capture.waitFor(() => document.getAnimations().every(animation => !Number.isFinite(animation.effect?.getComputedTiming().endTime) || animation.playState !== 'running')); };
    const choose = async (index, settleMotion = true) => {
      const inline = await capture.evaluate(() => getComputedStyle(document.querySelector('.source-tabs')).display !== 'none');
      if (inline) await capture.click(`.source-tabs button:nth-of-type(${index + 1})`);
      else { await capture.click('.source-bar ex-dropdown button'); await capture.click(`[role="menuitemradio"]:nth-child(${index + 1})`); }
      await capture.waitFor(() => !document.querySelector('ex-repository-review .feedback[role="status"]'));
      if (settleMotion) await finish();
    };

    if (sourcesOnly) {
      const sourceNames = ['uncommitted', 'last-commit', 'branch'];
      const waitSource = async source => {
        await capture.waitFor(source => {
          const component = window.ng.getComponent(document.querySelector('ex-repository-review'));
          return component.source() === source && component.store.page()?.source === source && !component.store.busy();
        }, source);
        await finish();
        await capture.waitFor(() => {
          const store = window.ng.getComponent(document.querySelector('ex-repository-review')).store;
          return store.files().filter(file => !file.binary && !file.large && file.status !== 'D' && file.add + file.del <= 400).every(file => store.contents().some(content => content.fileId === file.id && content.rev === file.rev && content.mode === store.mode() && content.state === 'ready'));
        });
      };
      for (const theme of ['light', 'dark']) {
        await capture.theme(theme); await capture.viewport(1440, 560);
        for (const layout of ['narrow', 'wide']) {
          await capture.component('ex-repository-review-demo', (component, wide) => component.wide.set(wide), layout === 'wide');
          await choose(0); await waitSource('uncommitted');
          if (layout === 'narrow') { await capture.click('.source-bar ex-dropdown button'); await finish(); }
          yield { name: `${theme}-${layout}-source-chooser`, selector: 'ex-repository-review', inspect: ['.source-bar'] };
          if (layout === 'narrow') {
            await capture.component('ex-repository-review-demo', component => component.wide.set(true));
            await capture.waitFor(() => !document.querySelector('[role="menu"]') && document.activeElement?.matches('.source-tabs [aria-checked="true"]'));
            await finish();
            yield { name: `${theme}-resize-to-inline`, selector: 'ex-repository-review', inspect: ['.source-tabs', ':focus'] };
            await capture.component('ex-repository-review-demo', component => component.wide.set(false));
            await capture.waitFor(() => document.activeElement?.matches('.source-menu button'));
            await finish();
            yield { name: `${theme}-resize-to-dropdown`, selector: 'ex-repository-review', inspect: ['.source-menu', ':focus'] };
          }
          for (let index = 0; index < sourceNames.length; index++) {
            await choose(index); await waitSource(sourceNames[index]);
            if (index === 2) {
              // Explicitly apply the base so subsequent switches also cover the
              // boundary that keeps branch refs out of the other source requests.
              await capture.component('ex-repository-review', component => component.selectBase('refs/heads/trunk'));
              await waitSource('branch');
            }
            await capture.waitFor(index => document.querySelector(index === 0 ? '[data-file-id="unstaged:src/payments.ts"] [data-kind="add"]' : '[data-file-id="committed:src/payments.ts"] [data-kind="add"]'), index);
            const dimensions = await capture.evaluate(() => {
              const panel = document.querySelector('ex-repository-review'), bar = panel.querySelector('.source-bar');
              return { entries: bar.querySelector('.summary > span')?.textContent, width: panel.getBoundingClientRect().width, header: panel.querySelector('ex-diff-review .toolbar').getBoundingClientRect().bottom - panel.getBoundingClientRect().top, overflow: bar.scrollWidth - bar.clientWidth };
            });
            assert.match(dimensions.entries, /^\d+ entries$/);
            assert.equal(await capture.evaluate(() => !!document.querySelector('.source-bar ex-ease-swap')), false);
            assert.ok(dimensions.overflow <= 1); assert.ok(dimensions.header <= 76);
            yield { name: `${theme}-${layout}-${sourceNames[index]}`, selector: 'ex-repository-review', inspect: ['.source-bar', 'ex-diff-review .toolbar'], metadata: dimensions };
          }
        }
      }
      const reopenFresh = async () => {
        await capture.component('ex-repository-review-demo', component => component.reviewVisible.set(false));
        await capture.component('ex-repository-review-demo', component => { component.wide.set(false); component.reviewVisible.set(true); });
      };
      await reopenFresh(); await waitSource('uncommitted');
      yield { name: 'automatic-dirty-uncommitted', selector: 'ex-repository-review', inspect: ['.source-bar'] };
      await git(['add', '-A']); await git(['commit', '-m', 'Save working changes']);
      await reopenFresh(); await waitSource('last-commit');
      yield { name: 'automatic-clean-last-commit', selector: 'ex-repository-review', inspect: ['.source-bar'] };
      await writeFile(join(cwd, 'src/new-after-review.ts'), 'export const fresh = true;\n');
      await capture.component('ex-repository-review', component => component.store.load(true));
      assert.equal(await capture.component('ex-repository-review', component => component.source()), 'last-commit');
      await capture.click('[aria-label="Refresh repository review"]'); await waitSource('uncommitted');
      yield { name: 'automatic-refresh-new-uncommitted', selector: 'ex-repository-review', inspect: ['.source-bar'] };
      await rm(join(cwd, 'src/new-after-review.ts'));
      await capture.click('[aria-label="Refresh repository review"]'); await waitSource('last-commit');
      yield { name: 'automatic-refresh-clean-last-commit', selector: 'ex-repository-review', inspect: ['.source-bar'] };
      await choose(0); await waitSource('uncommitted');
      await capture.component('ex-repository-review', component => component.store.load(true));
      assert.equal(await capture.component('ex-repository-review', component => component.source()), 'uncommitted');
      yield { name: 'manual-empty-uncommitted-retained', selector: 'ex-repository-review', inspect: ['.source-bar', '.empty'] };
      return;
    }
    for (const theme of ['light', 'dark']) {
      await capture.theme(theme); await capture.viewport(1440, 960); await capture.reducedMotion(false);
      if (theme === 'dark') await choose(0);
      await capture.waitFor(() => document.querySelector('[data-file-id="unstaged:src/payments.ts"] [data-kind="add"]'));
      assert.match(await capture.evaluate(() => document.querySelector('ex-repository-review').textContent), /Staged/);
      assert.match(await capture.evaluate(() => document.querySelector('ex-repository-review').textContent), /Unstaged/);
      await finish();
      const headerHeight = await capture.evaluate(() => {
        const panel = document.querySelector('ex-repository-review');
        return panel.querySelector('ex-diff-review .toolbar').getBoundingClientRect().bottom - panel.getBoundingClientRect().top;
      });
      assert.ok(headerHeight <= 76, `Compact header is ${headerHeight}px tall`);
      yield { name: `${theme}-uncommitted`, selector: 'ex-repository-review', inspect: ['ex-repository-review', '.source-bar', '.scroller'], metadata: { headerHeight } };
      await capture.click('[aria-label="Comparison details"]');
      await capture.waitFor(() => document.querySelector('.comparison-details [role]') || document.querySelector('.comparison-details'));
      yield { name: `${theme}-comparison-details`, inspect: ['.comparison-details', ':focus'] };
      await capture.press('Escape'); await finish();
      await capture.click('ex-diff-review .jump');
      await capture.fill('[aria-label="Search all changed files"]', 'no-matching-file');
      await capture.waitFor(() => window.ng.getComponent(document.querySelector('ex-repository-review')).store.files().length === 0);
      await capture.press('Escape'); await finish();
      await capture.click('ex-diff-review .jump');
      await capture.click('.file-finder button');
      await capture.waitFor(() => window.ng.getComponent(document.querySelector('ex-repository-review')).store.files().length === 3);
      assert.equal(await capture.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'Search all changed files');
      yield { name: `${theme}-file-picker-search`, inspect: ['.file-menu', ':focus'] };
      await capture.press('Escape'); await finish();
      await capture.click('.source-bar ex-dropdown button');
      yield { name: `${theme}-source-menu`, inspect: ['[role="menu"]'] };
      await capture.press('Escape');
      await capture.component('ex-repository-review-demo', component => component.wide.set(true));
      await finish();
      yield { name: `${theme}-wide`, inspect: ['ex-diff-review', 'ex-change-list'] };
      await capture.click('ex-diff-review [aria-label="Review mode"] button:nth-child(2)');
      await capture.waitFor(() => document.querySelector('[data-file-id="unstaged:src/payments.ts"] [data-line-id="context:1:1"]'));
      await capture.waitFor(() => window.ng.getComponent(document.querySelector('ex-repository-review')).store.contents().filter(content => content.mode === 'full' && content.state === 'ready').length === 3);
      await finish();
      await capture.evaluate(() => { const root = document.querySelector('ex-diff-review .scroller'); root.scrollTop = 460; });
      await capture.settle();
      const anchor = await capture.evaluate(() => { const root = document.querySelector('ex-diff-review .scroller'); const line = [...root.querySelectorAll('[data-line-id]')].find(line => line.getBoundingClientRect().bottom > root.getBoundingClientRect().top + 32); return { file: line.closest('[data-file-id]').dataset.fileId, line: line.dataset.lineId, top: line.getBoundingClientRect().top }; });
      await capture.click('[aria-label="Wrap lines"]'); await finish();
      const afterAnchor = await capture.evaluate(anchor => [...document.querySelectorAll('[data-file-id]')].find(file => file.dataset.fileId === anchor.file)?.querySelector(`[data-line-id="${anchor.line}"]`)?.getBoundingClientRect().top, anchor);
      assert.ok(Math.abs(afterAnchor - anchor.top) < 4, `Reading line moved: ${anchor.top} → ${afterAnchor}`);
      yield { name: `${theme}-full-file-anchor`, inspect: ['.scroller', '.file.open header'] };
      await capture.motion.freeze();
      await choose(1, false);
      // Scrub current DOM animations only: async label replacements can cancel
      // Chromium animation IDs between CDP notifications.
      for (const time of [0, 140, 280]) {
        const animations = await capture.evaluate(time => {
          const animations = document.getAnimations().filter(animation => animation.effect?.target?.closest?.('.source-bar'));
          for (const animation of animations) { animation.pause(); animation.currentTime = time; }
          return animations.length;
        }, time);
        yield { name: `${theme}-source-switch-${time}ms`, inspect: ['.source-bar'], metadata: { time, animations } };
        if (time === 140) {
          await choose(0, false); await choose(1, false);
          yield { name: `${theme}-source-switch-interrupted`, inspect: ['.source-bar'] };
        }
      }
      await capture.motion.finish(); await capture.motion.play();
      await finish();
      await capture.waitFor(() => document.querySelector('[data-file-id="committed:src/payments.ts"] [data-kind="add"]'));
      await capture.click('[aria-label="Comparison details"]');
      await capture.waitFor(() => document.querySelector('.comparison-details')?.textContent.includes('committed only'));
      await capture.press('Escape'); await finish();
      yield { name: `${theme}-last-commit`, inspect: ['ex-repository-review'] };
      await choose(2);
      await capture.waitFor(() => document.querySelector('ex-repository-review .summary')?.textContent.includes('2 entries'));
      await capture.click('.source-bar .base');
      await capture.waitFor(() => document.querySelector('.base-picker .refs button'));
      yield { name: `${theme}-base-chooser`, inspect: ['.base-picker', ':focus'] };
      await capture.press('Escape'); await finish();
      assert.equal(await capture.evaluate(() => document.activeElement?.closest('.source-bar .base') !== null), true);
      yield { name: `${theme}-branch`, inspect: ['ex-repository-review'] };
      if (theme === 'light') {
        await git(['branch', '-f', 'trunk', 'HEAD']);
        await capture.component('ex-repository-review', component => component.store.load(true));
        await capture.waitFor(() => [...document.querySelectorAll('ex-repository-review .update')].some(element => element.textContent.includes('New changes')));
        await finish();
        yield { name: 'light-new-changes-offered', inspect: ['.update', 'ex-diff-review'] };
        await capture.click('.update:has(span) button');
        await capture.waitFor(() => document.querySelector('ex-diff-review .empty'));
        yield { name: 'light-refreshed-empty', inspect: ['ex-repository-review'] };
        await git(['branch', '-f', 'trunk', 'HEAD^']);
      }
      await capture.component('ex-repository-review-demo', component => { component.wide.set(false); component.offline.set(true); });
      await capture.viewport(1000, 760); await capture.reducedMotion(true); await finish();
      yield { name: `${theme}-narrow-disconnected-reduced`, inspect: ['ex-repository-review', '.update'] };
      await capture.component('ex-repository-review-demo', component => component.offline.set(false));
      await capture.waitFor(() => !window.ng.getComponent(document.querySelector('ex-repository-review')).store.busy());
      fail = true; await capture.component('ex-repository-review', component => component.store.load());
      await capture.waitFor(() => document.querySelector('ex-repository-review [role="alert"]'));
      yield { name: `${theme}-retry`, inspect: ['ex-repository-review [role="alert"]'] };
      fail = false; await capture.click('ex-repository-review .error button'); await finish();
    }
  } finally {
    stop?.(); client?.dispose(); reader.clear();
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    await rm(cwd, { recursive: true, force: true });
  }
}
