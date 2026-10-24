import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { jumpHome, settleMark } from './project-launch';

describe('Project launch ownership', () => {
  const originalAnimate = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'animate');
  beforeEach(() => vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined })));
  afterEach(() => {
    if (originalAnimate) Object.defineProperty(HTMLElement.prototype, 'animate', originalAnimate);
    else Reflect.deleteProperty(HTMLElement.prototype, 'animate');
    document.body.replaceChildren();
  });
  function elements(): { root: HTMLElement; from: HTMLElement; to: HTMLElement } {
    const root = document.createElement('div');
    const from = document.createElement('span');
    const to = document.createElement('span');
    root.append(from, to); document.body.append(root);
    Object.defineProperties(from, { offsetWidth: { value: 52 }, offsetHeight: { value: 52 }, offsetLeft: { value: 400 }, offsetTop: { value: 200 } });
    Object.defineProperties(to, { offsetWidth: { value: 36 }, offsetHeight: { value: 36 }, offsetLeft: { value: 20 }, offsetTop: { value: 70 } });
    return { root, from, to };
  }
  it('restores the destination synchronously when a flight is interrupted', () => {
    const animations: Animation[] = [];
    Object.defineProperty(HTMLElement.prototype, 'animate', { configurable: true, value: () => {
      // JSDOM has no WAAPI: model only cancellation/completion consumed by the helper.
      const animation = { cancel: vi.fn(), onfinish: null, oncancel: null } as unknown as Animation;
      animations.push(animation); return animation;
    } });
    const { root, from, to } = elements();
    const landed = vi.fn();
    const first = jumpHome(root, from, to, { landed });
    expect(to.style.opacity).toBe('0');
    expect(root.children).toHaveLength(3);
    first?.cancel();
    expect(to.style.opacity).toBe('');
    expect(root.children).toHaveLength(2);
    expect(landed).not.toHaveBeenCalled();
    const next = jumpHome(root, from, to, { landed });
    expect(to.style.opacity).toBe('0');
    next?.onfinish?.(new Event('finish') as AnimationPlaybackEvent);
    expect(to.style.opacity).toBe('');
    expect(root.children).toHaveLength(2);
    expect(landed).toHaveBeenCalledOnce();
    expect(animations).toHaveLength(4);
  });
  it('skips travel, creates no copies and lands once under reduced motion', () => {
    vi.stubGlobal('matchMedia', () => ({ matches: true }));
    const { root, from, to } = elements();
    const landed = vi.fn();
    expect(jumpHome(root, from, to, { landed })).toBeNull();
    expect(landed).toHaveBeenCalledWith(to);
    expect(root.children).toHaveLength(2);
    expect(settleMark(root, to)).toBeTypeOf('function');
  });
});
