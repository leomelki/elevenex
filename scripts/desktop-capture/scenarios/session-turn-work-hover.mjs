import assert from 'node:assert/strict';

const owner = 'ex-connected-workspace-demo';
const turn = id => `[data-chat-anchor="${id}:reply"]`;
const work = id => turn(id) + ' button.work';
const timeline = id => turn(id) + ' ex-work-timeline';
const reply = id => `[data-chat-row="${id}-reply"] .answer`;
const activity = id => `[data-work-step="${id}-work"]`;

async function seed(viewer) {
  const chat = viewer.fixture.chat;
  chat.scenario('new', 101);
  const initial = await chat.read({ taskId: 11, sessionId: 101, requestId: window.crypto.randomUUID() });
  const row = (id, kind, text) => ({
    id, kind, text, timestamp: '2026-11-19T10:00:00Z', toolId: null, toolKind: null, toolName: null,
    input: '', error: false, truncated: false,
  });
  const small = id => [row(id + '-work', 'assistant', 'I checked the saved results.')];
  const medium = Array.from({ length: 24 }, (_, index) => [
    { kind: 'call', id: index ? 'medium-read-' + index : 'medium-work', toolKind: 'read',
      label: 'src/check-' + index + '.ts', resultId: 'medium-result-' + index },
    null,
  ]).flat();
  const items = [
    { id: 'slow', hidden: small('slow'), counts: {} },
    { id: 'hovered', hidden: small('hovered'), counts: {} },
    { id: 'medium', hidden: medium, counts: { read: 24 } },
  ].map(({ id, hidden, counts }) => {
    const answer = row(id + '-reply', 'assistant', 'The check passed.');
    chat.seedTurnTimeline(101, id, hidden);
    return { ...row(id, 'user', 'Check the saved results.'), completedTurn: {
      revision: 'a'.repeat(64), endId: answer.id, reply: [answer], beforeReply: hidden.length,
      total: hidden.length, counts, failures: 0, duration: 2,
    } };
  });
  chat.seed(101, { items, state: { ...initial.value.state, providerLocked: true } });
  chat.turnWorkBehavior('held');
}

export default async function* (capture) {
  const fixture = (change, data) => capture.component(owner, change, data);
  const reads = () => fixture(viewer => viewer.fixture.chat.turnWorkReads);
  const workBehavior = behavior => fixture((viewer, value) => viewer.fixture.chat.turnWorkBehavior(value), behavior);
  const scrollTo = async selector => {
    await capture.waitFor(() => document.querySelector('ex-chat-scroll').getAnimations({ subtree: true }).every(animation =>
      animation.playState !== 'running' || !Number.isFinite(animation.effect?.getComputedTiming().endTime)));
    await capture.settle();
    await capture.evaluate(target => document.querySelector(target).scrollIntoView({ block: 'center', behavior: 'instant' }), selector);
    await capture.settle();
  };
  const waitForReads = count => capture.waitFor((selector, expected) =>
    window.ng.getComponent(document.querySelector(selector)).fixture.chat.turnWorkReads === expected, owner, count);
  const busy = id => capture.waitFor(selector =>
    document.querySelector(selector)?.getAttribute('aria-busy') === 'true', timeline(id));

  for (const theme of ['light', 'dark']) {
    const narrow = theme === 'dark';
    await capture.evaluate(theme => { location.href = '/connected-workspace?work-hover=' + theme; }, theme);
    await capture.waitFor(theme => location.search === '?work-hover=' + theme && document.querySelector('ex-machine-workspace ex-task-list'), theme);
    await capture.viewport(narrow ? 780 : 1280, narrow ? 760 : 900);
    await capture.cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1, y: 1 });
    await capture.theme(theme);
    await capture.reducedMotion(narrow);
    await fixture(seed);
    await capture.component('ex-machine-workspace', component => component.store.selectSession({ taskId: '11', sessionId: '101' }));
    await capture.waitFor(selector => document.querySelector(selector), reply('medium'));
    assert.equal(await reads(), 0);

    await scrollTo(work('slow'));
    await capture.click(work('slow'));
    await busy('slow');
    await scrollTo(reply('hovered'));
    await capture.hover(reply('hovered'));
    await waitForReads(2);
    assert.equal(await capture.evaluate(selector => document.querySelector(selector)?.getAttribute('aria-expanded'), work('hovered')), 'false');
    assert.equal(await capture.evaluate(selector => document.querySelector(selector), activity('hovered')), null);
    await capture.hover(work('hovered'));
    yield { name: theme + '-preload-during-another-open', inspect: [work('slow'), work('hovered'), reply('hovered')] };

    await workBehavior('ready');
    await capture.waitFor(selector => document.querySelector(selector), activity('slow'));
    await workBehavior('held');
    await scrollTo(work('hovered'));
    await capture.click(work('hovered'));
    await capture.waitFor(selector => document.querySelector(selector), activity('hovered'));
    assert.equal(await reads(), 2);
    assert.equal(await capture.evaluate(selector => document.querySelector(selector)?.hasAttribute('aria-busy'), timeline('hovered')), false);
    yield { name: theme + '-first-open-from-cache', inspect: [work('hovered'), activity('hovered'), reply('hovered')] };

    await scrollTo(work('medium'));
    await capture.hover(work('medium'));
    await waitForReads(3);
    await capture.click(work('medium'));
    await busy('medium');
    assert.equal(await reads(), 3);
    await workBehavior('ready');
    await capture.waitFor(selector => document.querySelector(selector), activity('medium'));
    assert.equal(await reads(), 3);
    assert.equal(await capture.evaluate(selector => document.activeElement === document.querySelector(selector), work('medium')), true);
    await scrollTo(work('medium'));
    yield { name: theme + '-open-joins-preload', inspect: [work('medium'), activity('medium'), reply('medium')] };
  }
}
