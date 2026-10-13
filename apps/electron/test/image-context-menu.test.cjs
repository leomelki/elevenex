const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const { installImageContextMenu } = require('../image-context-menu.cjs');

function setup() {
  const contents = new EventEmitter();
  const copied = [];
  const menus = [];
  let destroyed = false;
  contents.isDestroyed = () => destroyed;
  contents.copyImageAt = (x, y) => copied.push({ x, y });
  const win = { webContents: contents };
  const Menu = {
    buildFromTemplate(items) {
      return { popup: (options) => menus.push({ items, options }) };
    },
  };
  installImageContextMenu(win, Menu);
  return { contents, win, menus, copied, destroy: () => { destroyed = true; } };
}

test('copies the right-clicked image in its owning window', () => {
  const { contents, win, menus, copied } = setup();
  contents.emit('context-menu', {}, {
    mediaType: 'image', hasImageContents: true, x: 123, y: 456,
  });
  assert.equal(menus.length, 1);
  assert.equal(menus[0].options.window, win);
  assert.equal(menus[0].items[0].label, 'Copy Image');
  assert.equal(menus[0].items[0].enabled, true);
  assert.deepEqual(copied, []);
  menus[0].items[0].click();
  assert.deepEqual(copied, [{ x: 123, y: 456 }]);
});

test('disables copying unavailable images and leaves other context menus alone', () => {
  const { contents, menus } = setup();
  for (const mediaType of ['none', 'video', 'audio', 'canvas']) {
    contents.emit('context-menu', {}, { mediaType });
  }
  assert.equal(menus.length, 0);
  contents.emit('context-menu', {}, { mediaType: 'image', hasImageContents: false });
  assert.equal(menus[0].items[0].enabled, false);
});

test('does not copy after the owning window is destroyed', () => {
  const { contents, menus, copied, destroy } = setup();
  contents.emit('context-menu', {}, {
    mediaType: 'image', hasImageContents: true, x: 10, y: 20,
  });
  destroy();
  menus[0].items[0].click();
  assert.deepEqual(copied, []);
});
