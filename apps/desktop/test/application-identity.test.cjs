const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFile } = require('node:fs/promises');
const { dirname, join } = require('node:path');
const vm = require('node:vm');

for (const platform of ['darwin', 'win32', 'linux']) {
  test(`${platform} identity supplies tray actions and releases native resources`, async () => {
    const calls = [];
    let menu;
    let click;
    let imagePath;
    const image = { isEmpty: () => false, setTemplateImage: value => calls.push(['template', value]) };
    class Tray {
      constructor(value) { assert.equal(value, image); }
      setToolTip(value) { calls.push(['tooltip', value]); }
      setContextMenu(value) { menu = value; }
      on(event, fn) { assert.equal(event, 'click'); click = fn; }
      removeAllListeners() { calls.push(['removeListeners']); }
      destroy() { calls.push(['destroy']); }
    }
    const file = require.resolve('../dist/application-identity');
    const exports = {};
    vm.runInNewContext(await readFile(file, 'utf8'), {
      exports, __dirname: dirname(file), process: { platform },
      require: name => name === 'node:path' ? { join } : {
        Tray,
        app: { isPackaged: false, setAppUserModelId: value => calls.push(['appId', value]),
          dock: { setIcon: value => calls.push(['dock', value]) }, quit: () => calls.push(['quit']) },
        Menu: { buildFromTemplate: value => value },
        nativeImage: { createFromPath: value => { imagePath = value; return image; } },
      },
    });
    const dispose = exports.installApplicationIdentity(() => calls.push(['show']), () => calls.push(['new']));
    assert.ok(imagePath.endsWith(platform === 'darwin' ? 'trayTemplate.png' : 'tray.png'));
    assert.ok(calls.some(call => call[0] === 'template' && call[1] === (platform === 'darwin')));
    assert.equal(calls.some(call => call[0] === 'dock'), platform === 'darwin');
    menu.find(item => item.label === 'Show Elevenex').click();
    menu.find(item => item.label === 'New Window').click();
    click();
    menu.find(item => item.label === 'Quit Elevenex').click();
    assert.deepEqual(calls.slice(-4), [['show'], ['new'], ['show'], ['quit']]);
    dispose();
    assert.deepEqual(calls.slice(-2), [['removeListeners'], ['destroy']]);
  });
}
