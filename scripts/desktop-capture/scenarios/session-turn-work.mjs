import assert from 'node:assert/strict';

const owner = 'ex-connected-workspace-demo';
const turn = '[data-chat-anchor="retries:reply"]';
const work = turn + ' button.work';
const reply = '[data-chat-row="retry-final"]';
const group = '[data-work-step="test"] .group';
const head = '[data-work-step="test"] .head';
const body = '[data-work-step="test"] .tool-preview';
const lazyFold = '[data-work-step="read-0"] .step-fold';
const inspect = [work, reply, group, head, body, 'ex-composer'];

async function settleMotion(capture) {
  await capture.waitFor(() => document.getAnimations().every(animation =>
    animation.playState !== 'running' || !Number.isFinite(animation.effect?.getComputedTiming().endTime)));
}

async function scrollTo(capture, selector) {
  await capture.evaluate(selector => document.querySelector(selector).scrollIntoView({ block: 'center' }), selector);
}

function seed(viewer, readingHistory) {
  const chat = viewer.fixture.chat;
  chat.scenario('new', 101);
  return chat.read({ taskId: 11, sessionId: 101, requestId: window.crypto.randomUUID() }).then(initial => {
    const row = (id, kind, text, extra = {}) => ({
      id, kind, text, timestamp: '2026-11-19T10:00:00Z',
      toolId: null, toolName: null, toolKind: null, input: '', error: false, truncated: false, ...extra,
    });
    const revision = 'a'.repeat(64);
    const command = row('test', 'tool_use', '', { toolId: 'test', toolKind: 'bash', toolName: 'Command' });
    const output = row('test-result', 'tool_result', '12 tests passed. One retry scenario failed.', {
      toolId: 'test', error: true, execution: { exitCode: 1 },
    });
    const beforeReply = [
      row('approach', 'assistant', 'I found the race: both requests can reach the payment provider before either records its result. I’ll make the claim atomic and verify it with overlapping requests.'),
      { id: command.id, kind: 'call', toolKind: 'bash', label: 'pnpm test --filter payments', resultId: output.id, error: true, meta: 'Exit 1' },
      ...Array.from({ length: 600 }, (_, index) => {
        const id = 'read-' + index;
        return [{ id, kind: 'call', toolKind: 'read', label: 'src/payments/case-' + index + '.ts', resultId: id + '-result' }, null];
      }).flat(),
      row('validation-note', 'assistant', 'The unique constraint now chooses one request. The other waits for its receipt.'),
    ];
    const evidence = [
      ...beforeReply,
      // Null receipt slots count toward the old 8,192-slot transport boundary.
      ...Array(8192).fill(null),
      row('receipt-note', 'system', 'The test receipt arrived after the reply.'),
    ];
    const final = row('retry-final', 'assistant',
      'Concurrent retries now share the same payment result. The first request claims the idempotency key before contacting the provider.');
    const saved = row('retries', 'user', 'Prevent duplicate charges when two payment retries overlap.', {
      completedTurn: {
        revision, endId: 'receipt-note', reply: [final],
        beforeReply: beforeReply.length, total: evidence.length, counts: { read: 600, run: 1 },
        failures: 1, duration: 94, changes: { total: 14, lineTotals: { add: 216, del: 339 }, shared: true, files: [
          { path: 'src/payments/retry.ts', status: 'M', add: 28, del: 6 },
          { path: 'src/payments/retry.test.ts', status: 'M', add: 46, del: 0 },
          { path: 'src/payments/store.ts', status: 'M', add: 12, del: 2 },
        ] },
      },
    });
    const earlier = row('verification', 'user', 'Check which cases already cover retry behavior.', {
      completedTurn: {
        revision: 'b'.repeat(64), endId: 'verification-reply',
        reply: [row('verification-reply', 'assistant', 'The existing suite covers a single request and transient failures.')],
        beforeReply: 1, total: 1, counts: {}, failures: 0, duration: 38,
      },
    });
    const tail = readingHistory ? Array.from({ length: 6 }, (_, index) => [
      row('followup-' + index, 'user', 'Review the payment and retry behavior.'),
      row('followup-reply-' + index, 'assistant', 'The integration covers race conditions, timeouts, and repeated requests. '.repeat(4)),
    ]).flat() : [];
    chat.seed(101, { items: [earlier, saved, ...tail], state: { ...initial.value.state, providerLocked: true } });
    chat.seedTurnWork(101, earlier.id, [row('verification-note', 'assistant', 'I checked the saved test cases.')]);
    // Pointer intent can warm this turn before the error checks. Keep its
    // response controlled independently of the main turn.
    chat.turnWorkBehavior('too-large', earlier.id);
    chat.seedTurnTimeline(101, saved.id, evidence);
    chat.seedToolDetails(101, [
      { id: command.id, revision, record: { ...command, input: '{"command":"pnpm test --filter payments"}' } },
      { id: output.id, revision, record: output },
    ]);
    chat.turnWorkBehavior('held');
  });
}

export default async function* (capture) {
  for (const theme of ['light', 'dark']) {
    const narrow = theme === 'dark';
    const fixture = (change, data) => capture.component(owner, change, data);
    await capture.evaluate(theme => { location.href = '/connected-workspace?work=' + theme; }, theme);
    await capture.waitFor(theme => location.search === '?work=' + theme && document.querySelector('ex-machine-workspace ex-task-list'), theme);
    await capture.viewport(narrow ? 780 : 1280, narrow ? 760 : 900);
    await capture.theme(theme);
    await capture.reducedMotion(narrow);
    await fixture(seed, narrow);
    await capture.component('ex-machine-workspace', workspace => workspace.store.selectSession({ taskId: '11', sessionId: '101' }));
    await capture.waitFor(selector => document.querySelector(selector)?.textContent.includes('same payment result'), reply);
    await capture.fill('ex-composer textarea', 'Draft for the next check');
    await capture.evaluate(selector => { document.querySelector(selector).dataset.captureIdentity = 'same-reply'; }, reply);
    await scrollTo(capture, work);
    await settleMotion(capture);
    await capture.waitFor(atEnd => window.ng.getComponent(document.querySelector('ex-chat-scroll')).atEnd() === atEnd, !narrow);
    assert.equal(await fixture(viewer => viewer.fixture.chat.turnWorkReads), 0);
    const facts = await capture.evaluate(selector => document.querySelector(selector).textContent, work);
    assert.match(facts, /1 failed.*14 workspace changes.*\+216.*−339.*1 command.*600 reads/);
    yield { name: theme + '-collapsed', inspect };

    await capture.click(work);
    await capture.waitFor(selector => document.querySelector(selector + ' ex-work-timeline')?.getAttribute('aria-busy') === 'true', turn);
    assert.equal(await capture.evaluate(selector => document.querySelector(selector + ' ex-turn-work-panel .surface'), turn), null);
    assert.equal(await capture.evaluate(() => document.querySelector('[data-work-step="approach"]')), null);
    yield { name: theme + '-pending', inspect };

    await capture.press('Enter');
    await capture.waitFor(selector => document.querySelector(selector)?.getAttribute('aria-expanded') === 'false', work);
    await fixture(viewer => viewer.fixture.chat.turnWorkBehavior('ready'));
    assert.equal(await capture.evaluate(() => document.querySelector('[data-work-step="approach"]')), null);
    await fixture(viewer => viewer.fixture.chat.turnWorkBehavior('held'));
    await capture.press('Enter');
    await capture.waitFor(selector => document.querySelector(selector + ' ex-work-timeline')?.getAttribute('aria-busy') === 'true', turn);
    const reads = await fixture(viewer => viewer.fixture.chat.turnWorkReads);
    const top = await capture.evaluate(selector => document.querySelector(selector).getBoundingClientRect().top, work);
    if (!narrow) await capture.motion.freeze();
    await fixture(viewer => viewer.fixture.chat.turnWorkBehavior('ready'));
    await capture.waitFor(() => document.querySelector('[data-work-step="receipt-note"]'));
    assert.equal(await capture.evaluate(selector => document.querySelector(selector).textContent, work), facts);
    assert.deepEqual(await capture.evaluate((selector, reply) => {
      const root = document.querySelector(selector);
      const rows = [...root.querySelectorAll('[data-work-step]')].map(row => row.dataset.workStep);
      return [rows[0], rows.includes('read-599'), rows.at(-3), rows.at(-2), rows.at(-1),
        document.querySelector(reply).dataset.captureIdentity, root.querySelectorAll('ex-tool-step').length,
        !!root.querySelector('ex-turn-work-panel .surface')];
    }, turn, reply), ['approach', false, 'validation-note', 'retry-final', 'receipt-note', 'same-reply', 0, false]);
    assert.equal(await fixture(viewer => viewer.fixture.chat.turnWorkReads), reads);
    assert.equal(await fixture(viewer => viewer.fixture.chat.toolDetailsReads), 0);
    if (!narrow) {
      for await (const frame of capture.frames('light-reveal', [0, 80, 160, 280], inspect)) {
        const current = await capture.evaluate(selector => document.querySelector(selector).getBoundingClientRect().top, work);
        assert.ok(Math.abs(current - top) < 2, 'Worked for moved during the reveal');
        yield frame;
      }
      await capture.motion.play();
    }
    await settleMotion(capture);
    const settledTop = await capture.evaluate(selector => document.querySelector(selector).getBoundingClientRect().top, work);
    assert.ok(Math.abs(settledTop - top) < 2, 'Worked moved after the compact timeline opened');
    assert.equal(await capture.evaluate(selector => document.activeElement === document.querySelector(selector), work), true);
    yield { name: theme + '-expanded', inspect };

    await scrollTo(capture, group);
    await capture.settle();
    assert.equal(await capture.evaluate(selector => document.querySelector(selector), lazyFold), null);
    if (!narrow) await capture.motion.freeze();
    const groupTop = await capture.evaluate(selector => document.querySelector(selector).getBoundingClientRect().top, group);
    await capture.click(group);
    await capture.waitFor(selector => document.querySelector(selector), lazyFold);
    const height = () => capture.evaluate(selector => document.querySelector(selector).getBoundingClientRect().height, lazyFold);
    if (!narrow) {
      const heights = [];
      for await (const frame of capture.frames('light-group-first-open', [0, 80, 160, 280], [group, lazyFold])) {
        const rowHeight = await height();
        heights.push(rowHeight);
        const top = await capture.evaluate(selector => document.querySelector(selector).getBoundingClientRect().top, group);
        assert.ok(Math.abs(top - groupTop) < 2, `The group control moved during the first opening: ${groupTop} to ${top}`);
        yield { ...frame, metadata: { ...frame.metadata, rowHeight } };
      }
      assert.ok(heights[0] < 1 && heights[1] > 1 && heights[1] < heights[2] && heights[2] < heights[3],
        `First group opening should grow from zero through intermediate heights: ${heights}`);
      await capture.motion.play();
      await settleMotion(capture);

      await capture.evaluate(selector => { document.querySelector(selector).dataset.captureIdentity = 'retained'; }, lazyFold);
      await capture.motion.freeze();
      await capture.press('Enter');
      await capture.waitFor(selector => document.querySelector(selector).hasAttribute('inert'), lazyFold);
      await capture.motion.seek(120);
      const closing = await height();
      assert.ok(closing > 1 && closing < heights[3], `Interrupted closing should be between zero and full height: ${closing}`);
      await capture.press('Enter');
      await capture.waitFor(selector => !document.querySelector(selector).hasAttribute('inert'), lazyFold);
      await capture.motion.finish();
      await capture.motion.play();
      assert.equal(await capture.evaluate(selector => document.querySelector(selector).dataset.captureIdentity, lazyFold), 'retained');
      assert.ok(Math.abs(await height() - heights[3]) < 1);
      assert.equal(await capture.evaluate(selector => document.activeElement === document.querySelector(selector), group), true);
    } else {
      assert.ok(await height() > 20, 'Reduced motion opens the first lazy row immediately');
      assert.equal(await capture.evaluate(selector => document.querySelector(selector).getAnimations().length, lazyFold), 0);
    }
    await settleMotion(capture);
    assert.equal(await capture.evaluate(() => document.querySelector('[data-work-step="read-599"] ex-tool-step') !== null), true);
    assert.match(await capture.evaluate(selector => document.querySelector(selector).textContent, head), /pnpm test --filter payments.*Exit 1/);
    assert.equal(await fixture(viewer => viewer.fixture.chat.toolDetailsReads), 0);
    await fixture(viewer => viewer.fixture.chat.toolDetailsBehavior('held'));
    await scrollTo(capture, head);
    await capture.click(head);
    await capture.waitFor(selector => document.querySelector(selector)?.getAttribute('aria-busy') === 'true', head);
    assert.equal(await capture.evaluate(selector => document.querySelector(selector + ' .detail-notice'), turn), null);
    await fixture(viewer => viewer.fixture.chat.toolDetailsBehavior('ready'));
    await capture.waitFor(selector => document.querySelector(selector)?.textContent.includes('One retry scenario failed'), body);
    await settleMotion(capture);
    assert.equal(await fixture(viewer => viewer.fixture.chat.toolDetailsReads), 1);
    assert.equal(await capture.evaluate(selector => document.activeElement === document.querySelector(selector), head), true);
    yield { name: theme + '-tool-evidence', inspect };

    await scrollTo(capture, work);
    await capture.click(work);
    await capture.waitFor(() => !document.querySelector('[data-work-step="approach"]'));
    await capture.press('Enter');
    await capture.waitFor(selector => document.querySelector(selector)?.textContent.includes('One retry scenario failed'), body);
    assert.equal(await fixture(viewer => viewer.fixture.chat.turnWorkReads), reads);
    assert.equal(await fixture(viewer => viewer.fixture.chat.toolDetailsReads), 1);
    assert.equal(await capture.evaluate(selector => document.querySelector(selector).getAttribute('aria-expanded'), group), 'true');
    await settleMotion(capture);
    yield { name: theme + '-cached-reopen', inspect };

    const earlier = '[data-chat-anchor="verification:reply"]';
    await scrollTo(capture, earlier + ' button.work');
    await capture.click(earlier + ' button.work');
    await capture.waitFor(selector => document.querySelector(selector + ' ex-turn-work-panel .error')?.textContent.includes('too large'), earlier);
    assert.equal(await capture.evaluate(selector => !!document.querySelector(selector + ' ex-turn-work-panel button'), earlier), false);
    await settleMotion(capture);
    yield { name: theme + '-oversized', inspect: [earlier + ' button.work', earlier + ' ex-turn-work-panel'] };
    await capture.press('Enter');
    await settleMotion(capture);
    await fixture(viewer => viewer.fixture.chat.turnWorkBehavior('failed', 'verification'));
    await capture.click(earlier + ' button.work');
    await capture.waitFor(selector => document.querySelector(selector + ' ex-turn-work-panel .error')?.textContent.includes('Couldn’t load'), earlier);
    await settleMotion(capture);
    yield { name: theme + '-retry', inspect: [earlier + ' button.work', earlier + ' ex-turn-work-panel'] };
    await fixture(viewer => viewer.fixture.chat.turnWorkBehavior('ready', 'verification'));
    await capture.click(earlier + ' ex-turn-work-panel button');
    await capture.waitFor(() => document.querySelector('[data-work-step="verification-note"]'));
    assert.equal(await capture.evaluate(selector => document.activeElement === document.querySelector(selector), earlier + ' button.work'), true);
    assert.equal(await capture.evaluate(() => document.querySelector('ex-composer textarea').value), 'Draft for the next check');
    yield { name: theme + '-retried', inspect: [earlier, 'ex-composer'] };
  }
}
