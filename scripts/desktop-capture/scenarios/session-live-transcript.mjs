import assert from 'node:assert/strict';

/** A running patch, interleaved prose and a background prompt in the real chat. */
export default async function* (capture) {
  const demo = (fn, value) => capture.component('ex-connected-workspace-demo', fn, value);
  const select = id => capture.component('ex-machine-workspace', (owner, sessionId) =>
    owner.store.selectSession({ taskId: '11', sessionId }), id);
  const patch = '[data-chat-row="patch"] ex-tool-step';
  const settle = async () => {
    await capture.settle();
    await capture.waitFor(() => document.getAnimations().every(animation =>
      !Number.isFinite(animation.effect?.getComputedTiming().endTime) || animation.playState !== 'running'));
  };
  const seed = (phase, state) => demo((owner, { phase, state }) => {
    const row = (id, kind, text, extra = {}) => ({
      id, kind, text, timestamp: '2026-11-22T10:00:00Z',
      toolId: null, toolKind: null, toolName: null, input: '', error: false, truncated: false, ...extra,
    });
    const saved = Array.from({ length: 12 }, (_, i) => [
      row('prompt-' + i, 'user', 'Check the notes for section ' + i),
      row('reply-' + i, 'assistant', ('The notes are consistent. The original wording is available for review.\n\n').repeat(5)),
    ]).flat();
    const items = [
      ...saved, row('active', 'user', 'Update the project notes.'),
      row('intro', 'assistant', 'I found the section that needs an update.', { assistantPhase: 'commentary' }),
      row('patch', 'tool_use', '', {
        toolId: 'patch', toolKind: 'file_changes', toolName: 'File changes',
        input: JSON.stringify({ changes: [{ path: 'notes.txt', kind: 'add', diff: 'Updated notes\n' }] }),
      }),
      row('progress', 'assistant', 'I’m checking the resulting notes.', { assistantPhase: 'commentary' }),
      ...(phase === 'running' ? [] : [row('patch-result', 'tool_result', 'Updated notes.txt', { toolId: 'patch' })]),
      ...(phase === 'background' ? [
        row('final', 'assistant', 'The notes are updated.', { assistantPhase: 'final' }),
        row('background', 'user', 'Also check the new links.'),
        row('new-reply', 'assistant', 'I’ll check the links next.'),
      ] : []),
    ];
    owner.fixture.chat.seed(101, { items, state: { ...state, provider: 'codex', phase: 'running',
      canInterrupt: true, activePromptId: phase === 'background' ? 'background' : 'active' } });
  }, { phase, state });

  for (const theme of ['light', 'dark']) {
    await capture.evaluate(theme => { location.href = '/connected-workspace?capture=' + theme; }, theme);
    await capture.waitFor(theme => location.search === '?capture=' + theme &&
      document.querySelector('ex-machine-workspace ex-task-list'), theme);
    await capture.theme(theme);
    await capture.viewport(theme === 'light' ? 1440 : 1000, theme === 'light' ? 960 : 760);
    await capture.reducedMotion(theme === 'dark');
    const state = await demo(async owner => {
      owner.fixture.chat.scenario('new', 101);
      return (await owner.fixture.chat.read({ taskId: 11, sessionId: 101, requestId: window.crypto.randomUUID() })).value.state;
    });
    await seed('running', state);
    await select('101');
    await capture.waitFor(selector => document.querySelector(selector + ' section.running'), patch);
    await settle();
    await capture.evaluate(selector => document.querySelector(selector).setAttribute('data-captured-start', ''), patch);
    yield { name: theme + '-running', inspect: ['[data-chat-anchor="active:reply"]', patch] };

    await seed('receipt', state);
    await capture.waitFor(selector => document.querySelector(selector) && !document.querySelector(selector + ' section.running'), patch);
    await settle();
    assert.deepEqual(await capture.evaluate(selector => {
      const tool = document.querySelector(selector);
      return {
        retained: tool.hasAttribute('data-captured-start'),
        visible: !tool.closest('ex-fold[inert]'),
        order: [...tool.closest('ex-work-timeline').querySelectorAll('[data-chat-row]')].map(row => row.dataset.chatRow),
      };
    }, patch), { retained: true, visible: true, order: ['intro', 'patch', 'progress'] });
    yield { name: theme + '-patch-receipt', inspect: ['[data-chat-anchor="active:reply"]', patch] };

    await capture.evaluate(() => document.querySelector('[data-chat-row="reply-6"]').scrollIntoView({ block: 'center' }));
    await settle();
    const position = () => capture.evaluate(() => document.querySelector('[data-chat-row="reply-6"]').getBoundingClientRect().top);
    const before = await position();
    await seed('background', state);
    await capture.waitFor(() => document.querySelector('[data-chat-anchor="background:reply"]'));
    await settle();
    const after = await position();
    assert.ok(Math.abs(after - before) <= 1, `Background prompt moved the visible reply by ${after - before}px.`);
    yield { name: theme + '-reading-through-background-prompt', inspect: ['ex-chat-scroll .viewport', '[data-chat-row="reply-6"]'], metadata: { before, after } };

    await select('102');
    await select('101');
    await capture.waitFor(() => document.querySelector('[data-chat-row="new-reply"]'));
    await settle();
    const prompts = await capture.evaluate(() => [...document.querySelectorAll('[data-user-message]')].map(row => row.dataset.userMessage));
    assert.deepEqual(prompts, [...Array.from({ length: 12 }, (_, i) => 'prompt-' + i), 'active', 'background']);
    yield { name: theme + '-reopen-running', inspect: ['[data-chat-anchor="background:reply"]', 'ex-chat-scroll .viewport'] };
  }
}
