import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { CodeViewportDirective } from './code-viewport.directive';

@Component({ imports: [CodeViewportDirective], template: '<section><div><div exCodeViewport (viewportWidth)="width.set($event)"></div></div></section>' })
class Host { readonly width = signal(0); }

describe('Code viewport transition ownership', () => {
  let resize: () => void;
  let width: number;
  let mediaChanged: () => void;
  let reduced: boolean;
  const disconnect = vi.fn();
  const removeMedia = vi.fn();
  beforeEach(() => {
    width = 432; reduced = false;
    vi.stubGlobal('matchMedia', () => ({ get matches() { return reduced; }, addEventListener: (_: string, listener: () => void) => { mediaChanged = listener; }, removeEventListener: removeMedia }));
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback: () => void) { resize = callback; }
      observe() { /* Driven explicitly to test intermediate layout widths. */ }
      disconnect = disconnect;
    });
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(() => width);
  });
  afterEach(() => { TestBed.resetTestingModule(); vi.restoreAllMocks(); vi.unstubAllGlobals(); disconnect.mockClear(); removeMedia.mockClear(); });
  async function setup() {
    const fixture = TestBed.createComponent(Host);
    fixture.detectChanges(); await fixture.whenStable();
    const section: HTMLElement = fixture.nativeElement.querySelector('section');
    const frame: HTMLElement = section.querySelector('[exCodeViewport]')!;
    function transition(type: string, propertyName = 'width', target = section) {
      const event = new Event(type, { bubbles: true });
      Object.defineProperty(event, 'propertyName', { value: propertyName });
      target.dispatchEvent(event);
    }
    return { fixture, frame, section, transition };
  }
  const nextFrame = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()));

  it('holds one layout width through expansion and publishes the final compact boundary once', async () => {
    const { fixture, frame, transition } = await setup();
    transition('transitionrun');
    expect(frame.style.width).toBe('432px');
    for (const intermediate of [480, 610, 880, 1064]) {
      width = intermediate; resize();
      expect(frame.style.width).toBe('432px');
      expect(fixture.componentInstance.width()).toBe(432);
      expect(frame.style.transform).toContain('scaleX(');
    }
    transition('transitionend'); await nextFrame();
    expect(frame.style.width).toBe('');
    expect(frame.style.transform).toBe('');
    expect(frame.classList.contains('resizing')).toBe(false);
    expect(fixture.componentInstance.width()).toBe(1064);
    width = 800; resize();
    expect(fixture.componentInstance.width()).toBe(800); // Native window resizing stays live.
  });

  it('keeps the original viewport across interrupted reversals and cleans up cancellation', async () => {
    const { fixture, frame, transition } = await setup();
    transition('transitionrun'); width = 700; resize();
    transition('transitioncancel'); transition('transitionrun'); await nextFrame();
    expect(frame.style.width).toBe('432px');
    expect(fixture.componentInstance.width()).toBe(432);
    width = 432; resize(); transition('transitionend'); await nextFrame();
    expect(frame.style.width).toBe('');
    transition('transitionrun'); width = 520; resize(); transition('transitioncancel'); await nextFrame();
    expect(frame.style.width).toBe('');
    expect(fixture.componentInstance.width()).toBe(520);
  });

  it('ignores unrelated effects and settles immediately if reduced motion changes mid-flight', async () => {
    const { fixture, frame, transition } = await setup();
    const unrelated = document.createElement('aside'); document.body.append(unrelated);
    transition('transitionrun', 'opacity'); transition('transitionrun', 'width', unrelated);
    expect(frame.style.width).toBe(''); unrelated.remove();
    transition('transitionrun'); width = 1000; resize();
    reduced = true; mediaChanged();
    expect(frame.style.width).toBe('');
    expect(fixture.componentInstance.width()).toBe(1000);
    transition('transitionrun'); expect(frame.style.width).toBe('');
    width = 432; resize(); expect(fixture.componentInstance.width()).toBe(432);
  });

  it('releases observers, listeners, pending settlement and frozen styles on destruction', async () => {
    const { fixture, frame, transition } = await setup();
    transition('transitionrun'); transition('transitioncancel');
    fixture.destroy(); await nextFrame();
    expect(disconnect).toHaveBeenCalledOnce();
    expect(removeMedia).toHaveBeenCalledOnce();
    expect(frame.style.width).toBe('');
    expect(frame.classList.contains('resizing')).toBe(false);
    transition('transitionrun'); expect(frame.style.width).toBe('');
  });
});
