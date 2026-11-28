import assert from 'node:assert/strict';

export default async function* (capture) {
  const session = 'ex-machine-workspace ex-session-chat';
  const row = id => session + ' [data-work-step="' + id + '"]';
  const work = session + ' button.work';
  const group = id => session + ' [data-work-section="' + id + '"] button.group';
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
        item('first-call', 'tool_use', '', {
          toolId: 'view', toolName: 'View image', toolKind: 'image_view', input: '{"path":"first-image"}',
        }),
        item('before-image', 'assistant', 'I am opening the first capture.'),
        item('first-result', 'tool_result', 'Image attachment', {
          toolId: 'view', media: [photo('first-image', 'First capture')],
        }),
        item('after-image', 'assistant', 'The first capture confirms the toolbar position.'),
        item('second-result', 'tool_result', 'Image attachment', { media: [photo('second-image', 'Second capture')] }),
        item('answer', 'assistant', 'The interface checks are complete.'),
        item('late-result', 'tool_result', 'Image attachment', { media: [photo('late-image', 'Late capture')] }),
      ] });
    });
    await capture.component('ex-machine-workspace', owner => owner.store.selectSession({ taskId: '11', sessionId: '101' }));
    await capture.waitFor(selector => document.querySelector(selector + ' img'), row('second-result'));
    for (const id of ['first-call', 'second-result', 'late-result'])
      assert.equal(await hidden(id), true, id + ' escaped its collapsed section');
    assert.equal(await capture.evaluate(selector => document.querySelector(selector) === null, row('first-result')), true);

    await reveal(work);
    await reveal(group('first-call'));
    const head = row('first-call') + ' ex-tool-step button.head';
    const preview = row('first-call') + ' ex-tool-step .tool-images';
    await capture.waitFor(selector => {
      const button = document.querySelector(selector);
      return button?.getAttribute('aria-expanded') === 'false' && !button.closest('[inert]');
    }, head);
    assert.equal(await capture.evaluate(selector => !document.querySelector(selector), preview), true);
    yield { name: theme + '-tool-collapsed', inspect: [head, row('before-image')] };

    await capture.component('ex-connected-workspace-demo', owner => owner.fixture.chat.imageDelivery('held'));
    await capture.evaluate(selector => document.querySelector(selector).focus(), head);
    await capture.press('Enter');
    await capture.waitFor(selector => document.querySelector(selector)?.textContent.includes('Loading image'), preview);
    await capture.component('ex-connected-workspace-demo', owner => owner.fixture.chat.imageDelivery('ready'));
    await capture.waitFor(selector => document.querySelector(selector + ' img')?.naturalWidth > 0, preview);
    await capture.settle();
    yield { name: theme + '-tool-expanded', inspect: [head, preview, row('before-image')] };

    await reveal(preview + ' button.image');
    await capture.waitFor(() => document.querySelector('.image-viewer[aria-label="First capture"]'));
    await capture.press('Escape');
    await capture.waitFor(selector => !document.querySelector('.image-viewer') &&
      document.activeElement === document.querySelector(selector), preview + ' button.image');
    await reveal(head);
    await capture.waitFor(selector => !document.querySelector(selector), preview);
    assert.equal(await capture.evaluate(selector => document.querySelector(selector)?.getAttribute('aria-expanded'), head), 'false');

    await reveal(group('second-result'));
    await reveal(group('late-result'));
    await capture.settle();
    const tops = await capture.evaluate(selector => ['first-call', 'before-image', 'after-image', 'second-result', 'answer', 'late-result']
      .map(id => document.querySelector(selector + ' [data-work-step="' + id + '"] .step-fold').getBoundingClientRect().top), session);
    assert.ok(tops.every((top, index) => index === 0 || top > tops[index - 1]), 'Previews must stay in source order around messages');
    await capture.evaluate(selector => document.querySelector(selector).scrollIntoView({ block: 'center' }), row('second-result') + ' img');
    yield { name: theme + '-receipt-between-messages', inspect: [row('after-image'), row('second-result'), row('answer')], metadata: { tops } };

    await reveal(work);
    await capture.waitFor(selector => document.querySelector(selector + ' .step-fold').getBoundingClientRect().height <= 1, row('late-result'));
    assert.equal(await hidden('second-result'), true);
    assert.equal(await hidden('late-result'), true);
  }
}
