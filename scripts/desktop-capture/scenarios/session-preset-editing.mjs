import assert from 'node:assert/strict';

async function dragGrip(capture, sourceSelector, targetSelector, targetId) {
  const [source, target] = await capture.evaluate((sourceSelector, targetSelector) =>
    [sourceSelector, targetSelector].map(selector => {
      const rect = document.querySelector(selector).getBoundingClientRect();
      return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) };
    }), sourceSelector, targetSelector);
  await capture.cdp('Input.setInterceptDrags', { enabled: true });
  const client = capture.window.webContents.debugger;
  let dragData;
  const onDrag = (_event, method, args) => {
    if (method === 'Input.dragIntercepted') dragData = args.data;
  };
  client.on('message', onDrag);
  try {
    await capture.cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', ...source });
    await capture.cdp('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', buttons: 1, clickCount: 1, ...source });
    await capture.cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', button: 'left', buttons: 1, x: source.x + 12, y: source.y - 6 });
    for (let frame = 0; frame < 5 && !dragData; frame++) await capture.settle();
    assert.ok(dragData, 'The visible grip must start a native Chromium drag');
    for (const type of ['dragEnter', 'dragOver']) {
      await capture.cdp('Input.dispatchDragEvent', { type, ...target, data: dragData });
    }
    await capture.waitFor(id => document.querySelector('.drop-target')?.dataset.flip === id, targetId);
    await capture.cdp('Input.dispatchDragEvent', { type: 'drop', ...target, data: dragData });
  } finally {
    client.removeListener('message', onDrag);
    await capture.cdp('Input.setInterceptDrags', { enabled: false });
  }
}

export default async function* (capture) {
  await capture.evaluate(() => { location.href = '/connected-workspace'; });
  await capture.waitFor(() => !!document.querySelector('ex-workspace-navigation ex-task-list'));
  const catalog = mode => capture.component('ex-connected-workspace-demo', (c, mode) => c.fixture.chat.presetCatalog(mode), mode);
  await catalog('editing');
  await capture.component('ex-machine-workspace', c => c.store.selectSession({ taskId: '11', sessionId: '102' }));
  const edit = '[data-preset-edit]';
  const composer = 'ex-composer textarea';
  const tile = id => `[data-flip="${id}"]`;
  const card = id => `[data-flip="${id}"] ex-preset-card button`;
  const pencil = id => `${tile(id)} button.tile-action.edit`;
  const remove = id => `${tile(id)} button.tile-action.remove`;
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
  const headingButtons = () => capture.evaluate(() => [...document.querySelectorAll('.preset-heading > button')].map(button => button.textContent.trim()));
  assert.deepEqual(await headingButtons(), ['Edit', 'New preset']);
  assert.equal(await capture.evaluate(() => document.querySelectorAll('.grip').length), 0);
  assert.equal(await capture.evaluate(selector => Array.from(document.querySelectorAll(selector)).at(-1)?.dataset.flip, allCards), 'custom');
  assert.equal(await capture.evaluate(() => document.querySelector('[data-flip="custom"]').parentElement.classList.contains('slim-grid')), true);
  await settle();
  yield { name: 'light-start', inspect: ['.start', 'ex-preset-picker', composer] };

  await capture.hover(card('deep'));
  await capture.click(pencil('deep'));
  await capture.waitFor(() => document.activeElement?.matches('.preset-creator .identity input'));
  assert.equal(await capture.evaluate(() => document.querySelector('.preset-creator .identity input').value), 'Deep work');
  await settle();
  yield { name: 'light-existing-editor', inspect: ['.preset-creator', '[aria-busy]'] };
  await capture.fill('.preset-creator .identity input', 'Focused work');
  await capture.click('.preset-creator button[type=submit]');
  await capture.waitFor(() => !document.querySelector('.preset-creator'));
  await capture.waitFor(() => document.activeElement === document.querySelector('[data-flip="deep"] ex-preset-card button'));
  assert.equal(await capture.evaluate(() => document.querySelector('[data-flip="deep"] .label').textContent.trim()), 'Focused work');
  assert.equal(await capture.component('ex-session-chat', component => component.store.state().reasoning), 'high');
  assert.equal(await capture.evaluate(() => !!document.querySelector('[data-flip="custom"]')), false);
  assert.deepEqual(await headingButtons(), ['New preset', 'Done']);
  await capture.hover(edit);
  await settle();
  const affordances = await capture.evaluate(() => {
    const card = document.querySelector('.full .preset-tile');
    const cardBounds = card.getBoundingClientRect();
    const removeButton = card.querySelector('button.remove');
    const removeBounds = removeButton.getBoundingClientRect();
    const slim = document.querySelector('.slim-grid .preset-tile');
    return {
      done: document.querySelector('[data-preset-edit]').getAttribute('data-variant'),
      docked: document.querySelector('ex-composer').inert,
      gripCount: document.querySelectorAll('.preset-tile .grip').length,
      pencilCount: [...document.querySelectorAll('.preset-tile .edit')].filter(button => getComputedStyle(button).opacity === '1').length,
      defaultBadge: card.querySelector('.default')?.textContent.trim(),
      fullRemove: getComputedStyle(removeButton).opacity,
      upperLeft: removeBounds.left < cardBounds.left && removeBounds.top < cardBounds.top,
      slimRemove: getComputedStyle(slim.querySelector('button.remove')).opacity,
    };
  });
  assert.deepEqual(affordances, {
    done: 'primary', docked: true, gripCount: 8, pencilCount: 8,
    defaultBadge: 'Default', fullRemove: '1', upperLeft: true, slimRemove: '0',
  });
  yield { name: 'light-edit-mode', inspect: ['.preset-heading', 'ex-preset-picker', composer], metadata: { affordances } };
  await capture.hover(card('review-4'));
  await settle();
  assert.equal(await capture.evaluate(selector => getComputedStyle(document.querySelector(selector)).opacity, remove('review-4')), '1');
  assert.equal(await capture.evaluate(selector => getComputedStyle(document.querySelector(selector)).cursor, `${tile('review-4')} .grip`), 'grab');

  await capture.click('[data-preset-new]');
  await capture.waitFor(() => document.activeElement?.matches('.preset-creator .identity input'));
  assert.equal(await capture.evaluate(() => document.querySelector('.preset-creator .identity input').value), '');
  await capture.press('Escape');
  await capture.waitFor(() => !document.querySelector('.preset-creator'));
  assert.equal(await capture.evaluate(() => document.activeElement?.matches('[data-preset-new]')), true);
  assert.equal(await capture.evaluate(() => document.querySelector('[data-preset-edit]').getAttribute('aria-pressed')), 'true');

  await capture.click(card('deep'));
  await capture.waitFor(() => !!document.querySelector('.preset-creator input[type="range"]:enabled'));
  await capture.evaluate(() => document.querySelector('.preset-creator input[type="range"]').focus());
  await capture.press('Home');
  for (let step = 0; step < 8 && await capture.evaluate(() => document.querySelector('.preset-creator input[type="range"]').getAttribute('aria-valuetext')) !== 'Medium'; step++) await capture.press('ArrowRight');
  await capture.click('.preset-creator button[type=submit]');
  await capture.waitFor(() => !document.querySelector('.preset-creator'));
  assert.equal(await capture.component('ex-session-chat', component => component.store.state().reasoning), 'medium');

  await capture.evaluate(selector => document.querySelector(selector).focus(), card('review-4'));
  await capture.press('ArrowUp', 1);
  await capture.waitFor(() => !!document.querySelector('.full [data-flip="review-4"]'));
  await capture.waitFor(() => document.activeElement === document.querySelector('[data-flip="review-4"] ex-preset-card button'));
  await capture.press('Delete');
  await capture.waitFor(() => !document.querySelector('[data-flip="review-4"]'));
  await capture.settle();
  yield { name: 'light-edit-and-undo', inspect: ['.preset-heading', 'ex-preset-picker', 'ex-toast'] };
  await capture.click('.preset-toast ex-toast > button');
  await capture.waitFor(() => !!document.querySelector('.full [data-flip="review-4"]'));
  await capture.hover(edit);
  await settle();
  await dragGrip(capture, `${tile('review-5')} .grip`, card('review-4'), 'review-4');
  await capture.waitFor(() => !!document.querySelector('.full [data-flip="review-5"]'));
  await capture.waitFor(() => !!document.querySelector('.slim-grid [data-flip="review-4"]'));
  assert.equal(await capture.component('ex-session-chat', component => component.store.state().presets[5].id), 'review-5');
  await capture.click(remove('deep'));
  await capture.waitFor(() => document.querySelector('.preset-toast ex-toast')?.textContent.includes('Default is now'));
  assert.equal(await capture.component('ex-session-chat', component => component.store.state().presetDefault.id), 'quick');
  await capture.click('.preset-toast ex-toast > button');
  await capture.waitFor(() => !!document.querySelector('.full [data-flip="deep"]'));
  assert.equal(await capture.component('ex-session-chat', component => component.store.state().presetDefault.id), 'deep');
  await capture.evaluate(selector => document.querySelector(selector).focus(), card('deep'));
  await capture.press('Escape');
  await capture.waitFor(() => document.activeElement?.matches('[data-preset-edit][aria-pressed="false"]'));
  assert.equal(await capture.evaluate(() => document.querySelector('ex-composer').inert), false);

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
  assert.equal(await capture.evaluate(() => document.querySelector('[data-preset-new]').disabled), true);
  assert.equal(await capture.evaluate(() => document.querySelectorAll('.preset-tile .grip').length), 24);
  assert.equal(await capture.evaluate(() => document.querySelector('ex-composer').inert), true);
  assert.ok(await composerFits(), 'The composer must fit while editing a full preset catalog');
  await settle();
  yield { name: 'dark-narrow-editing', inspect: ['.start', 'ex-preset-picker', composer] };

  await capture.viewport(900, 640);
  await capture.evaluate(() => document.querySelector('.start').scrollTop = document.querySelector('.start').scrollHeight);
  await capture.waitFor(() => {
    const viewport = document.querySelector('.start').getBoundingClientRect();
    // The last slim row should be reachable while the composer stays docked.
    const last = document.querySelector('.slim-grid .preset-tile:last-child .grip')?.getBoundingClientRect();
    return !!last && last.top >= viewport.top && last.bottom <= viewport.bottom;
  });
  assert.ok(await composerFits(), 'The composer must stay docked while reaching the last slim row');
  await settle();
  yield { name: 'dark-short-last-slim-row', inspect: ['.start', '.slim-grid .preset-tile:last-child', composer] };
}
