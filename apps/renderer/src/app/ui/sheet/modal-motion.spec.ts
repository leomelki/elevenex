import { ModalMotion } from './modal-motion';
import { measureModalOrigin } from './modal-morph';

class ControlledEffect {
  readonly setKeyframes = vi.fn((frames: Keyframe[]) => { this.animation.frames = frames; });
  constructor(private readonly animation: ControlledAnimation) {}
  getComputedTiming() { return { progress: this.animation.progress }; }
}

class ControlledAnimation {
  progress = 0;
  private resolve!: () => void;
  private reject!: () => void;
  readonly finished = new Promise<void>((resolve, reject) => { this.resolve = resolve; this.reject = reject; });
  readonly effect = new ControlledEffect(this);
  readonly finish = vi.fn(() => { this.progress = 1; this.resolve(); });
  readonly cancel = vi.fn(() => this.reject());
  constructor(readonly target: HTMLElement, public frames: Keyframe[], readonly options: KeyframeAnimationOptions) {}
}

describe('modal motion ownership', () => {
  const animations: ControlledAnimation[] = [];
  let changed: (() => void) | undefined;
  let motion: ModalMotion | undefined;
  const media = { matches: false, addEventListener: (_name: string, listener: () => void) => { changed = listener; }, removeEventListener: vi.fn() };
  const animateDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'animate');
  const hitDescriptor = Object.getOwnPropertyDescriptor(document, 'elementsFromPoint');
  let root: HTMLElement;

  beforeEach(() => {
    media.matches = false; animations.length = 0;
    vi.stubGlobal('matchMedia', () => media);
    vi.stubGlobal('KeyframeEffect', ControlledEffect);
    Object.defineProperty(HTMLElement.prototype, 'animate', { configurable: true, value: function (this: HTMLElement, frames: Keyframe[], options: KeyframeAnimationOptions) {
      const animation = new ControlledAnimation(this, frames, options); animations.push(animation); return animation;
    } });
    root = document.createElement('div'); root.setAttribute('data-modal-window', ''); document.body.append(root);
  });
  afterEach(() => {
    motion?.dispose(); motion = undefined; root.remove();
    if (animateDescriptor) Object.defineProperty(HTMLElement.prototype, 'animate', animateDescriptor);
    else Reflect.deleteProperty(HTMLElement.prototype, 'animate');
    if (hitDescriptor) Object.defineProperty(document, 'elementsFromPoint', hitDescriptor);
    else Reflect.deleteProperty(document, 'elementsFromPoint');
    vi.unstubAllGlobals();
  });

  function setup(visibility = '', options?: ConstructorParameters<typeof ModalMotion>[2]) {
    const layer = document.createElement('div'), surface = document.createElement('section'), trigger = document.createElement('button');
    trigger.id = 'origin'; trigger.innerHTML = '<span id="origin-label">Server</span>';
    trigger.style.visibility = visibility;
    surface.innerHTML = '<input aria-label="Host" />'; surface.style.transformOrigin = '10px 20px';
    layer.append(surface); root.append(trigger, layer);
    for (const [element, width, height] of [[layer, 1440, 960], [surface, 460, 330], [trigger, 170, 128]] as const) {
      Object.defineProperty(element, 'offsetWidth', { configurable: true, value: width }); Object.defineProperty(element, 'offsetHeight', { configurable: true, value: height });
    }
    vi.spyOn(layer, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 1440, 960));
    vi.spyOn(trigger, 'getBoundingClientRect').mockReturnValue(new DOMRect(540, 560, 170, 128));
    motion = new ModalMotion(layer, trigger, options);
    return { layer, surface, trigger };
  }
  async function finish() { animations.forEach(animation => animation.finish()); await Promise.resolve(); await Promise.resolve(); }

  it('fits an anchored popover to arriving content without restarting entry and releases its observer', async () => {
    let resized!: () => void;
    const disconnect = vi.fn();
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback: () => void) { resized = callback; }
      observe = vi.fn();
      disconnect = disconnect;
    });
    const { layer, surface, trigger } = setup('', { noFace: true, fadeIn: .3 });
    const entry = animations[0]!;
    entry.progress = .4;
    const count = animations.length;
    Object.defineProperty(surface, 'offsetHeight', { value: 480 });
    resized();
    expect(animations).toHaveLength(count);
    expect(entry.progress).toBe(.4);
    expect(entry.effect.setKeyframes).toHaveBeenCalledOnce();
    expect(entry.frames.at(-1)).toMatchObject({ transform: 'translate(0px, 0px) scale(1)', clipPath: 'inset(0px 0px round 0px)' });
    expect(layer.querySelector<HTMLElement>('.ex-modal-shadow')?.style.height).toBe('480px');
    expect(trigger.style.visibility).toBe('');
    await finish();
    expect(disconnect).toHaveBeenCalledOnce();
    resized();
    expect(entry.effect.setKeyframes).toHaveBeenCalledOnce();
    const closing = motion!.retarget(false);
    motion!.dispose();
    expect(await closing).toBe(false);
    expect(disconnect).toHaveBeenCalledTimes(2);
  });

  it('normalizes an origin inside a scaled overlay', () => {
    const layer = document.createElement('div'), trigger = document.createElement('button');
    Object.defineProperty(layer, 'offsetWidth', { value: 500 });
    vi.spyOn(layer, 'getBoundingClientRect').mockReturnValue(new DOMRect(10, 20, 1000, 800));
    vi.spyOn(trigger, 'getBoundingClientRect').mockReturnValue(new DOMRect(110, 80, 320, 240));
    expect(measureModalOrigin(layer, trigger)).toEqual({ left: 50, top: 30, width: 160, height: 120, radius: 0 });
  });

  it('keeps decorative copies out of layout, focus and DOM identity, then releases them at rest', async () => {
    const { layer, surface, trigger } = setup();
    const face = layer.querySelector<HTMLElement>('.ex-modal-face')!;
    expect(face.style.position).toBe('absolute'); expect(face.inert).toBe(true);
    expect(face.getAttribute('aria-hidden')).toBe('true'); expect(face.querySelector('[id]')).toBeNull();
    expect(document.querySelectorAll('#origin')).toHaveLength(1); expect(trigger.isConnected).toBe(true);
    expect(trigger.style.visibility).toBe('hidden'); expect(face.style.visibility).toBe('visible');
    expect(surface.style.transformOrigin).toBe('50% 50%');
    await finish();
    expect(layer.querySelector('.ex-modal-face, .ex-modal-shadow')).toBeNull();
    expect(trigger.style.visibility).toBe('hidden');
    motion?.dispose(); expect(surface.style.transformOrigin).toBe('10px 20px');
    expect(trigger.style.visibility).toBe('');
    expect(media.removeEventListener).toHaveBeenCalledWith('change', changed);
  });

  it('paints only the travelling card on exit and restores the trigger after portal disposal', async () => {
    const { layer, trigger } = setup('inherit');
    await finish(); expect(trigger.style.visibility).toBe('hidden');
    Object.defineProperty(document, 'elementsFromPoint', { configurable: true, value: () => {
      expect(trigger.style.visibility).toBe('inherit');
      return [layer, trigger];
    } });
    const closing = motion!.retarget(false);
    expect(trigger.style.visibility).toBe('hidden');
    expect(layer.querySelector<HTMLElement>('.ex-modal-face')?.style.visibility).toBe('visible');
    await finish(); expect(await closing).toBe(true);
    expect(trigger.style.visibility).toBe('hidden');
    motion!.dispose(); expect(trigger.style.visibility).toBe('inherit');
  });

  it('leaves plainly when Create clears the origin, restoring the add tile immediately', async () => {
    const { layer, surface, trigger } = setup(); await finish();
    const closing = motion!.retarget(false, null);
    expect(trigger.style.visibility).toBe('');
    expect(layer.classList.contains('ex-modal-has-from')).toBe(false);
    expect(layer.querySelector('.ex-modal-face, .ex-modal-shadow')).toBeNull();
    const exit = animations.filter(animation => !animation.cancel.mock.calls.length);
    expect(exit).toHaveLength(2);
    expect(exit.find(animation => animation.target === surface)?.frames.at(-1)?.['opacity']).toBe('0');
    await finish(); expect(await closing).toBe(true);
  });

  it('can reopen from the add tile during a successful creation’s plain exit', async () => {
    const { layer, trigger } = setup(); await finish();
    const closing = motion!.retarget(false, null);
    const reopening = motion!.retarget(true, trigger);
    expect(await closing).toBe(false);
    expect(layer.classList.contains('ex-modal-has-from')).toBe(true);
    expect(trigger.style.visibility).toBe('hidden');
    await finish(); expect(await reopening).toBe(true);
    motion!.dispose(); expect(trigger.style.visibility).toBe('');
  });

  it('fades an unanchored dim independently and reverses without a stale close', async () => {
    const layer = document.createElement('div'), surface = document.createElement('section'), dim = document.createElement('div');
    layer.style.setProperty('--dur-slow', '280ms');
    layer.style.setProperty('--dur-base', '200ms');
    layer.style.setProperty('--ease-in', 'ease-in');
    layer.style.setProperty('--ease-out', 'ease-out');
    dim.className = 'ex-modal-dim'; dim.style.opacity = '0.6';
    surface.style.opacity = '0.8';
    layer.append(surface, dim); root.append(layer);
    motion = new ModalMotion(layer);
    const closing = motion.retarget(false);
    expect(animations[0]!.frames[0]?.['opacity']).toBe('0.8');
    expect(animations[1]!.target).toBe(dim);
    expect(animations[1]!.frames).toEqual([{ opacity: '0.6' }, { opacity: '0' }]);
    expect(animations.slice(0, 2).every(animation => animation.options.duration === 200)).toBe(true);
    const reopening = motion.retarget(true);
    expect(await closing).toBe(false);
    expect(animations[3]!.frames).toEqual([{ opacity: '0.6' }, { opacity: '1' }]);
    expect(animations.slice(2).every(animation => animation.options.duration === 280)).toBe(true);
    await finish(); expect(await reopening).toBe(true);
    expect(animations.every(animation => animation.cancel.mock.calls.length > 0)).toBe(true);
  });

  it('rejects stale exits when reopened and releases every animation on destruction', async () => {
    const { layer, surface, trigger } = setup();
    animations[0]!.progress = .4;
    const closing = motion!.retarget(false);
    const closeAnimations = animations.filter(animation => !animation.cancel.mock.calls.length);
    closeAnimations[0]!.progress = .2;
    const reopening = motion!.retarget(true);
    expect(trigger.style.visibility).toBe('hidden');
    expect(await closing).toBe(false);
    expect(layer.firstElementChild).toBe(surface);
    motion!.dispose();
    expect(await reopening).toBe(false);
    expect(animations.every(animation => animation.cancel.mock.calls.length > 0)).toBe(true);
    expect(layer.querySelector('.ex-modal-face, .ex-modal-shadow')).toBeNull();
    expect(trigger.style.visibility).toBe('');
  });

  it('finishes immediately when reduced motion changes, including an exit in progress', async () => {
    const { layer, trigger } = setup();
    const closing = motion!.retarget(false);
    media.matches = true; changed?.();
    expect(await closing).toBe(true);
    expect(animations.filter(animation => !animation.cancel.mock.calls.length).every(animation => animation.finish.mock.calls.length > 0)).toBe(true);
    await motion!.retarget(true);
    expect(layer.querySelector('.ex-modal-face, .ex-modal-shadow')).toBeNull();
    expect(trigger.style.visibility).toBe('hidden');
    motion!.dispose(); expect(trigger.style.visibility).toBe('');
  });

  it('returns into the replacement card within its window and waits for the complete exit', async () => {
    const { layer, trigger } = setup(); await finish(); trigger.remove();
    const replacement = document.createElement('button'); replacement.setAttribute('data-machine', 'new'); replacement.textContent = 'New server'; root.prepend(replacement);
    Object.defineProperty(replacement, 'offsetWidth', { value: 170 }); Object.defineProperty(replacement, 'offsetHeight', { value: 128 });
    vi.spyOn(replacement, 'getBoundingClientRect').mockReturnValue(new DOMRect(540, 560, 170, 128));
    Object.defineProperty(document, 'elementsFromPoint', { configurable: true, value: () => [layer, replacement] });
    const closing = motion!.retarget(false);
    expect(layer.querySelector('.ex-modal-face')?.textContent).toBe('New server');
    expect(motion!.returnTarget).toBe(replacement);
    expect(replacement.style.visibility).toBe('hidden');
    const exit = animations.filter(animation => !animation.cancel.mock.calls.length);
    expect(exit.every(animation => animation.options.duration === 500)).toBe(true);
    let removed = false; void closing.then(() => { removed = true; });
    await Promise.resolve(); expect(removed).toBe(false);
    exit.forEach(animation => animation.finish()); expect(await closing).toBe(true);
    motion!.dispose(); expect(replacement.style.visibility).toBe('');
    expect(trigger.style.visibility).toBe('');
  });
});
