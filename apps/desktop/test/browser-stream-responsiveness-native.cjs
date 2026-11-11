const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');

/** Real production stream input must reach the compositor before page JS yields. */
module.exports = async function streamResponsiveness(contents, send) {
  const binding = '__busy_' + randomUUID().replaceAll('-', '');
  const originalHeight = await contents.executeJavaScript(`(() => {
    const height = document.body.style.height;
    document.body.style.height = '3000px'; scrollTo(0, 0);
    return new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(height))));
  })()`);
  let begin, firstScroll, start;
  const began = new Promise(resolve => { begin = resolve; });
  const debuggerApi = contents.debugger;
  const receive = (_event, method, params) => {
    if (method === 'Runtime.bindingCalled' && params.name === binding) { start = performance.now(); begin(); }
    if (method === 'Page.screencastFrame' && start !== undefined && params.metadata.scrollOffsetY > 0)
      firstScroll ??= performance.now() - start;
  };
  debuggerApi.on('message', receive);
  let finished;
  try {
    await debuggerApi.sendCommand('Runtime.enable');
    await debuggerApi.sendCommand('Runtime.addBinding', { name: binding });
    finished = debuggerApi.sendCommand('Runtime.evaluate', { expression: `${binding}(''); (() => { const end = performance.now() + 1800; while (performance.now() < end) {} })()` });
    await began;
    await send({ kind: 'wheel', x: 300, y: 300, deltaX: 0, deltaY: 120, modifiers: 0 });
    while (firstScroll === undefined && performance.now() - start < 1200) await delay(10);
    assert.ok(firstScroll !== undefined && firstScroll < 1200, 'Streamed wheel waited for page JavaScript instead of reaching the compositor');
  } finally {
    await finished;
    debuggerApi.removeListener('message', receive);
    await debuggerApi.sendCommand('Runtime.removeBinding', { name: binding });
    await contents.executeJavaScript(`document.body.style.height = ${JSON.stringify(originalHeight)}; scrollTo(0, 0)`);
  }
};
