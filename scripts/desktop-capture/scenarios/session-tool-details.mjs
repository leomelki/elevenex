import assert from 'node:assert/strict';

const demo = 'ex-connected-workspace-demo';
const turn = '[data-chat-anchor="tool-history:reply"]';
const call = '[data-work-step="payment-tests"]';
const group = '[data-work-section="payment-tests"] .group';
const head = call + ' ex-tool-step .head';
const body = call + ' ex-tool-step ex-fold';
const notice = body + ' .detail-notice';
const preview = body + ' .tool-preview';
const inspect = [head, body, notice, preview, '[data-chat-row="test-summary"]', 'ex-composer'];

async function settleMotion(capture) {
  await capture.waitFor(() => document.getAnimations().every(animation =>
    animation.playState !== 'running' || !Number.isFinite(animation.effect?.getComputedTiming().endTime)));
}

export default async function* (capture) {
  for (const theme of ['light', 'dark']) {
    const reduced = theme === 'dark';
    await capture.evaluate(() => { location.href = '/connected-workspace'; });
    await capture.waitFor(() => document.querySelector('ex-machine-workspace ex-task-list'));
    await capture.viewport(reduced ? 780 : 1220, reduced ? 760 : 860);
    await capture.theme(theme);
    await capture.reducedMotion(reduced);
    await capture.component(demo, async viewer => {
      const chat = viewer.fixture.chat;
      chat.scenario('new', 101);
      const initial = await chat.read({ taskId: 11, sessionId: 101, requestId: window.crypto.randomUUID() });
      const row = (id, kind, text, extra = {}) => ({
        id, kind, text, timestamp: '2026-11-19T10:00:00Z',
        toolId: null, toolName: null, toolKind: null, input: '', error: false, truncated: false, ...extra,
      });
      const summary = 'pnpm test --filter payments';
      const evidence = [
        { id: 'payment-tests', revision: 'a'.repeat(64), record: row('payment-tests', 'tool_use', '', {
          toolId: 'payments', toolKind: 'bash', toolName: 'Command',
          input: JSON.stringify({ command: summary, cwd: '/workspace/payments' }),
        }) },
        { id: 'payment-test-output', revision: 'b'.repeat(64), record: row('payment-test-output', 'tool_result',
          'PASS  src/payments/retries.spec.ts\n  ✓ shares a claim across simultaneous requests\n  ✓ retries temporary provider failures\n  ✓ preserves a completed payment\n\nTests: 12 passed', {
            toolId: 'payments', execution: { exitCode: 0 },
          }) },
      ];
      const answer = row('test-summary', 'assistant',
        'All 12 payment tests passed. Simultaneous retries share one payment claim, and a completed payment keeps its original result.');
      chat.seed(101, { items: [row('tool-history', 'user', 'Verify the concurrent payment retries.', {
        completedTurn: { revision: 'c'.repeat(64), endId: answer.id, reply: [answer],
          beforeReply: 2, total: 2, counts: { run: 1 }, failures: 0, duration: 18 },
      })], state: { ...initial.value.state, providerLocked: true } });
      chat.seedTurnWork(101, 'tool-history', evidence.map(({ record, revision }, index) => ({
        ...record, text: '', input: '', execution: undefined,
        toolDetails: index ? { revision, meta: 'Exit 0' } : { revision, summary },
      })));
      chat.seedToolDetails(101, evidence);
      chat.toolDetailsBehavior('held');
    });
    await capture.component('ex-machine-workspace', workspace =>
      workspace.store.selectSession({ taskId: '11', sessionId: '101' }));
    await capture.waitFor(() => document.querySelector('[data-chat-row="test-summary"]')?.textContent.includes('12 payment tests passed'));
    await capture.evaluate(selector => document.querySelector(selector).scrollIntoView({ block: 'center' }), turn);
    await capture.click(turn + ' .work');
    await capture.waitFor(selector => document.querySelector(selector), group);
    await settleMotion(capture);
    await capture.click(group);
    await settleMotion(capture);
    await capture.hover(head);
    await capture.evaluate(selector => document.querySelector(selector).focus({ preventScroll: true }), head);
    assert.equal(await capture.component(demo, viewer => viewer.fixture.chat.toolDetailsReads), 0);
    yield { name: theme + '-collapsed', inspect };

    await capture.press('Enter');
    await capture.waitFor(selector => document.querySelector(selector)?.getAttribute('aria-busy') === 'true', head);
    await settleMotion(capture);
    assert.equal(await capture.evaluate(selector => document.activeElement === document.querySelector(selector), head), true);
    assert.equal(await capture.evaluate(selector => document.querySelector(selector), notice), null);
    yield { name: theme + '-pending', inspect };

    await capture.press('Enter');
    await capture.waitFor(selector => document.querySelector(selector)?.hasAttribute('inert'), body);
    await capture.waitFor(selector => !document.querySelector(selector)?.hasAttribute('aria-busy'), head);
    assert.equal(await capture.component(demo, viewer => viewer.fixture.chat.toolDetailsCancelled), 1);
    assert.equal(await capture.evaluate(selector => document.querySelector(selector), preview), null);
    yield { name: theme + '-interrupted', inspect };

    if (reduced) {
      await capture.component(demo, viewer => viewer.fixture.chat.toolDetailsBehavior('failed'));
      await capture.press('Enter');
      await capture.waitFor(selector => document.querySelector(selector)?.textContent.includes('Couldn’t load tool details'), body);
      yield { name: theme + '-retry', inspect };
      await capture.component(demo, viewer => viewer.fixture.chat.toolDetailsBehavior('ready'));
      await capture.press('Tab');
      assert.equal(await capture.evaluate(() => document.activeElement?.textContent.trim()), 'Retry');
      await capture.press('Enter');
    } else {
      await capture.press('Enter');
      await capture.waitFor(selector => document.querySelector(selector)?.getAttribute('aria-busy') === 'true', head);
      await settleMotion(capture);
      const top = await capture.evaluate(selector => document.querySelector(selector).getBoundingClientRect().top, head);
      const startHeight = await capture.evaluate(selector => document.querySelector(selector).getBoundingClientRect().height, body);
      let height = startHeight;
      await capture.motion.freeze();
      await capture.component(demo, viewer => viewer.fixture.chat.toolDetailsBehavior('ready'));
      await capture.waitFor(selector => document.querySelector(selector)?.textContent.includes('Tests: 12 passed'), preview);
      for await (const frame of capture.frames('light-evidence-reveal', [0, 70, 140, 280], inspect)) {
        const measured = await capture.evaluate((head, body) => ({
          top: document.querySelector(head).getBoundingClientRect().top,
          height: document.querySelector(body).getBoundingClientRect().height,
        }), head, body);
        assert.ok(Math.abs(top - measured.top) < 2, 'The tool header moved while its evidence loaded');
        assert.ok(measured.height >= height - 1, 'The tool body shrank during evidence entry');
        height = measured.height;
        yield frame;
      }
      assert.ok(height > startHeight + 24, 'The body did not grow to fit its evidence');
      await capture.motion.play();
    }

    await capture.waitFor(selector => document.querySelector(selector)?.textContent.includes('Tests: 12 passed'), preview);
    await settleMotion(capture);
    assert.equal(await capture.evaluate(selector => document.activeElement === document.querySelector(selector), head), true);
    yield { name: theme + '-ready', inspect };

    const reads = await capture.component(demo, viewer => viewer.fixture.chat.toolDetailsReads);
    await capture.press('Enter');
    await capture.waitFor(selector => !document.querySelector(selector), preview);
    await capture.press('Enter');
    await capture.waitFor(selector => document.querySelector(selector), preview);
    assert.equal(await capture.component(demo, viewer => viewer.fixture.chat.toolDetailsReads), reads);
    assert.equal(await capture.evaluate(selector => document.querySelector(selector), notice), null);
    await settleMotion(capture);
    yield { name: theme + '-cached', inspect };
  }
}
