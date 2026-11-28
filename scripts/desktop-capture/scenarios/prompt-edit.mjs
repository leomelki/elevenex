import assert from 'node:assert/strict';

const message = '[data-user-message="edit-target"]';
const trigger = `${message} button[aria-label="Edit message"]`;
const dialog = '[role="dialog"][aria-labelledby="session-prompt-edit-title"]';
const textbox = `${dialog} textarea`;
const send = `${dialog} button[data-variant="primary"]`;
const composer = 'ex-composer textarea';
const revised = 'Add coverage for three concurrent retries and a failed first claim.';

export default async function* (capture) {
  await capture.evaluate(() => { location.href = '/connected-workspace'; });
  await capture.waitFor(() => document.querySelector('ex-workspace-navigation ex-task-list'));
  await capture.component('ex-connected-workspace-demo', component => component.fixture.chat.promptEditingScene());
  await capture.component('ex-machine-workspace', component => component.store.selectSession({ taskId: '11', sessionId: '101' }));
  await capture.theme('light');
  await capture.waitFor(selector => document.querySelector(selector), trigger);
  await capture.fill(composer, 'Keep this independent composer draft.');
  await capture.evaluate(selector => document.querySelector(selector).scrollIntoView({ block: 'center' }), message);
  await capture.hover(message);
  yield { name: 'edit-action', inspect: [message, trigger] };
  await capture.click(trigger);
  await capture.waitFor(selector => document.activeElement === document.querySelector(selector), textbox);
  await capture.waitFor(selector => document.querySelector(selector)?.disabled, send);
  assert.match(await capture.evaluate(selector => document.querySelector(selector).innerText, dialog), /replaces the original message and its reply.*removes one later message/s);
  yield { name: 'light', inspect: [dialog, textbox, send] };

  const height = () => capture.evaluate(selector => document.querySelector(selector).offsetHeight, textbox);
  const compact = await height();
  await capture.fill(textbox, Array.from({ length: 10 }, (_, index) => `Retry scenario ${index + 1}`).join('\n'));
  await capture.waitFor(selector => document.querySelector(selector).getAnimations().some(animation =>
    animation.effect.getKeyframes().some(frame => frame.height !== undefined)), dialog);
  yield { name: 'growing-draft', inspect: [dialog, textbox, send] };
  assert.ok(await height() > compact);
  await capture.fill(textbox, Array.from({ length: 35 }, (_, index) => `Retry scenario ${index + 1}`).join('\n'));
  assert.ok(await capture.evaluate(selector => {
    const field = document.querySelector(selector);
    return field.scrollHeight > field.clientHeight && document.activeElement === field;
  }, textbox));

  await capture.fill(textbox, 'This cancelled edit must never be sent.');
  await capture.waitFor((selector, compactHeight) =>
    document.querySelector(selector).offsetHeight === compactHeight, textbox, compact);
  await capture.press('Escape');
  await capture.waitFor(selector => document.activeElement === document.querySelector(selector), trigger);
  assert.match(await capture.evaluate(selector => document.querySelector(selector).textContent, message), /two concurrent retry requests/);
  assert.equal(await capture.component('ex-connected-workspace-demo', component =>
    component.fixture.sentChatActions.filter(request => request.action.type === 'edit-prompt').length), 0);

  await capture.reducedMotion(true);
  await capture.theme('dark');
  await capture.viewport(640, 700);
  await capture.evaluate(selector => document.querySelector(selector).focus(), message);
  await capture.press('e');
  await capture.waitFor(selector => document.activeElement === document.querySelector(selector), textbox);
  await capture.fill(textbox, 'Preserve this draft if the conversation changes.');
  await capture.component('ex-connected-workspace-demo', component => component.fixture.chat.promptEditingScene());
  await capture.click(send);
  await capture.waitFor(selector => document.querySelector(selector)?.textContent?.includes('The conversation changed'), `${dialog} [role="alert"]`);
  assert.equal(await capture.evaluate(selector => document.querySelector(selector).value, textbox), 'Preserve this draft if the conversation changes.');
  yield { name: 'dark-narrow-conflict', inspect: [dialog, textbox, `${dialog} [role="alert"]`] };

  await capture.click(send);
  await capture.waitFor(selector => document.activeElement === document.querySelector(selector), textbox);
  await capture.waitFor(selector => document.querySelector(selector)?.textContent.includes('Edit & resend'), send);
  assert.equal(await capture.evaluate(selector => document.querySelector(selector).value, textbox), 'Preserve this draft if the conversation changes.');
  await capture.fill(textbox, revised);
  assert.equal(await capture.evaluate(selector => document.querySelector(selector).getAnimations().some(animation =>
    animation.effect.getKeyframes().some(frame => frame.height !== undefined)), dialog), false);
  yield { name: 'dark-narrow', inspect: [dialog, textbox, send] };
  await capture.press('Enter', 2);
  await capture.waitFor(text => [...document.querySelectorAll('[data-user-message]')].some(node => node.textContent.includes(text)), revised);
  await capture.waitFor(selector => !document.querySelector(selector), dialog);
  assert.equal(await capture.evaluate(selector => document.querySelector(selector).value, composer), 'Keep this independent composer draft.');
  assert.equal(await capture.evaluate(() => !!document.querySelector('[data-user-message="edit-later"]')), false);
  assert.equal(await capture.evaluate(selector => document.activeElement === document.querySelector(selector), composer), true);
  yield { name: 'revised-conversation', inspect: [composer, '[data-user-message^="revised-"]'] };

  await capture.component('ex-connected-workspace-demo', component => component.fixture.chat.promptEditingScene(true));
  await capture.waitFor(selector => document.querySelector(selector)?.disabled, trigger);
  await capture.evaluate(selector => document.querySelector(selector).scrollIntoView({ block: 'center' }), message);
  await capture.hover(message);
  yield { name: 'running-edit-unavailable', inspect: [message, trigger] };
}
