import { OverlayContainer } from '@angular/cdk/overlay';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FolderSuggestionsComponent } from './folder-suggestions.component';

describe('Folder suggestions attached to an entering card', () => {
  beforeEach(() => {
    vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined }));
    vi.spyOn(document.documentElement, 'clientWidth', 'get').mockReturnValue(1024);
    vi.spyOn(document.documentElement, 'clientHeight', 'get').mockReturnValue(768);
  });
  afterEach(() => vi.restoreAllMocks());

  it('follows the current visual origin through its finite ancestor animation and releases the overlay on close', async () => {
    const fixture = TestBed.createComponent(FolderSuggestionsComponent);
    fixture.componentRef.setInput('query', '~/code/');
    fixture.componentRef.setInput('listFolders', () => [{ path: '~/code/api', git: 'main' }]);
    fixture.detectChanges();
    await fixture.whenStable();
    const origin = fixture.nativeElement.querySelector('.field');
    if (!(origin instanceof HTMLElement)) throw new Error('Missing folder field');
    let originX = 200;
    vi.spyOn(origin, 'getBoundingClientRect').mockImplementation(() => new DOMRect(originX, 100, 480, 44));
    Object.defineProperties(origin, { offsetWidth: { configurable: true, value: 480 }, offsetHeight: { configurable: true, value: 44 } });
    // JSDOM has no WAAPI; expose the finite animation lifetime at the host boundary.
    const animation = Object.assign(new EventTarget(), { playState: 'running', effect: { getComputedTiming: () => ({ endTime: 500 }) } });
    Object.defineProperty(fixture.nativeElement, 'getAnimations', { configurable: true, value: () => [animation] });
    const field = origin.querySelector('input');
    field?.focus(); fixture.detectChanges();
    const container = TestBed.inject(OverlayContainer).getContainerElement();
    const pane = () => container.querySelector<HTMLElement>('.cdk-overlay-pane');
    // JSDOM has no layout engine: inspect the CSS coordinates delivered to CDK's
    // pane. The native capture additionally checks the final painted rectangle.
    await vi.waitFor(() => expect(pane()?.style.left).toBe('200px'));
    expect(pane()?.style.transform).toContain('translateX(-1px)');
    originX = 240;
    await vi.waitFor(() => expect(pane()?.style.left).toBe('240px'));
    expect(pane()?.style.width).toBe('482px');
    animation.playState = 'finished'; animation.dispatchEvent(new Event('finish'));
    field?.blur(); fixture.detectChanges();
    await vi.waitFor(() => expect(container.querySelector('[role="listbox"]')).toBeNull());
    fixture.destroy();
  });
});
