import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { animateMessageSend } from './message-send-animation';

interface MockAnimation {
  cancel: ReturnType<typeof vi.fn>;
  onfinish: (() => void) | null;
  oncancel: (() => void) | null;
}
describe('message send ownership', () => {
  let reduced = false;
  const effects: MockAnimation[] = [];
  const animate = vi.fn<(...args: Parameters<HTMLElement["animate"]>) => MockAnimation>(() => {
    const effect = { cancel: vi.fn(), onfinish: null, oncancel: null };
    effects.push(effect);
    return effect;
  });
  beforeEach(() => {
    reduced = false;
    effects.length = 0;
    animate.mockClear();
    vi.stubGlobal('matchMedia', () => ({ matches: reduced }));
    vi.stubGlobal('getComputedStyle', () => ({
      getPropertyValue: () => 'ease-out', font: '14px sans-serif',
      backgroundColor: 'white', borderColor: 'gray', boxShadow: 'none',
    }));
    Object.defineProperty(HTMLElement.prototype, 'animate', { configurable: true, writable: true, value: animate });
  });
  afterEach(() => {
    Reflect.deleteProperty(HTMLElement.prototype, "animate");
    vi.restoreAllMocks(); vi.unstubAllGlobals();
    document.body.replaceChildren();
  });
  function message(height = 40): HTMLElement {
    const node = document.createElement('ex-message');
    node.id = 'prompt'; node.className = 'user fresh'; node.tabIndex = 0;
    node.dataset['userMessage'] = 'prompt';
    node.innerHTML = '<div class="content" id="words">Send these words</div>';
    Object.defineProperty(node, 'offsetHeight', { value: height });
    document.body.append(node);
    return node;
  }
  it('keeps one inert copy with the same words and restores the bubble on finish or teardown', () => {
    const node = message();
    const cleanup = animateMessageSend(node, { left: 20, top: 300, at: performance.now() });
    const copy = document.querySelector<HTMLElement>('.send-flight')!;
    expect(copy.textContent).toBe(node.textContent);
    expect(copy.getAttribute('aria-hidden')).toBe('true');
    expect(copy.inert).toBe(true);
    expect(copy.querySelector('[id]')).toBeNull();
    expect(document.querySelectorAll('#prompt')).toHaveLength(1);
    expect(node.style.visibility).toBe('hidden');
    effects[0]?.onfinish?.();
    expect(node.style.visibility).toBe('');
    expect(copy.isConnected).toBe(false);
    cleanup();
    for (const effect of effects) expect(effect.cancel).toHaveBeenCalledOnce();
    const cancel = animateMessageSend(node, { left: 20, top: 300, at: performance.now() });
    cancel();
    expect(document.querySelector('.send-flight')).toBeNull();
    expect(node.style.visibility).toBe('');
  });
  it('uses a rise without an origin, for expired origins and for tall messages', () => {
    for (const [height, at] of [[40, undefined], [40, performance.now() - 1000], [200, performance.now()]] as const) {
      const node = message(height);
      const cleanup = animateMessageSend(node, at === undefined ? undefined : { left: 20, top: 300, at });
      expect(document.querySelector('.send-flight')).toBeNull();
      expect(node.style.visibility).toBe('');
      expect(animate.mock.lastCall?.[0]).toEqual([
        { opacity: 0, transform: 'translateY(14px) scale(.96)' }, { opacity: 1, transform: 'none' },
      ]);
      cleanup(); node.remove();
    }
  });
  it('fades without movement for reduced motion, even with a fresh origin', () => {
    reduced = true;
    const cleanup = animateMessageSend(message(), { left: 20, top: 300, at: performance.now() });
    expect(animate).toHaveBeenCalledWith([{ opacity: 0 }, { opacity: 1 }], expect.objectContaining({ duration: 160 }));
    expect(document.querySelector('.send-flight')).toBeNull();
    cleanup();
  });
});
