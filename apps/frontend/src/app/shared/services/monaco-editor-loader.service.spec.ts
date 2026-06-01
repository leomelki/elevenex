import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MonacoApi, MonacoEditorLoaderService } from './monaco-editor-loader.service';

describe('MonacoEditorLoaderService', () => {
  let originalMonaco: typeof window.monaco;
  let originalRequire: typeof window.require;
  let originalRuntime: typeof window.__ELEVENEX_RUNTIME__;
  let originalHeadHtml: string;

  beforeEach(() => {
    originalMonaco = window.monaco;
    originalRequire = window.require;
    originalRuntime = window.__ELEVENEX_RUNTIME__;
    originalHeadHtml = document.head.innerHTML;
    window.monaco = undefined;
    window.require = undefined;
    window.__ELEVENEX_RUNTIME__ = { backendOrigin: 'http://backend.test' };
    document.head.innerHTML = '<base href="http://frontend.test/app/">';
    document.body.innerHTML = '';
  });

  afterEach(() => {
    window.monaco = originalMonaco;
    window.require = originalRequire;
    window.__ELEVENEX_RUNTIME__ = originalRuntime;
    document.head.innerHTML = originalHeadHtml;
    document.body.innerHTML = '';
  });

  it('loads Monaco from the frontend asset base instead of the backend origin', async () => {
    const service = new MonacoEditorLoaderService();
    const fakeMonaco = { editor: {} } as MonacoApi;
    const requireMock = vi.fn((modules: string[], onLoad: () => void) => {
      expect(modules).toEqual(['vs/editor/editor.main']);
      window.monaco = fakeMonaco;
      onLoad();
    }) as unknown as NonNullable<typeof window.require>;
    requireMock.config = vi.fn();

    const loadPromise = service.load();
    const script = Array.from(document.scripts).find(
      (element) => element.src === 'http://frontend.test/app/vs/loader.js',
    );
    const stylesheet = Array.from(
      document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]'),
    ).find((element) => element.href === 'http://frontend.test/app/vs/editor/editor.main.css');

    expect(script).toBeTruthy();
    expect(stylesheet).toBeTruthy();

    window.require = requireMock;
    script?.dispatchEvent(new Event('load'));

    await expect(loadPromise).resolves.toBe(fakeMonaco);
    expect(requireMock.config).toHaveBeenCalledWith({
      paths: { vs: 'http://frontend.test/app/vs' },
    });
  });
});
