import type { TaskAppInput } from '@elevenex/shared';
import type { AppDisplaySize } from './app-display-size.js';

// DOM physical codes translated to the evdev XKB keycodes on our own Xvfb.
const physicalKeys: Record<string, number> = {
  Escape: 9,
  Minus: 20,
  Equal: 21,
  Backspace: 22,
  Tab: 23,
  BracketLeft: 34,
  BracketRight: 35,
  Enter: 36,
  ControlLeft: 37,
  Semicolon: 47,
  Quote: 48,
  Backquote: 49,
  ShiftLeft: 50,
  Backslash: 51,
  Comma: 59,
  Period: 60,
  Slash: 61,
  ShiftRight: 62,
  NumpadMultiply: 63,
  AltLeft: 64,
  Space: 65,
  CapsLock: 66,
  NumLock: 77,
  ScrollLock: 78,
  Numpad7: 79,
  Numpad8: 80,
  Numpad9: 81,
  NumpadSubtract: 82,
  Numpad4: 83,
  Numpad5: 84,
  Numpad6: 85,
  NumpadAdd: 86,
  Numpad1: 87,
  Numpad2: 88,
  Numpad3: 89,
  Numpad0: 90,
  NumpadDecimal: 91,
  IntlBackslash: 94,
  F11: 95,
  F12: 96,
  NumpadEnter: 104,
  ControlRight: 105,
  NumpadDivide: 106,
  PrintScreen: 107,
  AltRight: 108,
  Home: 110,
  ArrowUp: 111,
  PageUp: 112,
  ArrowLeft: 113,
  ArrowRight: 114,
  End: 115,
  ArrowDown: 116,
  PageDown: 117,
  Insert: 118,
  Delete: 119,
  Pause: 127,
  MetaLeft: 133,
  MetaRight: 134,
  ContextMenu: 135,
};
for (const [letters, start] of [
  ['QWERTYUIOP', 24],
  ['ASDFGHJKL', 38],
  ['ZXCVBNM', 52],
] as const)
  [...letters].forEach((letter, offset) => {
    physicalKeys['Key' + letter] = start + offset;
  });
for (let i = 1; i <= 10; i++) {
  physicalKeys['Digit' + (i % 10)] = 9 + i;
  physicalKeys['F' + i] = 66 + i;
}

export function hostInput(event: TaskAppInput, size: AppDisplaySize): object {
  if (event.kind === 'key') {
    const keycode =
      Object.hasOwn(physicalKeys, event.code) && physicalKeys[event.code];
    if (!keycode || typeof event.down !== 'boolean')
      throw new Error('Unsupported app key');
    return { kind: 'key', keycode, down: event.down };
  }
  if (event.kind === 'text') {
    if (
      typeof event.text !== 'string' ||
      !event.text.length ||
      event.text.length > 256
    )
      throw new Error('Invalid committed app text');
    return { kind: 'text', text: event.text };
  }
  if (
    !Number.isInteger(event.x) ||
    !Number.isInteger(event.y) ||
    event.x < 0 ||
    event.y < 0 ||
    event.x >= size.width ||
    event.y >= size.height
  )
    throw new Error('Pointer is outside the app display');
  const point = { kind: event.kind, x: event.x, y: event.y };
  if (event.kind === 'move') return point;
  if (event.kind === 'wheel') {
    if (!Number.isFinite(event.deltaX) || !Number.isFinite(event.deltaY))
      throw new Error('Invalid scroll');
    return { ...point, deltaX: event.deltaX, deltaY: event.deltaY };
  }
  if (
    (event.kind !== 'down' && event.kind !== 'up') ||
    !Number.isInteger(event.button ?? 0) ||
    (event.button ?? 0) < 0 ||
    (event.button ?? 0) > 2
  )
    throw new Error('Unsupported mouse button');
  return { ...point, button: event.button ?? 0 };
}
