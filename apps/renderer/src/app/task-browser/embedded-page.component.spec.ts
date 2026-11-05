import { TestBed } from '@angular/core/testing';
import { afterEach, expect, it, vi } from 'vitest';
import type { TaskBrowserSurface } from '@elevenex/shared';
import { ELEVENEX_BRIDGE } from '../backend/backend-client.service';
import { EmbeddedPageComponent } from './embedded-page.component';

afterEach(() => TestBed.resetTestingModule());

it('retains the native guest for layout updates and replaces it only for a new engine identity', async () => {
  const attach = vi.fn().mockResolvedValue(undefined);
  TestBed.configureTestingModule({ providers: [{ provide: ELEVENEX_BRIDGE, useValue: { taskBrowserAttach: attach } }] });
  const fixture = TestBed.createComponent(EmbeddedPageComponent);
  const surface: TaskBrowserSurface = {
    scopeId: 'scope', taskId: 1, tabId: 'tab', partition: 'profile', bootstrap: 'about:blank#old',
    guest: { partition: 'profile', bootstrap: 'about:blank#old' },
    bounds: { x: 0, y: 0, width: 800, height: 600 }, zoom: 1, visible: true,
    generation: 1, interactive: true, driver: 'you', presentation: 'embedded',
  };
  const render = async (value: TaskBrowserSurface) => {
    fixture.componentRef.setInput('surface', value);
    fixture.detectChanges();
    await fixture.whenStable();
    return fixture.nativeElement.querySelector('webview') as HTMLElement;
  };
  const original = await render(surface);
  expect(original).not.toBeNull();
  // Electron updates the element's src after site navigation. That is not a
  // request from main to replace the engine.
  original.setAttribute('src', 'https://example.com/navigated');
  expect(await render({ ...surface, generation: 2, bounds: { ...surface.bounds, width: 900 } })).toBe(original);
  Object.defineProperty(original, 'getWebContentsId', { value: () => 10 });
  const replacement = await render({ ...surface, guest: { partition: 'profile', bootstrap: 'about:blank#new' } });
  expect(replacement).not.toBe(original);
  expect(original.isConnected).toBe(false);
  original.dispatchEvent(new Event('dom-ready'));
  expect(attach).not.toHaveBeenCalled();
  Object.defineProperty(replacement, 'getWebContentsId', { value: () => 11 });
  replacement.dispatchEvent(new Event('dom-ready'));
  expect(attach).toHaveBeenCalledWith('scope', 1, 'tab', 11);
  fixture.destroy();
  expect(replacement.isConnected).toBe(false);
});
