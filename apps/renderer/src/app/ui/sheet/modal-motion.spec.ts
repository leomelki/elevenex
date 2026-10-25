import { ModalMotion } from './modal-motion';
import { measureModalOrigin } from './modal-morph';

class ControlledAnimation {
  progress = 0;
  private resolve!: () => void;
  private reject!: () => void;
  readonly finished = new Promise<void>((resolve, reject) => { this.resolve = resolve; this.reject = reject; });
  readonly effect = { getComputedTiming: () => ({ progress: this.progress }) };
  readonly finish = vi.fn(() => { this.progress = 1; this.resolve(); });
  readonly cancel = vi.fn(() => this.reject());
  constructor(readonly target: HTMLElement, readonly frames: Keyframe[], readonly options: KeyframeAnimationOptions) {}
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

  function setup() {
    const layer = document.createElement('div'), surface = document.createElement('section'), trigger = document.createElement('button');
    trigger.id = 'origin'; trigger.innerHTML = '<span id="origin-label">Server</span>';
    surface.innerHTML = '<input aria-label="Host" />'; surface.style.transformOrigin = '10px 20px';
    layer.append(surface); root.append(trigger, layer);
    for (const [element, width, height] of [[layer, 1440, 960], [surface, 460, 330], [trigger, 170, 128]] as const) {
      Object.defineProperty(element, 'offsetWidth', { value: width }); Object.defineProperty(element, 'offsetHeight', { value: height });
    }
    vi.spyOn(layer, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 1440, 960));
    vi.spyOn(trigger, 'getBoundingClientRect').mockReturnValue(new DOMRect(540, 560, 170, 128));
    motion = new ModalMotion(layer, trigger);
    return { layer, surface, trigger };
  }
  async function finish() { animations.forEach(animation => animation.finish()); await Promise.resolve(); await Promise.resolve(); }

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
    expect(surface.style.transformOrigin).toBe('50% 50%');
    await finish();
    expect(layer.querySelector('.ex-modal-face, .ex-modal-shadow')).toBeNull();
    motion?.dispose(); expect(surface.style.transformOrigin).toBe('10px 20px');
    expect(media.removeEventListener).toHaveBeenCalledWith('change', changed);
  });

  it('rejects stale exits when reopened and releases every animation on destruction', async () => {
    const { layer, surface } = setup();
    animations[0]!.progress = .4;
    const closing = motion!.retarget(false);
    const closeAnimations = animations.filter(animation => !animation.cancel.mock.calls.length);
    closeAnimations[0]!.progress = .2;
    const reopening = motion!.retarget(true);
    expect(await closing).toBe(false);
    expect(layer.firstElementChild).toBe(surface);
    motion!.dispose();
    expect(await reopening).toBe(false);
    expect(animations.every(animation => animation.cancel.mock.calls.length > 0)).toBe(true);
    expect(layer.querySelector('.ex-modal-face, .ex-modal-shadow')).toBeNull();
  });

  it('finishes immediately when reduced motion changes, including an exit in progress', async () => {
    const { layer } = setup();
    const closing = motion!.retarget(false);
    media.matches = true; changed?.();
    expect(await closing).toBe(true);
    expect(animations.filter(animation => !animation.cancel.mock.calls.length).every(animation => animation.finish.mock.calls.length > 0)).toBe(true);
    await motion!.retarget(true);
    expect(layer.querySelector('.ex-modal-face, .ex-modal-shadow')).toBeNull();
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
    const exit = animations.filter(animation => !animation.cancel.mock.calls.length);
    expect(exit.every(animation => animation.options.duration === 500)).toBe(true);
    let removed = false; void closing.then(() => { removed = true; });
    await Promise.resolve(); expect(removed).toBe(false);
    exit.forEach(animation => animation.finish()); expect(await closing).toBe(true);
  });
});
