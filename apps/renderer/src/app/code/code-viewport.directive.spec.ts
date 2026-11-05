import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { CodeViewportDirective } from './code-viewport.directive';
import { codeBlendDelay } from './code-view-transition';

@Component({ imports: [CodeViewportDirective], template: '<section><div><div exCodeViewport [active]="active()" [contextKey]="context()" [layoutReady]="ready()" (viewportWidth)="width.set($event)" (layoutRequested)="requested()"></div></div></section>' })
class Host { readonly active = signal(true); readonly width = signal(0); readonly ready = signal(true); readonly context = signal('task-one'); requests = 0; requested() { this.requests++; } }

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

  it('keeps the retained editor visible throughout ordinary opening, closing and interrupted reopening', async () => {
    const { fixture, frame, section, transition } = await setup();
    fixture.componentInstance.ready.set(false); await fixture.whenStable();
    let destination = '440px';
    class Effect { getKeyframes() { return [{width:'0px'},{width:destination}]; } }
    vi.stubGlobal('KeyframeEffect',Effect);
    Object.defineProperty(section,'getAnimations',{value:()=>[{transitionProperty:'width',effect:new Effect()}]});
    let panelWidth = 80;
    vi.spyOn(HTMLElement.prototype,'clientWidth','get').mockImplementation(function(this:HTMLElement) { return this === section ? panelWidth : width; });
    for (destination of ['440px','0px','440px']) {
      transition('transitionrun'); resize();
      expect(frame.style.getPropertyValue('--code-viewport-width')).toBe('432px');
      expect(frame.classList.contains('reflowing')).toBe(false);
      expect(frame.classList.contains('resizing')).toBe(false);
      expect(frame.classList.contains('crossfading')).toBe(false);
      transition('transitioncancel'); await nextFrame();
    }
    // Also ignore a closing transition when the shell has nearly settled.
    panelWidth = 440;
    destination='0px'; transition('transitionrun'); transition('transitionend'); await nextFrame();
    expect(frame.classList.contains('reflowing')).toBe(false);
    expect(fixture.componentInstance.requests).toBe(0);
  });

  it('starts blending one third into the actual shell clock without delaying a late acknowledgement', () => {
    const ancestor = document.createElement('section');
    let elapsed = 0;
    Object.defineProperty(ancestor,'getAnimations',{value:()=>[{transitionProperty:'width',get currentTime() { return elapsed; },effect:{getComputedTiming:()=>({duration:280})}}]});
    expect(codeBlendDelay(ancestor)).toBeCloseTo(280/3);
    elapsed=70; expect(codeBlendDelay(ancestor)).toBeCloseTo(280/3-70);
    elapsed=140; expect(codeBlendDelay(ancestor)).toBe(0);
    elapsed=280; expect(codeBlendDelay(ancestor)).toBe(0);
    expect(codeBlendDelay(document.createElement('section'))).toBe(0);
  });

  it('releases retained transition state when the owning task or visibility context changes', async () => {
    const { fixture, frame, transition } = await setup();
    transition('transitionrun');
    expect(frame.classList.contains('resizing')).toBe(true);
    fixture.componentInstance.context.set('task-two'); await fixture.whenStable();
    expect(frame.classList.contains('resizing')).toBe(false);
    expect(frame.classList.contains('reflowing')).toBe(false);
    expect(frame.style.getPropertyValue('--code-viewport-width')).toBe(`${width}px`);
  });

  it('resizes to the predicted destination behind an old snapshot before the shell finishes moving', async () => {
    const { fixture, frame, section, transition } = await setup();
    fixture.componentInstance.ready.set(false); await fixture.whenStable();
    class Effect {
      getKeyframes() { return [{width:'440px'},{width:'100%'}]; }
      getComputedTiming() { return {duration:280}; }
    }
    vi.stubGlobal('KeyframeEffect',Effect);
    Object.defineProperty(section,'getAnimations',{value:()=>[{transitionProperty:'width',currentTime:42,effect:new Effect()}]});
    const play = vi.fn(), pause = vi.fn(), updateTiming = vi.fn();
    const animation = {
      animationName:'code-layout-out',currentTime:0,playState:'idle',
      play() { play(); this.playState='running'; }, pause() { pause(); this.playState='paused'; },
      effect:{updateTiming,getComputedTiming:()=>({duration:280,delay:280/3-42})},
    };
    Object.defineProperty(frame,'getAnimations',{value:()=>[animation]});
    const containingBlock = document.createElement('div');
    Object.defineProperty(section,'offsetParent',{value:containingBlock});
    vi.spyOn(HTMLElement.prototype,'clientWidth','get').mockImplementation(function(this:HTMLElement) { return this === containingBlock ? 1080 : this === section ? width + 8 : width; });
    let update: Promise<void> | undefined;
    let complete!: () => void;
    const finished = new Promise<void>(resolve=>{complete=resolve;});
    const skip = vi.fn(complete);
    Object.defineProperty(frame,'startViewTransition',{value:(callback:()=>Promise<void>)=>{
      queueMicrotask(()=>{update=callback();});
      return {ready:Promise.resolve(),finished,skipTransition:skip};
    }});
    transition('transitionrun');
    // The shell can advance before Chromium captures the outgoing surface.
    width=500; resize();
    expect(frame.style.getPropertyValue('--code-viewport-width')).toBe('432px');
    expect(frame.style.transform).toBe('');
    await fixture.whenStable();
    expect(frame.style.getPropertyValue('--code-viewport-width')).toBe('1072px');
    expect(frame.style.width).toBe('');
    expect(fixture.componentInstance.width()).toBe(1072);
    expect(fixture.componentInstance.requests).toBe(1);
    expect(frame.classList.contains('reflowing')).toBe(false);
    expect(frame.classList.contains('crossfading')).toBe(true);
    expect(pause).toHaveBeenCalledOnce();
    expect(play).toHaveBeenCalledOnce();
    width=700; resize();
    expect(frame.style.getPropertyValue('--code-viewport-width')).toBe('1072px');
    expect(frame.style.transform).toBe('');
    expect(fixture.componentInstance.requests).toBe(1);
    animation.currentTime=300; await nextFrame();
    expect(animation.playState).toBe('paused');
    expect(animation.currentTime).toBeCloseTo(280/3-42+140);
    fixture.componentInstance.ready.set(true); await fixture.whenStable(); await update;
    expect(play).toHaveBeenCalledTimes(2);
    expect(updateTiming).toHaveBeenCalledOnce();
    expect(updateTiming).toHaveBeenCalledWith({delay:280/3-42});
    width=1072; transition('transitionend'); await nextFrame();
    expect(frame.style.getPropertyValue('--code-viewport-width')).toBe(`${width}px`);
    expect(frame.style.transform).toBe('');
    expect(fixture.componentInstance.requests).toBe(1);
    complete(); await finished; await Promise.resolve();
    expect(frame.classList.contains('crossfading')).toBe(false);
    expect(skip).not.toHaveBeenCalled();
  });

  it('never scales the live editor while the old snapshot is still being captured', async () => {
    width = 1072;
    const { fixture, frame, section, transition } = await setup();
    fixture.componentInstance.ready.set(false); await fixture.whenStable();
    class Effect { getKeyframes() { return [{width:'1080px'},{width:'440px'}]; } }
    vi.stubGlobal('KeyframeEffect', Effect);
    Object.defineProperty(section, 'getAnimations', {value:()=>[{transitionProperty:'width',effect:new Effect()}]});
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function(this: HTMLElement) { return this === section ? width + 8 : width; });
    let captured!: () => void, complete!: () => void;
    const ready = new Promise<void>(resolve=>{captured=resolve;});
    const finished = new Promise<void>(resolve=>{complete=resolve;});
    Object.defineProperty(frame, 'startViewTransition', {value:(update:()=>Promise<void>)=>{
      void update();
      return {ready,finished,skipTransition:complete};
    }});
    transition('transitionrun'); await fixture.whenStable();
    for (const nextWidth of [1072, 1040, 950, 700]) {
      width=nextWidth; resize();
      expect(fixture.componentInstance.width()).toBe(432);
      expect(frame.style.width).toBe('');
      expect(frame.style.transform).toBe('');
    }
    fixture.destroy(); captured(); await ready; await finished;
    expect(frame.style.getPropertyValue('--code-viewport-width')).toBe('');
  });

  it.each([true, false])('keeps the compact incoming image blurred until both collapse and layout finish (layout first: %s)', async layoutFirst => {
    width = 1072;
    const { fixture, frame, section, transition } = await setup();
    fixture.componentInstance.ready.set(false); await fixture.whenStable();
    class Effect {
      getKeyframes() { return [{width:'1080px'},{width:'440px'}]; }
      getComputedTiming() { return {duration:280}; }
    }
    vi.stubGlobal('KeyframeEffect', Effect);
    Object.defineProperty(section, 'getAnimations', {value:()=>[{transitionProperty:'width',currentTime:0,effect:new Effect()}]});
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function(this: HTMLElement) { return this === section ? width + 8 : width; });
    const animation = {
      animationName:'code-layout-out',currentTime:0,playState:'idle',
      play() { this.playState='running'; }, pause() { this.playState='paused'; },
      effect:{updateTiming:vi.fn(),getComputedTiming:()=>({duration:280,delay:280/3})},
    };
    Object.defineProperty(frame, 'getAnimations', {value:()=>[animation]});
    let complete!: () => void;
    const finished = new Promise<void>(resolve=>{complete=resolve;});
    Object.defineProperty(frame, 'startViewTransition', {value:(update:()=>Promise<void>)=>{
      queueMicrotask(()=>void update());
      return {ready:Promise.resolve(),finished,skipTransition:complete};
    }});
    transition('transitionrun'); await fixture.whenStable();
    expect(frame.style.getPropertyValue('--code-viewport-width')).toBe('432px');
    expect(frame.classList.contains('holding-collapse')).toBe(true);
    width=700; resize(); animation.currentTime=300; await nextFrame();
    expect(animation.playState).toBe('paused');
    expect(animation.currentTime).toBeCloseTo(280/3+140);
    if (layoutFirst) { fixture.componentInstance.ready.set(true); await fixture.whenStable(); }
    expect(animation.playState).toBe('paused');
    expect(frame.style.transform).toBe('');
    width=432; transition('transitionend'); await nextFrame();
    expect(frame.style.transform).toBe('');
    if (!layoutFirst) {
      expect(animation.playState).toBe('paused');
      fixture.componentInstance.ready.set(true); await fixture.whenStable();
    }
    expect(animation.playState).toBe('running');
    expect(animation.currentTime).toBeCloseTo(280/3+140);
    expect(frame.classList.contains('holding-collapse')).toBe(false);
    expect(fixture.componentInstance.requests).toBe(1);
    complete(); await finished; await Promise.resolve();
    expect(frame.classList.contains('crossfading')).toBe(false);
  });

  it('keeps the current viewport while inactive closing contents remain painted, then resumes measurement', async () => {
    const {fixture,frame,transition}=await setup();
    fixture.componentInstance.active.set(false); await fixture.whenStable();
    width=280; resize(); transition('transitionrun'); transition('transitionend'); await nextFrame();
    expect(frame.style.getPropertyValue('--code-viewport-width')).toBe('432px');
    expect(frame.classList.contains('reflowing')).toBe(false);
    expect(fixture.componentInstance.requests).toBe(0);
    fixture.componentInstance.active.set(true); await fixture.whenStable();
    expect(frame.style.getPropertyValue('--code-viewport-width')).toBe('280px');
  });

  it('freezes the cached viewport before reading any animated layout', async () => {
    const { frame, transition } = await setup();
    const measured = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get');
    measured.mockClear();
    transition('transitionrun');
    expect(measured).not.toHaveBeenCalled();
    expect(frame.style.getPropertyValue('--code-viewport-width')).toBe('432px');
  });

  it('holds one layout width through expansion and publishes the final compact boundary once', async () => {
    const { fixture, frame, transition } = await setup();
    transition('transitionrun');
    expect(frame.style.getPropertyValue('--code-viewport-width')).toBe('432px');
    for (const intermediate of [480, 610, 880, 1064]) {
      width = intermediate; resize();
      expect(frame.style.getPropertyValue('--code-viewport-width')).toBe('432px');
      expect(fixture.componentInstance.width()).toBe(432);
      expect(frame.style.transform).toBe('');
      expect(frame.classList.contains('reflowing')).toBe(true);
    }
    transition('transitionend'); await nextFrame();
    expect(frame.style.getPropertyValue('--code-viewport-width')).toBe(`${width}px`);
    expect(frame.style.transform).toBe('');
    expect(frame.classList.contains('resizing')).toBe(false);
    expect(frame.classList.contains('reflowing')).toBe(true);
    expect(fixture.componentInstance.width()).toBe(1064);
    await fixture.whenStable(); await nextFrame(); await nextFrame();
    expect(frame.classList.contains('reflowing')).toBe(false);
    width = 800; resize();
    expect(fixture.componentInstance.width()).toBe(800); // Native window resizing stays live.
  });

  it('holds the resized frame hidden until the current workbench layout is acknowledged', async () => {
    const { fixture, frame, transition } = await setup();
    fixture.componentInstance.ready.set(false); await fixture.whenStable();
    transition('transitionrun'); width = 1064; resize();
    transition('transitionend'); await nextFrame(); await fixture.whenStable();
    for (let count = 0; count < 5; count++) await nextFrame();
    expect(frame.style.getPropertyValue('--code-viewport-width')).toBe(`${width}px`);
    expect(frame.classList.contains('reflowing')).toBe(true);
    fixture.componentInstance.ready.set(true); await fixture.whenStable(); await nextFrame();
    expect(frame.classList.contains('reflowing')).toBe(false);
  });

  it('keeps a new transition faded if it interrupts the previous resize paint boundary', async () => {
    const { frame, transition } = await setup();
    transition('transitionrun'); width = 1064; resize();
    transition('transitionend'); await nextFrame();
    expect(frame.classList.contains('reflowing')).toBe(true);
    transition('transitionrun'); await nextFrame(); await nextFrame();
    expect(frame.classList.contains('reflowing')).toBe(true);
    expect(frame.style.getPropertyValue('--code-viewport-width')).toBe('1064px');
    width = 432; resize(); transition('transitionend');
    await nextFrame(); await nextFrame(); await nextFrame();
    expect(frame.classList.contains('reflowing')).toBe(false);
    expect(frame.style.getPropertyValue('--code-viewport-width')).toBe(`${width}px`);
  });

  it('keeps the original viewport across interrupted reversals and cleans up cancellation', async () => {
    const { fixture, frame, transition } = await setup();
    transition('transitionrun'); width = 700; resize();
    transition('transitioncancel'); transition('transitionrun'); await nextFrame();
    expect(frame.style.getPropertyValue('--code-viewport-width')).toBe('432px');
    expect(fixture.componentInstance.width()).toBe(432);
    width = 432; resize(); transition('transitionend'); await nextFrame();
    expect(frame.style.getPropertyValue('--code-viewport-width')).toBe(`${width}px`);
    transition('transitionrun'); width = 520; resize(); transition('transitioncancel'); await nextFrame();
    expect(frame.style.getPropertyValue('--code-viewport-width')).toBe(`${width}px`);
    expect(fixture.componentInstance.width()).toBe(520);
  });

  it('ignores unrelated effects and settles immediately if reduced motion changes mid-flight', async () => {
    const { fixture, frame, transition } = await setup();
    const unrelated = document.createElement('aside'); document.body.append(unrelated);
    transition('transitionrun', 'opacity'); transition('transitionrun', 'width', unrelated);
    expect(frame.style.getPropertyValue('--code-viewport-width')).toBe(`${width}px`); unrelated.remove();
    transition('transitionrun'); width = 1000; resize();
    reduced = true; mediaChanged();
    await fixture.whenStable(); await nextFrame();
    expect(frame.style.getPropertyValue('--code-viewport-width')).toBe(`${width}px`);
    expect(frame.classList.contains('reflowing')).toBe(false);
    expect(fixture.componentInstance.width()).toBe(1000);
    transition('transitionrun'); expect(frame.style.getPropertyValue('--code-viewport-width')).toBe(`${width}px`);
    width = 432; resize(); expect(fixture.componentInstance.width()).toBe(432);
  });

  it('releases observers, listeners, pending settlement and frozen styles on destruction', async () => {
    const { fixture, frame, transition } = await setup();
    transition('transitionrun'); transition('transitioncancel');
    fixture.destroy(); await nextFrame();
    expect(disconnect).toHaveBeenCalledOnce();
    expect(removeMedia).toHaveBeenCalledOnce();
    expect(frame.style.getPropertyValue('--code-viewport-width')).toBe('');
    expect(frame.classList.contains('resizing')).toBe(false);
    expect(frame.classList.contains('reflowing')).toBe(false);
    transition('transitionrun'); expect(frame.style.getPropertyValue('--code-viewport-width')).toBe('');
  });
});
