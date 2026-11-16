const { test } = require('node:test');
const assert = require('node:assert/strict');
const { nativePointerInput } = require('../dist/browser/native-pointer-input');

test('maps streamed CSS coordinates, wheel direction and zoom into native view input', () => {
  assert.deepEqual(nativePointerInput({ kind: 'wheel', x: 10, y: 20, deltaX: -5, deltaY: 80, modifiers: 2 }, 2), {
    type: 'mouseWheel', x: 20, y: 40, deltaX: 10, deltaY: -160, canScroll: true, modifiers: ['control'],
  });
});

test('preserves multi-button drag state, click count and modifier keys', () => {
  assert.deepEqual(nativePointerInput({ kind: 'pointer', type: 'move', x: 10.25, y: 20.25, button: 'left', buttons: 3, clicks: 0, modifiers: 13 }, 2), {
    type: 'mouseMove', x: 21, y: 41, button: 'left', clickCount: 0, modifiers: ['alt', 'meta', 'shift', 'leftbuttondown', 'rightbuttondown'],
  });
  assert.deepEqual(nativePointerInput({ kind: 'pointer', type: 'up', x: 10, y: 20, button: 'right', buttons: 0, clicks: 2, modifiers: 0 }, 1), {
    type: 'mouseUp', x: 10, y: 20, button: 'right', clickCount: 2, modifiers: [],
  });
});
