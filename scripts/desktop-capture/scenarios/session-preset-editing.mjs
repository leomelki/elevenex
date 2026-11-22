import assert from 'node:assert/strict';

export default async function* (capture) {
  await capture.evaluate(() => { location.href = '/connected-workspace'; });
  await capture.waitFor(() => !!document.querySelector('ex-workspace-navigation ex-task-list'));
  const catalog = mode => capture.component('ex-connected-workspace-demo', (c, mode) => c.fixture.chat.presetCatalog(mode), mode);
  await catalog('editing');
  await capture.component('ex-machine-workspace', c => c.store.selectSession({ taskId: '11', sessionId: '102' }));
  const edit = '[data-preset-edit]';
  const composer = 'ex-composer textarea';
  const card = id => `[data-flip="${id}"] ex-preset-card button`;
  const allCards = '.adaptive [data-flip]';
  const settle = async () => {
    await capture.settle();
    await capture.waitFor(() => document.getAnimations().every(animation =>
      !Number.isFinite(animation.effect?.getComputedTiming().endTime) || animation.playState !== 'running'));
  };
  const composerFits = () => capture.evaluate(selector => {
    const editor = document.querySelector(selector).getBoundingClientRect();
    const chat = document.querySelector('ex-session-chat').getBoundingClientRect();
    return editor.top >= chat.top && editor.bottom <= chat.bottom;
  }, composer);
  await capture.waitFor(() => !!document.querySelector('[data-preset-edit]:enabled'));
  await capture.viewport(1440, 900);
  await capture.theme('light');
  await capture.fill(composer, 'Keep this draft while editing presets');
  assert.equal(await capture.evaluate(selector => Array.from(document.querySelectorAll(selector)).at(-1)?.dataset.flip, allCards), 'custom');
  assert.equal(await capture.evaluate(() => document.querySelector('[data-flip="custom"]').parentElement.classList.contains('slim-grid')), true);
  await settle();
  yield { name: 'light-start', inspect: ['.start', 'ex-preset-picker', composer] };

  await capture.hover(card('deep'));
  await capture.click('[data-flip="deep"] ex-icon-button button');
  await capture.waitFor(() => document.activeElement?.matches('.preset-creator input'));
  assert.equal(await capture.evaluate(() => document.querySelector('.preset-creator input').value), 'Deep work');
  await settle();
  yield { name: 'light-existing-editor', inspect: ['.preset-creator', '[aria-busy]'] };
  await capture.fill('.preset-creator input', 'Focused work');
  await capture.click('.preset-creator button[type=submit]');
  await capture.waitFor(() => !document.querySelector('.preset-creator'));
  await capture.waitFor(() => document.activeElement === document.querySelector('[data-flip="deep"] ex-preset-card button'));
  assert.equal(await capture.evaluate(() => document.querySelector('[data-flip="deep"] .label').textContent.trim()), 'Focused work');
  assert.equal(await capture.component('ex-session-chat', component => component.store.state().reasoning), 'high');
  assert.equal(await capture.evaluate(() => !!document.querySelector('[data-flip="custom"]')), false);

  await capture.click(card('deep'));
  await capture.waitFor(() => !!document.querySelector('.preset-creator [aria-label="Thinking level"] button[aria-label="Med"]:enabled'));
  await capture.click('.preset-creator [aria-label="Thinking level"] button[aria-label="Med"]');
  await capture.click('.preset-creator button[type=submit]');
  await capture.waitFor(() => !document.querySelector('.preset-creator'));
  assert.equal(await capture.component('ex-session-chat', component => component.store.state().reasoning), 'medium');

  await capture.evaluate(selector => document.querySelector(selector).focus(), card('review-4'));
  await capture.press('ArrowLeft', 1);
  await capture.waitFor(() => !!document.querySelector('.full [data-flip="review-4"]'));
  await capture.waitFor(() => document.activeElement === document.querySelector('[data-flip="review-4"] ex-preset-card button'));
  await capture.press('Delete');
  await capture.waitFor(() => !document.querySelector('[data-flip="review-4"]'));
  await capture.settle();
  yield { name: 'light-edit-and-undo', inspect: ['.preset-heading', 'ex-preset-picker', 'ex-toast'] };
  await capture.click('.preset-toast ex-toast > button');
  await capture.waitFor(() => !!document.querySelector('.full [data-flip="review-4"]'));
  await capture.click('[data-flip="deep"] ex-icon-button button');
  await capture.waitFor(() => document.querySelector('.preset-toast ex-toast')?.textContent.includes('Default is now'));
  assert.equal(await capture.component('ex-session-chat', component => component.store.state().presetDefault.id), 'quick');
  await capture.click('.preset-toast ex-toast > button');
  await capture.waitFor(() => !!document.querySelector('.full [data-flip="deep"]'));
  assert.equal(await capture.component('ex-session-chat', component => component.store.state().presetDefault.id), 'deep');
  await capture.click(edit);

  await capture.click(card('deep'));
  await capture.component('ex-session-chat', component => component.agentChanged({ ...component.agent(), thinking: 'low' }));
  await capture.waitFor(() => document.querySelector('.preset-change del')?.textContent === 'medium');
  await settle();
  yield { name: 'light-changed-for-this-chat', inspect: ['.preset-change', 'ex-agent-picker', composer] };
  await capture.click('.preset-change button:last-child');
  await capture.waitFor(() => document.querySelector('.preset-result')?.textContent.includes('updated'));
  assert.equal(await capture.component('ex-session-chat', component => component.store.state().presets.find(preset => preset.id === 'deep').reasoning), 'low');
  await capture.component('ex-session-chat', component => component.agentChanged({ ...component.agent(), thinking: 'medium' }));
  await capture.waitFor(() => document.querySelector('.preset-change del')?.textContent === 'low');
  await settle();
  await capture.click('.preset-change-actions button:nth-child(2)');
  await capture.waitFor(() => document.activeElement?.matches('.preset-change input'));
  await capture.fill('.preset-change input', 'Focused variant');
  await capture.press('Enter');
  await capture.waitFor(() => document.querySelector('.preset-result')?.textContent.includes('Focused variant'));
  assert.equal(await capture.component('ex-session-chat', component => component.store.state().presets.find(preset => preset.id === 'deep').reasoning), 'low');
  assert.equal(await capture.evaluate(selector => document.querySelector(selector).value, composer), 'Keep this draft while editing presets');

  await capture.waitFor(() => !document.querySelector('.preset-grid-section ex-fold.open'));
  await capture.theme('dark');
  await capture.viewport(1050, 700);
  await capture.reducedMotion(true);
  await catalog('full');
  await capture.waitFor(() => document.querySelectorAll('.adaptive [data-flip]').length === 25);
  assert.equal(await capture.evaluate(() => getComputedStyle(document.querySelector('[data-flip="custom"]')).display), 'none');
  assert.ok(await composerFits(), 'The composer must fit with a full preset catalog');
  await settle();
  yield { name: 'dark-narrow-full-catalog', inspect: ['.start', 'ex-preset-picker', composer] };
  await capture.click(edit);
  assert.equal(await capture.evaluate(() => document.querySelectorAll('.adaptive [data-flip]').length), 24);
  assert.equal(await capture.evaluate(() => document.querySelector('.preset-heading button:first-of-type').disabled), true);
  assert.ok(await composerFits(), 'The composer must fit while editing a full preset catalog');
  await settle();
  yield { name: 'dark-narrow-editing', inspect: ['.start', 'ex-preset-picker', composer] };
}
