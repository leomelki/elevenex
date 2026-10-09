import { ComponentFixture, TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Z_MODAL_DATA, ZardDialogRef } from '@/shared/components/dialog';
import { MediaViewerComponent } from './media-viewer.component';

describe('MediaViewerComponent trackpad gestures', () => {
  let fixture: ComponentFixture<MediaViewerComponent>;
  let viewport: HTMLElement;
  let resize: () => void;
  const disconnect = vi.fn();

  beforeEach(async () => {
    disconnect.mockClear();
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: () => void) {
          resize = callback;
        }
        observe() {}
        disconnect = disconnect;
      },
    );
    await TestBed.configureTestingModule({
      imports: [MediaViewerComponent],
      providers: [
        {
          provide: Z_MODAL_DATA,
          useValue: {
            images: [
              { src: 'data:image/png;base64,AAA', label: 'First' },
              { src: 'data:image/png;base64,BBB', label: 'Second' },
            ],
            index: 0,
          },
        },
        { provide: ZardDialogRef, useValue: { close: vi.fn() } },
      ],
    }).compileComponents();
    fixture = TestBed.createComponent(MediaViewerComponent);
    fixture.detectChanges();
    await fixture.whenStable();
    viewport = fixture.componentInstance.viewport().nativeElement;
    Object.defineProperties(viewport, {
      clientWidth: { configurable: true, value: 800 },
      clientHeight: { configurable: true, value: 600 },
    });
    vi.spyOn(viewport, 'getBoundingClientRect').mockReturnValue({
      left: 0,
      top: 0,
      width: 800,
      height: 600,
    } as DOMRect);
    resize();
    const image = fixture.nativeElement.querySelector('img');
    Object.defineProperties(image, {
      naturalWidth: { value: 1600 },
      naturalHeight: { value: 1200 },
    });
    image.dispatchEvent(new Event('load'));
    fixture.detectChanges();
  });

  afterEach(() => {
    fixture.destroy();
    vi.unstubAllGlobals();
  });

  function wheel(options: WheelEventInit): WheelEvent {
    const event = new WheelEvent('wheel', {
      cancelable: true,
      bubbles: true,
      clientX: 400,
      clientY: 300,
      ...options,
    });
    viewport.dispatchEvent(event);
    fixture.detectChanges();
    return event;
  }

  it('pinches smoothly around the pointer without zooming the page or reloading the image', () => {
    const viewer = fixture.componentInstance;
    const image = fixture.nativeElement.querySelector('img');
    const before = viewer.scale();
    const event = wheel({ ctrlKey: true, deltaY: -30, clientX: 500 });
    expect(event.defaultPrevented).toBe(true);
    expect(viewer.scale()).toBeCloseTo(before * Math.exp(0.3));
    expect((100 - viewer.pan().x) / viewer.scale()).toBeCloseTo(100 / before);
    expect(viewer.zoomLabel()).toBe(`${Math.round(viewer.scale() * 100)}%`);
    expect(fixture.nativeElement.querySelector('img')).toBe(image);
    expect(image.style.transform).toContain(`scale(${viewer.scale()})`);
  });

  it('pans in both axes and stops at the image edges', () => {
    const viewer = fixture.componentInstance;
    viewer.changeZoom(1);
    wheel({ deltaX: 60, deltaY: -80 });
    expect(viewer.pan()).toEqual({ x: -60, y: 80 });
    wheel({ deltaX: 10000, deltaY: -10000 });
    expect(viewer.pan()).toEqual({ x: -416, y: 316 });
    wheel({ deltaX: -10000, deltaY: 10000 });
    expect(viewer.pan()).toEqual({ x: 416, y: -316 });
  });

  it('normalizes line and page scroll deltas', () => {
    const viewer = fixture.componentInstance;
    viewer.changeZoom(1);
    wheel({ deltaMode: 1, deltaX: 2, deltaY: 3 });
    expect(viewer.pan()).toEqual({ x: -32, y: -48 });
    wheel({ deltaMode: 2, deltaY: 1 });
    expect(viewer.pan().y).toBe(-316);
  });

  it('bounds pinch zoom between fit and 300% and resets pan at fit', () => {
    const viewer = fixture.componentInstance;
    for (let i = 0; i < 5; i++) wheel({ ctrlKey: true, deltaY: -100 });
    expect(viewer.scale()).toBe(3);
    wheel({ deltaX: 100, deltaY: 100 });
    for (let i = 0; i < 5; i++) wheel({ ctrlKey: true, deltaY: 100 });
    expect(viewer.zoom()).toBe(0);
    expect(viewer.scale()).toBe(viewer.fitScale());
    expect(viewer.pan()).toEqual({ x: 0, y: 0 });
  });

  it('resets on fit and gallery navigation and clamps pan after a resize', () => {
    const viewer = fixture.componentInstance;
    viewer.changeZoom(1);
    wheel({ deltaX: 10000, deltaY: 10000 });
    Object.defineProperties(viewport, {
      clientWidth: { value: 1400 },
      clientHeight: { value: 1000 },
    });
    resize();
    expect(viewer.pan()).toEqual({ x: -116, y: -116 });
    viewer.fit();
    expect(viewer.pan()).toEqual({ x: 0, y: 0 });
    viewer.changeZoom(1);
    wheel({ deltaX: 50 });
    viewer.move(1);
    expect(viewer.zoom()).toBe(0);
    expect(viewer.pan()).toEqual({ x: 0, y: 0 });
    expect(viewer.loading()).toBe(true);
  });

  it('ignores gestures while loading or unavailable and removes listeners on close', () => {
    const viewer = fixture.componentInstance;
    viewer.loading.set(true);
    wheel({ ctrlKey: true, deltaY: -30 });
    expect(viewer.zoom()).toBe(0);
    viewer.loading.set(false);
    viewer.failed.set(true);
    wheel({ ctrlKey: true, deltaY: -30 });
    expect(viewer.zoom()).toBe(0);
    fixture.destroy();
    expect(disconnect).toHaveBeenCalledOnce();
    const event = new WheelEvent('wheel', { cancelable: true, ctrlKey: true, deltaY: -30 });
    viewport.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });
});
