import { Subject } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ZardDialogRef } from './dialog-ref';

describe('Dialog dismissal', () => {
  afterEach(() => vi.useRealTimers());
  const create = (cancel: () => false | void) => {
    const overlay = {
      dispose: vi.fn(),
      hasAttached: () => false,
      outsidePointerEvents: () => new Subject(),
    };
    const container = {
      cancelTriggered: new Subject(),
      okTriggered: new Subject(),
      getNativeElement: () => document.createElement('div'),
    };
    const ref = new ZardDialogRef(
      overlay as never,
      { zMaskClosable: false, zOnCancel: cancel },
      container as never,
      'browser' as unknown as object,
    );
    return { ref, overlay };
  };
  it('keeps a busy dialog open when Escape is pressed', () => {
    vi.useFakeTimers();
    const cancel = vi.fn(() => false as const);
    const { ref, overlay } = create(cancel);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }));
    vi.runAllTimers();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(overlay.dispose).not.toHaveBeenCalled();
    ref.close();
    vi.runAllTimers();
  });
  it('lets an inner branch picker consume Escape before the dialog closes', () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    const { ref } = create(cancel);
    const event = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true });
    event.preventDefault();
    document.dispatchEvent(event);
    expect(cancel).not.toHaveBeenCalled();
    ref.close();
    vi.runAllTimers();
  });
});
