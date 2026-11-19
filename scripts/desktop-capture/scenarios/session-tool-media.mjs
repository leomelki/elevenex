import assert from 'node:assert/strict';

export default async function* (capture) {
  const session = 'ex-machine-workspace ex-session-chat';
  const row = id => session + ' [data-work-step="' + id + '"]';
  const work = session + ' button.work';
  const group = id => row(id) + ' button.group';
  const reveal = async selector => {
    await capture.waitFor(selector => {
      const target = document.querySelector(selector);
      if (!target || target.closest('[inert]')) return false;
      target.scrollIntoView({ block: 'center' });
      const bounds = target.getBoundingClientRect();
      const hit = document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
      return target.contains(hit);
    }, selector);
    await capture.click(selector);
  };
  const hidden = (id) => capture.evaluate(selector => {
    const fold = document.querySelector(selector + ' .step-fold');
    return fold?.hasAttribute('inert') === true && fold.getBoundingClientRect().height <= 1;
  }, row(id));

  for (const theme of ['light', 'dark']) {
    const narrow = theme === 'dark';
    await capture.evaluate(theme => { location.href = '/connected-workspace?toolMedia=' + theme; }, theme);
    await capture.waitFor(theme => location.search === '?toolMedia=' + theme && document.querySelector('ex-machine-workspace ex-task-list'), theme);
    await capture.theme(theme);
    await capture.viewport(narrow ? 1000 : 1440, narrow ? 760 : 960);
    await capture.reducedMotion(narrow);
    await capture.component('ex-connected-workspace-demo', async owner => {
      owner.fixture.chat.scenario('new', 101);
      const reply = await owner.fixture.chat.read({ taskId: 11, sessionId: 101, requestId: window.crypto.randomUUID() });
      if (!reply.ok) throw new Error('Could not prepare the session');
      const item = (id, kind, text, fields = {}) => ({
        id, kind, text, timestamp: '2026-11-17T10:00:00Z', toolId: null, toolName: null,
        toolKind: null, input: '', error: false, truncated: false, ...fields,
      });
      const photo = (id, caption) => ({ id: '0', path: id, caption, inline: true });
      owner.fixture.chat.seed(101, { state: reply.value.state, items: [
        item('prompt', 'user', 'Check the interface and capture each state.'),
        item('first-call', 'tool_use', '', { toolId: 'first-call', toolName: 'view_image' }),
        item('before-image', 'assistant', 'I am opening the first capture.'),
        item('first-result', 'tool_result', 'Image attachment', {
          toolId: 'first-call', media: [photo('first-image', 'First capture')],
        }),
        item('after-image', 'assistant', 'The first capture confirms the toolbar position.'),
        item('second-result', 'tool_result', 'Image attachment', { media: [photo('second-image', 'Second capture')] }),
        item('answer', 'assistant', 'The interface checks are complete.'),
        item('late-result', 'tool_result', 'Image attachment', { media: [photo('late-image', 'Late capture')] }),
      ] });
    });
    await capture.component('ex-machine-workspace', owner => owner.store.selectSession({ taskId: '11', sessionId: '101' }));
    await capture.waitFor(selector => document.querySelector(selector + ' img'), row('first-result'));
    for (const id of ['first-result', 'second-result', 'late-result'])
      assert.equal(await hidden(id), true, id + ' escaped its collapsed section');
    assert.equal(await capture.evaluate(selector => document.querySelector(selector + ' img') === null, row('answer')), true);
    yield { name: theme + '-collapsed', inspect: [work, row('answer'), row('first-result') + ' .step-fold'] };

    await reveal(work);
    await reveal(group('first-result'));
    await capture.waitFor(selector => document.querySelector(selector + ' .step-fold').getBoundingClientRect().height > 10, row('first-result'));
    await reveal(group('second-result'));
    await reveal(group('late-result'));
    await capture.settle();
    const tops = await capture.evaluate(selector => ['before-image', 'first-result', 'after-image', 'second-result', 'answer', 'late-result']
      .map(id => document.querySelector(selector + ' [data-work-step="' + id + '"] .step-fold').getBoundingClientRect().top), session);
    assert.ok(tops.every((top, index) => index === 0 || top > tops[index - 1]), 'Previews must stay in source order around messages');
    await capture.evaluate(selector => document.querySelector(selector).scrollIntoView({ block: 'center' }), row('first-result') + ' img');
    yield { name: theme + '-receipt-between-messages', inspect: [row('before-image'), row('first-result'), row('after-image')], metadata: { tops } };

    await reveal(row('first-result') + ' button.image');
    await capture.waitFor(() => document.querySelector('.image-viewer[aria-label="First capture"]'));
    await capture.component(session + ' ex-work-timeline', owner => owner.toggleGroup('first-result'));
    await capture.waitFor(() => !document.querySelector('.image-viewer[aria-label="First capture"]'));
    await capture.waitFor(selector => document.querySelector(selector + ' .step-fold').getBoundingClientRect().height <= 1, row('first-result'));
    assert.equal(await hidden('first-result'), true);
    await reveal(work);
    await capture.waitFor(selector => document.querySelector(selector + ' .step-fold').getBoundingClientRect().height <= 1, row('late-result'));
    assert.equal(await hidden('second-result'), true);
    assert.equal(await hidden('late-result'), true);
  }
}
