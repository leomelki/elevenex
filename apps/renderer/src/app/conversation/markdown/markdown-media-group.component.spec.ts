import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MarkdownMediaGroupComponent } from './markdown-media-group.component';
import type { MarkdownAsset } from './markdown-parser';

const source = 'data:image/png;base64,iVBORw0KGgo=';
const image = (src = source): MarkdownAsset => ({ kind: 'image', src, w: 1280, h: 720 });
beforeEach(() => {
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));
});
afterEach(() => { TestBed.resetTestingModule(); vi.unstubAllGlobals(); });

describe('asynchronous Markdown galleries', () => {
  it('keeps keyed gallery slots and a loaded image mounted while other sources arrive or fail', () => {
    const fixture = TestBed.createComponent(MarkdownMediaGroupComponent);
    const assets = signal<ReadonlyMap<string, MarkdownAsset>>(new Map());
    fixture.componentRef.setInput('items', [
      { path: '/one.png', caption: 'One' }, { path: '/two.png', caption: 'Two' }, { path: '/three.png', caption: 'Three' },
    ]);
    fixture.componentRef.setInput('resolve', (path: string) => assets().get(path));
    fixture.detectChanges();
    const root = fixture.nativeElement as HTMLElement;
    const gallery = root.querySelector('.images');
    const slots = [...root.querySelectorAll('.image-slot')];
    expect(slots).toHaveLength(3);
    expect(gallery?.classList.contains('strip')).toBe(true);
    assets.set(new Map([['/two.png', image()]])); fixture.detectChanges();
    const second = slots[1]?.querySelector('img');
    expect(second).not.toBeNull();
    assets.set(new Map([['/one.png', image(source + 'AA')], ['/two.png', image()], ['/three.png', { kind: 'image', src: '', w: 0, h: 0, error: 'Read failed' }]]));
    fixture.detectChanges();
    expect(root.querySelector('.images')).toBe(gallery);
    expect([...root.querySelectorAll('.image-slot')]).toEqual(slots);
    expect(slots[1]?.querySelector('img')).toBe(second);
    expect(slots[2]?.textContent).toContain('Read failed');
    expect(root.querySelectorAll('figcaption')).toHaveLength(3);
  });

  it('reserves the comparison and disabled controls before either image is available', () => {
    const fixture = TestBed.createComponent(MarkdownMediaGroupComponent);
    const assets = signal<ReadonlyMap<string, MarkdownAsset>>(new Map());
    fixture.componentRef.setInput('items', [{ path: '/before.png', caption: 'Before' }, { path: '/after.png', caption: 'After' }]);
    fixture.componentRef.setInput('resolve', (path: string) => assets().get(path));
    fixture.detectChanges();
    const root = fixture.nativeElement as HTMLElement;
    const frame = root.querySelector('.compare-images');
    const slider = root.querySelector<HTMLInputElement>('input');
    expect(frame).not.toBeNull(); expect(slider?.disabled).toBe(true);
    assets.set(new Map([['/before.png', image()]])); fixture.detectChanges();
    expect(root.querySelector('.compare-images')).toBe(frame); expect(slider?.disabled).toBe(true);
    assets.set(new Map([['/before.png', image()], ['/after.png', image(source + 'AA')]])); fixture.detectChanges();
    expect(root.querySelector('.compare-images')).toBe(frame); expect(root.querySelector('input')).toBe(slider);
    expect(slider?.disabled).toBe(false);
    root.querySelector('img')?.dispatchEvent(new Event('error')); fixture.detectChanges();
    expect(root.querySelector('.compare-images')).toBe(frame); expect(slider?.disabled).toBe(true);
  });

  it('renders before and after recordings in regular gallery slots', () => {
    const fixture = TestBed.createComponent(MarkdownMediaGroupComponent);
    const loading: MarkdownAsset = { kind: 'video', src: '', w: 0, h: 0, loading: true };
    const assets = signal<MarkdownAsset>(loading);
    fixture.componentRef.setInput('items', [{ path: '/before.webm', caption: 'Before' }, { path: '/after.webm', caption: 'After' }]);
    fixture.componentRef.setInput('resolve', () => assets());
    fixture.detectChanges();
    const root = fixture.nativeElement as HTMLElement;
    const slots = root.querySelectorAll('.image-slot');
    expect(slots).toHaveLength(2);
    assets.set({ ...loading, src: 'data:video/webm;base64,AAAA', loading: false });
    fixture.detectChanges();
    expect([...root.querySelectorAll('.image-slot')]).toEqual([...slots]);
    expect(root.querySelectorAll('video')).toHaveLength(2);
    expect(root.querySelector('input[aria-label="Before and after comparison"]')).toBeNull();
  });

  it('keeps the inspected image selected by path when an earlier image finishes loading', () => {
    const fixture = TestBed.createComponent(MarkdownMediaGroupComponent);
    const assets = signal<ReadonlyMap<string, MarkdownAsset>>(new Map([['/two.png', image()]]));
    fixture.componentRef.setInput('items', [{ path: '/one.png', caption: 'One' }, { path: '/two.png', caption: 'Two' }]);
    fixture.componentRef.setInput('resolve', (path: string) => assets().get(path));
    fixture.detectChanges();
    const dialog = (fixture.nativeElement as HTMLElement).querySelector('dialog')!;
    dialog.showModal = vi.fn();
    fixture.componentInstance.open('/two.png');
    assets.set(new Map([['/one.png', image(source + 'AA')], ['/two.png', image()]])); fixture.detectChanges();
    expect(fixture.componentInstance.current()?.path).toBe('/two.png');
    expect(fixture.componentInstance.viewerIndex()).toBe(1);
    expect((fixture.nativeElement as HTMLElement).querySelector('dialog')).toBe(dialog);
  });
});
