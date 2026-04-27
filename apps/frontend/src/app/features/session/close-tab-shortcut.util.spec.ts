import { describe, expect, it } from 'vitest';
import { shouldCloseActiveSessionTab } from './close-tab-shortcut.util';

describe('shouldCloseActiveSessionTab', () => {
  it('matches Cmd+W on macOS', () => {
    expect(shouldCloseActiveSessionTab({
      key: 'w',
      ctrlKey: false,
      metaKey: true,
      altKey: false,
      shiftKey: false,
    }, 'MacIntel')).toBe(true);
  });

  it('matches Ctrl+W on Windows', () => {
    expect(shouldCloseActiveSessionTab({
      key: 'w',
      ctrlKey: true,
      metaKey: false,
      altKey: false,
      shiftKey: false,
    }, 'Win32')).toBe(true);
  });

  it('does not match Ctrl+W on non-Windows platforms', () => {
    expect(shouldCloseActiveSessionTab({
      key: 'w',
      ctrlKey: true,
      metaKey: false,
      altKey: false,
      shiftKey: false,
    }, 'Linux x86_64')).toBe(false);
  });

  it('does not match when Shift is also pressed', () => {
    expect(shouldCloseActiveSessionTab({
      key: 'w',
      ctrlKey: false,
      metaKey: true,
      altKey: false,
      shiftKey: true,
    }, 'MacIntel')).toBe(false);
  });

  it('does not match other key combinations', () => {
    expect(shouldCloseActiveSessionTab({
      key: 'Tab',
      ctrlKey: true,
      metaKey: false,
      altKey: false,
      shiftKey: false,
    }, 'Win32')).toBe(false);
  });
});
