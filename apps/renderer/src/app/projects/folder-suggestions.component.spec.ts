import { TestBed } from '@angular/core/testing';
import { OverlayContainer } from '@angular/cdk/overlay';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FolderSuggestionsComponent } from './folder-suggestions.component';
import type { FolderEntry } from './project.models';

describe('Folder suggestions keyboard and feedback', () => {
  beforeEach(() => vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn() })));
  afterEach(() => vi.unstubAllGlobals());
  const key = (field: HTMLElement, value: string) => field.dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true }));
  async function setup(entries: readonly FolderEntry[]) {
    const fixture = TestBed.createComponent(FolderSuggestionsComponent);
    fixture.componentRef.setInput('query', '/code/');
    fixture.componentRef.setInput('listFolders', () => entries);
    fixture.detectChanges(); await fixture.whenStable();
    const field: HTMLInputElement = fixture.nativeElement.querySelector('input');
    field.focus(); fixture.detectChanges();
    return { fixture, field, overlay: TestBed.inject(OverlayContainer).getContainerElement() };
  }
  it('dismisses only its popup on Escape and lets Tab leave a dismissed popup', async () => {
    const { fixture, field, overlay } = await setup([{ path: '/code/api', git: 'main' }]);
    expect(overlay.querySelector('[role="listbox"]')).not.toBeNull();
    expect(key(field, 'Escape')).toBe(false); fixture.detectChanges();
    expect(overlay.querySelector('[role="listbox"]')).toBeNull();
    expect(key(field, 'Tab')).toBe(true);
    expect(field.value).toBe('/code/');
    expect(key(field, 'Escape')).toBe(true);
  });
  it('skips already-added paths and selects only the available keyboard option', async () => {
    const { fixture, field, overlay } = await setup([{ path: '/code/one', git: 'main' }, { path: '/code/two', git: 'main' }, { path: '/code/three', git: 'main' }]);
    fixture.componentRef.setInput('addedPaths', ['/code/two']); fixture.detectChanges();
    key(field, 'ArrowDown'); fixture.detectChanges();
    expect(overlay.querySelector('[aria-selected="true"]')?.textContent).toContain('three');
    const selected = vi.fn(); fixture.componentInstance.selected.subscribe(selected);
    key(field, 'Enter');
    expect(selected).toHaveBeenCalledWith(expect.objectContaining({ path: '/code/three' }));
  });
  it('selects a directory with Enter and appends a slash with Tab to browse its children', async () => {
    const entry = { path: '/code/folder', dir: true };
    const child = { path: '/code/folder/child', dir: true };
    const { fixture, field, overlay } = await setup([entry]);
    fixture.componentRef.setInput('listFolders', (query: string) => query === entry.path + '/' ? [child] : [entry]);
    fixture.detectChanges(); await fixture.whenStable();
    const selected = vi.fn(); fixture.componentInstance.selected.subscribe(selected);
    key(field, 'Enter'); expect(selected).toHaveBeenCalledWith(entry);
    selected.mockClear();
    expect(key(field, 'Tab')).toBe(false);
    fixture.detectChanges(); await fixture.whenStable();
    expect(field.value).toBe('/code/folder/');
    expect(overlay.querySelector('[role="option"]')?.textContent).toContain('child');
    expect(selected).not.toHaveBeenCalled();
    key(field, 'Enter'); expect(selected).toHaveBeenCalledWith(child);
  });
  it('adds a trailing slash when Tab is pressed on an already completed directory', async () => {
    const { fixture, field } = await setup([{ path: '/code/folder', dir: true }]);
    fixture.componentRef.setInput('query', '/code/folder'); fixture.detectChanges(); await fixture.whenStable();
    expect(key(field, 'Tab')).toBe(false);
    fixture.detectChanges(); await fixture.whenStable();
    expect(field.value).toBe('/code/folder/');
  });
  it('keeps Tab on a pending query and completes when its own results arrive', async () => {
    const fixture = TestBed.createComponent(FolderSuggestionsComponent);
    const entry = { path: '/code/folder', dir: true };
    let resolve!: (entries: readonly FolderEntry[]) => void;
    fixture.componentRef.setInput('query', '/code/fo');
    fixture.componentRef.setInput('listFolders', (query: string) => query === entry.path + '/' ? [] : new Promise<readonly FolderEntry[]>(yes => { resolve = yes; }));
    fixture.detectChanges(); await Promise.resolve(); await Promise.resolve();
    const field: HTMLInputElement = fixture.nativeElement.querySelector('input');
    field.focus(); fixture.detectChanges();
    expect(key(field, 'Tab')).toBe(false);
    resolve([entry]); await fixture.whenStable();
    expect(field.value).toBe(entry.path + '/');
    expect(document.activeElement).toBe(field);
  });
  it('does not turn a Git URL into a local folder when Tab is pressed', async () => {
    const { fixture, field } = await setup([{ path: '/code/repo', clone: 'https://example.com/repo.git' }]);
    fixture.componentRef.setInput('query', 'https://example.com/repo.git'); fixture.detectChanges(); await fixture.whenStable();
    expect(key(field, 'Tab')).toBe(true);
    expect(field.value).toBe('https://example.com/repo.git');
  });
  it('filters compatible folders immediately without clearing the popup while a fresh request is pending', async () => {
    const entries = [{ path: '/code/api', git: 'main' }, { path: '/code/app', git: 'main' }, { path: '/code/docs', git: 'main' }];
    const { fixture, field, overlay } = await setup(entries);
    let resolve!: (entries: readonly FolderEntry[]) => void;
    fixture.componentRef.setInput('listFolders', (query: string) => query === '/code/' ? entries : new Promise<readonly FolderEntry[]>(yes => { resolve = yes; }));
    fixture.detectChanges(); await fixture.whenStable();
    const popup = overlay.querySelector('[role="listbox"]');
    const api = overlay.querySelector('[role="option"]');
    field.value = '/code/ap'; field.dispatchEvent(new Event('input', { bubbles: true })); fixture.detectChanges();
    await Promise.resolve(); await Promise.resolve();
    expect(overlay.querySelector('[role="listbox"]')).toBe(popup);
    expect(overlay.querySelector('[role="option"]')).toBe(api);
    expect(overlay.querySelectorAll('[role="option"]')).toHaveLength(2);
    expect(overlay.textContent).not.toContain('Loading folders');
    expect(overlay.textContent).not.toContain('docs');
    resolve(entries.slice(0, 2)); await fixture.whenStable();
  });
  it('preserves the highlighted folder and text selection when a same-directory reply reorders rows', async () => {
    const entries = [{ path: '/code/api', git: 'main' }, { path: '/code/app', git: 'main' }];
    const { fixture, field, overlay } = await setup(entries);
    let resolve!: (entries: readonly FolderEntry[]) => void;
    fixture.componentRef.setInput('listFolders', (query: string) => query === '/code/' ? entries : new Promise<readonly FolderEntry[]>(yes => { resolve = yes; }));
    fixture.detectChanges(); await fixture.whenStable();
    key(field, 'ArrowDown'); fixture.detectChanges();
    field.value = '/code/a'; field.dispatchEvent(new Event('input', { bubbles: true })); fixture.detectChanges();
    await Promise.resolve(); await Promise.resolve();
    field.setSelectionRange(2, 4);
    resolve([...entries].reverse()); await fixture.whenStable();
    expect(overlay.querySelector('[aria-selected="true"]')?.textContent).toContain('app');
    expect(field.selectionStart).toBe(2); expect(field.selectionEnd).toBe(4);
    expect(document.activeElement).toBe(field);
    expect(key(field, 'Tab')).toBe(true);
    expect(field.value).toBe('/code/a');
  });
  it('keeps home notation and moves the caret to the end only for explicit Tab completion', async () => {
    const entry = { path: '/remote/home/design', dir: true };
    const { fixture, field } = await setup([entry]);
    fixture.componentRef.setInput('query', '~/de'); fixture.detectChanges(); await fixture.whenStable();
    expect(key(field, 'Tab')).toBe(false);
    expect(field.value).toBe('~/design/');
    expect(field.selectionStart).toBe(field.value.length);
    expect(field.selectionEnd).toBe(field.value.length);
    fixture.detectChanges(); await fixture.whenStable();
  });
  it('honors Enter pressed while fresh results are pending exactly once and cancels a pending completion on blur', async () => {
    const fixture = TestBed.createComponent(FolderSuggestionsComponent);
    const entry = { path: '/code/api', git: 'main' };
    const requests: ((entries: readonly FolderEntry[]) => void)[] = [];
    fixture.componentRef.setInput('query', '/code/api');
    fixture.componentRef.setInput('listFolders', () => new Promise<readonly FolderEntry[]>(resolve => requests.push(resolve)));
    const selected = vi.fn(); fixture.componentInstance.selected.subscribe(selected);
    fixture.detectChanges(); await Promise.resolve(); await Promise.resolve();
    const field: HTMLInputElement = fixture.nativeElement.querySelector('input');
    field.focus(); fixture.detectChanges(); key(field, 'Enter'); key(field, 'Enter');
    requests[0]?.([entry]); await fixture.whenStable();
    expect(selected).toHaveBeenCalledExactlyOnceWith(entry);
    field.value = '/other/'; field.dispatchEvent(new Event('input', { bubbles: true })); fixture.detectChanges();
    await Promise.resolve(); await Promise.resolve();
    key(field, 'Tab'); field.blur(); fixture.detectChanges();
    requests[1]?.([{ path: '/other/design', dir: true }]); await fixture.whenStable();
    expect(field.value).toBe('/other/');
  });
  it('waits for text composition to finish before fetching or accepting keyboard intents', async () => {
    const { fixture, field } = await setup([{ path: '/code/api', git: 'main' }]);
    const provider = vi.fn(() => []);
    fixture.componentRef.setInput('listFolders', provider); fixture.detectChanges(); await fixture.whenStable(); provider.mockClear();
    const selected = vi.fn(); fixture.componentInstance.selected.subscribe(selected);
    field.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    field.value = '/code/あ'; field.dispatchEvent(new Event('input', { bubbles: true })); fixture.detectChanges();
    await Promise.resolve(); key(field, 'Enter');
    expect(provider).not.toHaveBeenCalled(); expect(selected).not.toHaveBeenCalled();
    field.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })); fixture.detectChanges(); await fixture.whenStable();
    expect(provider).toHaveBeenCalledOnce();
    expect(provider).toHaveBeenCalledWith('/code/あ', expect.any(AbortSignal));
  });
  it('shows an empty result and retries a failed provider with Enter without losing the query', async () => {
    const { fixture, field, overlay } = await setup([]);
    expect(overlay.textContent).toContain('No matching folders');
    const provider = vi.fn().mockRejectedValueOnce(new Error('private service detail')).mockResolvedValueOnce([{ path: '/code/api', git: 'main' }]);
    fixture.componentRef.setInput('listFolders', provider); fixture.detectChanges(); await fixture.whenStable();
    expect(overlay.textContent).toContain('Folders could not be loaded');
    expect(overlay.textContent).not.toContain('private service detail');
    key(field, 'Enter'); fixture.detectChanges(); await fixture.whenStable();
    expect(provider).toHaveBeenCalledTimes(2);
    expect(field.value).toBe('/code/'); expect(overlay.textContent).toContain('api');
  });
});

describe('Folder suggestions attached to an entering card', () => {
  beforeEach(() => {
    vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined, addListener: () => undefined, removeListener: () => undefined }));
    vi.spyOn(document.documentElement, 'clientWidth', 'get').mockReturnValue(1024);
    vi.spyOn(document.documentElement, 'clientHeight', 'get').mockReturnValue(768);
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

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
