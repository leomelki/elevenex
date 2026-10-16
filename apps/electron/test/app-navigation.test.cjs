const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const { installAppNavigation } = require('../app-navigation.cjs');

for (const frontendTarget of [
  { kind: 'file', value: '/Applications/Elevenex/frontend/index.html' },
  { kind: 'url', value: 'http://localhost:4200/' },
]) {
  test(`keeps document links outside the ${frontendTarget.kind} application`, () => {
    const contents = new EventEmitter();
    const opened = [];
    contents.setWindowOpenHandler = (handler) => { contents.openWindow = handler; };
    installAppNavigation(contents, frontendTarget, async (url) => { opened.push(url); });
    const urls = [
      'file:///tmp/repo/README.md',
      'file:///sessions/921',
      'http://localhost:4200/sessions/921',
      'http://localhost:4200/not-a-route',
      'http://localhost:4200.evil.test/',
      'https://example.com/',
      'elevenex://sessions/921',
    ];
    for (const url of urls) {
      let prevented = false;
      contents.emit('will-navigate', { preventDefault: () => { prevented = true; } }, url);
      assert.equal(prevented, true, url);
      assert.equal(opened.at(-1), url);
      assert.deepEqual(contents.openWindow({ url }), { action: 'deny' });
    }
    let prevented = false;
    const entry = frontendTarget.kind === 'file'
      ? `file://${frontendTarget.value}` : frontendTarget.value;
    const count = opened.length;
    contents.emit('will-navigate', { preventDefault: () => { prevented = true; } }, `${entry}#/sessions/921`);
    assert.equal(prevented, false);
    assert.equal(opened.length, count);
  });
}
