import assert from 'node:assert/strict';

const owner = 'ex-connected-workspace-demo';
const turn = '[data-chat-anchor="retries:reply"]';
const work = turn + ' button.work';
const panel = turn + ' ex-turn-work-panel';
const reply = '[data-chat-row="retry-final"]';
const inspect = [work, panel, reply, turn + ' ex-outcome-bar', 'ex-composer'];

async function settleMotion(capture) {
  await capture.waitFor(() => document.getAnimations().every(animation =>
    animation.playState !== 'running' || !Number.isFinite(animation.effect?.getComputedTiming().endTime)));
}

export default async function* (capture) {
  for (const theme of ['light', 'dark']) {
    const narrow = theme === 'dark';
    await capture.evaluate(() => { location.href = '/connected-workspace'; });
    await capture.waitFor(() => document.querySelector('ex-machine-workspace ex-task-list'));
    await capture.viewport(narrow ? 780 : 1280, narrow ? 760 : 900);
    await capture.theme(theme);
    await capture.reducedMotion(narrow);
    await capture.component(owner, async viewer => {
      const chat = viewer.fixture.chat;
      chat.scenario('new', 101);
      const initial = await chat.read({ taskId: 11, sessionId: 101, requestId: window.crypto.randomUUID() });
      const row = (id, kind, text, extra = {}) => ({
        id, kind, text, timestamp: '2026-11-19T10:00:00Z',
        toolId: null, toolName: null, toolKind: null, input: '', error: false, truncated: false, ...extra,
      });
      const call = (id, kind, input) => [
        row(id, 'tool_use', '', { toolId: id, toolKind: kind, input: JSON.stringify(input) }),
        row(id + '-result', 'tool_result', kind === 'bash' ? '12 tests passed.' : 'Done', { toolId: id }),
      ];
      const evidence = [
        row('approach', 'assistant', 'I found the race: both requests can reach the payment provider before either records its result. I’ll make the claim atomic and verify it with overlapping requests.'),
        ...call('read-retry', 'read', { file_path: 'src/payments/retry.ts' }),
        ...call('read-db', 'read', { file_path: 'src/payments/store.ts' }),
        ...call('read-test', 'read', { file_path: 'src/payments/retry.test.ts' }),
        ...call('edit-retry', 'edit', { file_path: 'src/payments/retry.ts', old_string: 'readClaim(key)', new_string: 'claim(key)' }),
        ...call('edit-test', 'edit', { file_path: 'src/payments/retry.test.ts', old_string: '', new_string: 'test("deduplicates a concurrent retry", async () => {})' }),
        row('validation-note', 'assistant', 'The unique constraint now chooses one request. The other waits for its receipt.'),
        ...call('tests', 'bash', { command: 'pnpm test --filter payments' }),
        ...call('check', 'bash', { command: 'pnpm lint --filter payments' }),
      ];
      const final = row('retry-final', 'assistant',
        'Concurrent retries now share the same payment result.\n\n- The first request claims the idempotency key before calling the provider.\n- The second request waits for the existing result, even when the provider is slow.\n\nAll 12 payment tests passed.');
      const saved = row('retries', 'user', 'Prevent duplicate charges when two payment retries overlap.', {
        completedTurn: {
          revision: 'a'.repeat(64), endId: 'retry-final', reply: [final],
          beforeReply: evidence.length, total: evidence.length, counts: { read: 3, edit: 2, run: 2 },
          failures: 0, duration: 94, changes: { total: 3, shared: true, files: [
            { path: 'src/payments/retry.ts', status: 'M', add: 28, del: 6 },
            { path: 'src/payments/retry.test.ts', status: 'M', add: 46, del: 0 },
            { path: 'src/payments/store.ts', status: 'M', add: 12, del: 2 },
          ] },
        },
      });
      const olderWork = Array.from({ length: 21 }, (_, number) =>
        call('verify-' + number, 'read', { file_path: 'src/payments/case-' + number + '.ts' })).flat();
      const shellRead = row('verify-0', 'tool_use', '', {
        toolId: 'verify-0', toolKind: 'read', toolName: 'Read', input: JSON.stringify({
          file_path: 'src/payments/case-0.ts',
          command: 'cat src/payments/case-0.ts src/payments/store.ts',
          commandActions: [
            { type: 'read', path: 'src/payments/case-0.ts' },
            { type: 'read', path: 'src/payments/store.ts' },
          ],
        }),
      });
      const shellResult = row('verify-0-result', 'tool_result', 'Read retry policy and payment store.', {
        toolId: 'verify-0', execution: { exitCode: 0 },
      });
      const callHeading = { revision: 'c'.repeat(64), summary: 'src/payments/case-0.ts +1 more' };
      const resultHeading = { revision: 'd'.repeat(64) };
      olderWork.splice(0, 2, { ...shellRead, input: '', toolDetails: callHeading,
        receipt: { id: shellResult.id, error: false, toolDetails: resultHeading },
      });
      olderWork.splice(olderWork.length - 2, 0,
        row('verify-last-case', 'assistant', 'The last case checks a duplicate claim.'));
      olderWork.push({ ...shellResult, text: '', execution: undefined, toolDetails: resultHeading,
        invocation: { id: shellRead.id, toolKind: shellRead.toolKind, toolDetails: callHeading },
      });
      const earlier = row('verification', 'user', 'Check which cases already cover retry behavior.', {
        completedTurn: {
          revision: 'b'.repeat(64), endId: 'verification-reply',
          reply: [row('verification-reply', 'assistant', 'The existing suite covers a single request and transient failures. I found no test for overlapping retries.')],
          beforeReply: olderWork.length, total: olderWork.length, counts: { read: 21 }, failures: 0, duration: 38,
        },
      });
      chat.seed(101, { items: [earlier, saved], state: { ...initial.value.state, providerLocked: true } });
      chat.seedTurnWork(101, 'verification', olderWork);
      chat.seedTurnWork(101, 'retries', evidence);
      chat.seedToolDetails(101, [
        { id: shellRead.id, revision: callHeading.revision, record: shellRead },
        { id: shellResult.id, revision: resultHeading.revision, record: shellResult },
      ]);
      chat.turnWorkBehavior('held');
    });
    await capture.component('ex-machine-workspace', workspace => workspace.store.selectSession({ taskId: '11', sessionId: '101' }));
    await capture.waitFor(selector => document.querySelector(selector)?.textContent.includes('All 12 payment tests passed.'), reply);
    await capture.fill('ex-composer textarea', 'Draft for the next check');
    await capture.evaluate((work, reply) => {
      document.querySelector(reply).dataset.captureIdentity = 'same-reply';
      document.querySelector(work).scrollIntoView({ block: 'center' });
    }, work, reply);
    await settleMotion(capture);
    assert.equal(await capture.component(owner, viewer => viewer.fixture.chat.turnWorkReads), 0);
    assert.match(await capture.evaluate(selector => document.querySelector(selector).textContent, work), /3 reads/);
    assert.match(await capture.evaluate(selector => document.querySelector(selector).textContent, work), /3 workspace changes/);
    yield { name: theme + '-collapsed', inspect };

    await capture.click(work);
    await capture.waitFor(selector => !!document.querySelector(selector + ' ex-fold.open .waiting'), panel);
    await settleMotion(capture);
    assert.equal(await capture.evaluate(selector => document.querySelector(selector).getAttribute('aria-expanded'), work), 'true');
    yield { name: theme + '-loading', inspect };

    await capture.press('Enter');
    await capture.waitFor(selector => !!document.querySelector(selector + ' ex-fold[inert]'), panel);
    await capture.component(owner, viewer => viewer.fixture.chat.turnWorkBehavior('ready'));
    await settleMotion(capture);
    assert.equal(await capture.evaluate(() => document.querySelector('[data-work-step="approach"]')), null);
    yield { name: theme + '-interrupted', inspect };

    const priorReads = await capture.component(owner, viewer => viewer.fixture.chat.turnWorkReads);
    await capture.component(owner, viewer => viewer.fixture.chat.turnWorkBehavior('held'));
    await capture.hover('ex-composer textarea');
    await capture.hover(work);
    await capture.waitFor((selector, reads) =>
      window.ng.getComponent(document.querySelector(selector)).fixture.chat.turnWorkReads === reads + 1, owner, priorReads);
    assert.equal(await capture.evaluate(selector => document.querySelector(selector).getAttribute('aria-expanded'), work), 'false');
    await capture.click(work);
    await capture.waitFor(selector => !!document.querySelector(selector + ' ex-fold.open .waiting'), panel);
    assert.equal(await capture.component(owner, viewer => viewer.fixture.chat.turnWorkReads), priorReads + 1);
    await settleMotion(capture);
    const workTop = await capture.evaluate(selector => document.querySelector(selector).getBoundingClientRect().top, work);
    if (!narrow) await capture.motion.freeze();
    await capture.component(owner, viewer => viewer.fixture.chat.turnWorkBehavior('ready'));
    await capture.waitFor(selector => !document.querySelector(selector + ' ex-work-timeline[aria-busy]'), turn);
    assert.equal(await capture.evaluate(() => !!document.querySelector('[data-work-step="approach"]')), true,
      await capture.evaluate(selector => document.querySelector(selector + ' ex-turn-work-panel')?.textContent, turn));
    if (!narrow) {
      for await (const frame of capture.frames('light-activity-reveal', [0, 80, 160, 280], inspect)) {
        const currentTop = await capture.evaluate(selector => document.querySelector(selector).getBoundingClientRect().top, work);
        assert.ok(Math.abs(currentTop - workTop) < 2, 'The disclosure control moved during the reveal');
        yield frame;
      }
      await capture.motion.play();
    }
    await settleMotion(capture);
    assert.equal(await capture.evaluate(selector => document.querySelector(selector).dataset.captureIdentity, reply), 'same-reply');
    assert.equal(await capture.evaluate(selector => document.activeElement === document.querySelector(selector), work), true);
    yield { name: theme + '-expanded', inspect };

    const reads = await capture.component(owner, viewer => viewer.fixture.chat.turnWorkReads);
    await capture.click(work);
    await capture.waitFor(() => !document.querySelector('[data-work-step="approach"]'));
    await capture.click(work);
    await capture.waitFor(() => !!document.querySelector('[data-work-step="approach"]'));
    assert.equal(await capture.component(owner, viewer => viewer.fixture.chat.turnWorkReads), reads);
    assert.equal(await capture.evaluate(selector => document.querySelector(selector + ' .waiting'), panel), null);
    await settleMotion(capture);
    yield { name: theme + '-cached-reopen', inspect };

    const older = '[data-chat-anchor="verification:reply"]';
    const earlierButton = older + ' button.work';
    await capture.click(work);
    await capture.evaluate(selector => document.querySelector(selector).scrollIntoView({ block: 'center' }), earlierButton);
    await capture.component(owner, viewer => viewer.fixture.chat.turnWorkBehavior('failed'));
    await settleMotion(capture);
    await capture.click(earlierButton);
    await capture.waitFor(selector => document.querySelector(selector + ' ex-turn-work-panel .error')?.textContent.includes('Couldn’t load'), older);
    await settleMotion(capture);
    yield { name: theme + '-retry', inspect: [earlierButton, older + ' ex-turn-work-panel'] };
    await capture.component(owner, viewer => viewer.fixture.chat.turnWorkBehavior('ready'));
    await capture.click(older + ' ex-turn-work-panel button');
    await capture.waitFor(selector => document.querySelector(selector + ' .pagination'), older);
    await settleMotion(capture);
    const later = older + ' .pagination button:last-child';
    await capture.component(owner, viewer => viewer.fixture.chat.turnWorkBehavior('held'));
    await capture.click(later);
    await capture.waitFor(selector => document.querySelector(selector)?.getAttribute('aria-disabled') === 'true', later);
    await capture.component(owner, viewer => viewer.fixture.chat.turnWorkBehavior('failed'));
    await capture.waitFor(selector => document.querySelector(selector + ' .page-error')?.textContent.includes('Couldn’t load'), older);
    assert.equal(await capture.evaluate(selector => document.activeElement === document.querySelector(selector), later), true);
    assert.match(await capture.evaluate(selector => document.querySelector(selector + ' .status').textContent, older), /1–40 of 43/);
    await settleMotion(capture);
    yield { name: theme + '-page-error', inspect: [earlierButton, later, older + ' ex-turn-work-panel'] };
    await capture.component(owner, viewer => viewer.fixture.chat.turnWorkBehavior('ready'));
    await capture.press('Enter');
    await capture.waitFor(selector => document.querySelector(selector + ' ex-turn-work-panel .status')?.textContent.includes('41–43 of 43'), older);
    await settleMotion(capture);
    assert.equal(await capture.evaluate(() => document.querySelector('ex-composer textarea').value), 'Draft for the next check');
    yield { name: theme + '-later-activity', inspect: [earlierButton, older + ' ex-turn-work-panel', 'ex-composer'] };

    const result = '[data-work-step="verify-0-result"]';
    const resultHead = result + ' ex-tool-step .head';
    const group = older + ' .group-fold.open .group';
    await capture.evaluate(selector => document.querySelector(selector).scrollIntoView({ block: 'center' }), group);
    await capture.click(group);
    await settleMotion(capture);
    assert.match(await capture.evaluate(selector => document.querySelector(selector).textContent, resultHead), /Result.*case-0\.ts \+1 more/);
    const detailReads = await capture.component(owner, viewer => viewer.fixture.chat.toolDetailsReads);
    await capture.click(resultHead);
    await capture.waitFor(selector => document.querySelector(selector + ' .tool-preview')?.textContent.includes('store.ts'), result);
    await settleMotion(capture);
    assert.equal(await capture.component(owner, viewer => viewer.fixture.chat.toolDetailsReads), detailReads + 1);
    assert.equal(await capture.evaluate(selector => document.activeElement === document.querySelector(selector), resultHead), true);
    yield { name: theme + '-split-tool-evidence', inspect: [result, resultHead, later, 'ex-composer'] };
  }
}
