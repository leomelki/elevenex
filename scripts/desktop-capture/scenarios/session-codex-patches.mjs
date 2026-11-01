import assert from 'node:assert/strict';

const cases = ['native-add', 'history-delete', 'unified-update', 'empty-add', 'rename-only'];

function color(value) {
  if (/^#[\da-f]{6}$/i.test(value))
    return [1, 3, 5].map(offset => parseInt(value.slice(offset, offset + 2), 16));
  const channels = value.match(/^rgba?\((\d+)[, ]+\s*(\d+)[, ]+\s*(\d+)/);
  assert.ok(channels, `Unsupported computed color: ${value}`);
  return channels.slice(1, 4).map(Number);
}

/** Native whole-file Codex receipts and unified patches through the real chat. */
export default async function* (capture) {
  await capture.evaluate(() => { if (location.pathname !== '/connected-workspace') location.href = '/connected-workspace'; });
  await capture.waitFor(() => document.querySelector('ex-workspace-navigation ex-task-list'));
  await capture.component('ex-machine-workspace', component => component.store.selectSession({ taskId: '11', sessionId: '101' }));
  const finish = async () => {
    await capture.settle();
    await capture.waitFor(() => document.getAnimations().every(animation => !Number.isFinite(animation.effect?.getComputedTiming().endTime) || animation.playState !== 'running'));
  };
  const scroll = async selector => {
    await capture.evaluate(selector => document.querySelector(selector).scrollIntoView({ block: 'center' }), selector);
    if (await capture.evaluate(() => !!document.querySelector('ex-chat-scroll .reminder-top button')))
      await capture.click('ex-chat-scroll .reminder-top button');
    await finish();
  };
  const tool = index => `ex-work-timeline > ol > li:nth-child(${index + 1}) ex-tool-step`;
  const inspect = (selector, scope) => capture.evaluate((selector, scope) => {
    const region = document.querySelector(selector + ' ' + scope);
    return {
      text: region.textContent,
      headings: [...region.querySelectorAll('.tool-block h4')].filter(heading => {
        const style = getComputedStyle(heading);
        return heading.getBoundingClientRect().height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
      }).map(heading => heading.textContent.trim()),
      rows: [...region.querySelectorAll('.diff-line')].map(line => {
        const style = getComputedStyle(line);
        return {
          text: line.querySelector('code').textContent,
          sign: line.querySelector('.sign')?.textContent ?? '',
          added: line.classList.contains('added'), removed: line.classList.contains('removed'), context: line.classList.contains('context'),
          color: style.color, background: style.backgroundColor,
          addToken: style.getPropertyValue('--diff-add').trim(), deleteToken: style.getPropertyValue('--diff-del').trim(),
          whitespace: getComputedStyle(line.querySelector('code')).whiteSpace,
        };
      }),
    };
  }, selector, scope);
  const verify = (snapshot, index) => {
    const paths = ['test-file.txt', 'notes/old.txt', 'src/banner.txt', 'empty.txt', 'src/old-name.txt'];
    if (index < 4) assert.ok(snapshot.headings.includes(paths[index]), `Missing file heading for ${cases[index]}`);
    for (const row of snapshot.rows) {
      assert.equal(row.whitespace, 'pre');
      assert.equal(row.text.includes('\r'), false);
      if (row.added) assert.deepEqual(color(row.color), color(row.addToken));
      if (row.removed) assert.deepEqual(color(row.color), color(row.deleteToken));
      if (row.added || row.removed) assert.notEqual(row.background, 'rgba(0, 0, 0, 0)');
    }
    if (index === 0) {
      assert.equal(snapshot.rows.length, 1, 'A terminal newline must not create a second added row');
      assert.deepEqual(snapshot.rows.map(row => [row.text, row.sign, row.added, row.removed]), [
        ['Hello! This text file was created to test my file-writing capability.', '+', true, false],
      ]);
    } else if (index === 1) {
      assert.equal(snapshot.rows.length, 3, 'Retain the intentional blank line without adding a terminal row');
      assert.deepEqual(snapshot.rows.map(row => row.text), ['  Leading and trailing spaces  ', ' ', 'Last line  ']);
      assert.equal(snapshot.rows.every(row => row.removed && !row.added && row.sign === '−'), true);
    } else if (index === 2) {
      const oldHeader = snapshot.rows.find(row => row.text === '--- a/src/banner.txt');
      const newHeader = snapshot.rows.find(row => row.text === '+++ b/src/banner.txt');
      assert.ok(oldHeader && newHeader, 'Keep unified file headers visible');
      assert.equal(oldHeader.context && !oldHeader.added && !oldHeader.removed, true);
      assert.equal(newHeader.context && !newHeader.added && !newHeader.removed, true);
      assert.equal(snapshot.rows.find(row => row.text === '---old')?.removed, true);
      assert.equal(snapshot.rows.find(row => row.text === '+++new')?.added, true);
      assert.equal(snapshot.rows.filter(row => row.added).length, 1);
      assert.equal(snapshot.rows.filter(row => row.removed).length, 1);
    } else if (index === 3) {
      assert.equal(snapshot.rows.length, 0, 'Empty files have no phantom added row');
      assert.match(snapshot.text, /Empty file/);
    } else {
      assert.equal(snapshot.rows.length, 0);
      assert.match(snapshot.text, /src\/old-name\.txt/);
      assert.match(snapshot.text, /src\/renamed\.txt/);
    }
  };

  for (const theme of ['light', 'dark']) {
    await capture.theme(theme);
    await capture.viewport(1440, 960);
    await capture.component('ex-connected-workspace-demo', component => component.fixture.chat.scenario('tools-codex-files'));
    await capture.waitFor(() => document.querySelector('ex-turn .answer')?.textContent.includes('native file-change receipts'));
    await finish();
    if (await capture.evaluate(() => document.querySelector('ex-turn .work').getAttribute('aria-expanded') !== 'true'))
      await capture.click('ex-turn .work');
    await finish();
    assert.equal(await capture.evaluate(() => document.querySelectorAll('ex-work-timeline ex-tool-step').length), cases.length);

    for (const layout of ['desktop', 'narrow']) {
      await capture.viewport(layout === 'desktop' ? 1440 : 1000, layout === 'desktop' ? 960 : 760);
      await capture.reducedMotion(layout === 'narrow');
      await finish();
      for (let index = 0; index < cases.length; index++) {
        const selector = tool(index);
        await scroll(selector + ' .head');
        if (index === 0) {
          await capture.evaluate(selector => document.querySelector(selector + ' .head').focus(), selector);
          await capture.press('Enter');
        } else await capture.click(selector + ' .head');
        await finish();
        assert.equal(await capture.evaluate(selector => document.querySelector(selector + ' .head').getAttribute('aria-expanded'), selector), 'true');
        assert.equal(await capture.evaluate(selector => document.querySelector(selector + ' .more-details').open, selector), false);
        assert.equal(await capture.evaluate(selector => document.querySelector(selector + ' .tool-details'), selector), null, 'Details mount lazily');
        const primary = await inspect(selector, '.tool-preview');
        verify(primary, index);
        assert.equal(await capture.evaluate(selector => {
          const content = document.querySelector(selector + ' .tool-content');
          return content.scrollWidth <= content.clientWidth + 1;
        }, selector), true);
        await scroll(selector);
        yield { name: `${theme}-${layout}-${cases[index]}-preview`, selector, inspect: [selector, selector + ' .tool-preview'], metadata: { primary } };

        await scroll(selector + ' .more-details > summary');
        await capture.evaluate(selector => document.querySelector(selector + ' .more-details > summary').focus(), selector);
        await capture.press('Enter');
        await finish();
        assert.equal(await capture.evaluate(selector => document.activeElement === document.querySelector(selector + ' .more-details > summary'), selector), true);
        assert.equal(await capture.evaluate(selector => document.querySelector(selector + ' .more-details').open, selector), true);
        const details = await inspect(selector, '.tool-details');
        verify(details, index);
        if (layout === 'desktop' || index === 0) {
          await scroll(selector);
          yield { name: `${theme}-${layout}-${cases[index]}-details`, selector, inspect: [selector, selector + ' .tool-details'], metadata: { details } };
        }
        await scroll(selector + ' .more-details > summary');
        await capture.evaluate(selector => document.querySelector(selector + ' .more-details > summary').focus(), selector);
        await capture.press('Enter');
        await finish();
        assert.equal(await capture.evaluate(selector => document.querySelector(selector + ' .tool-details'), selector), null);
        await scroll(selector + ' .head');
        await capture.click(selector + ' .head');
        await finish();
        assert.equal(await capture.evaluate(selector => !!document.querySelector(selector + ' ex-tool-content').closest('ex-fold[inert]'), selector), true);
      }
    }
    await capture.reducedMotion(false);
  }
}
