import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MonacoEditorLoaderService } from './monaco-editor-loader.service';

describe('MonacoEditorLoaderService', () => {
  let originalMonaco: typeof window.monaco;
  let originalRuntime: typeof window.__ELEVENEX_RUNTIME__;
  let originalMonacoEnvironment: typeof globalThis.MonacoEnvironment;
  let originalQueryCommandSupported: typeof document.queryCommandSupported;
  let originalHeadHtml: string;

  beforeEach(() => {
    originalMonaco = window.monaco;
    originalRuntime = window.__ELEVENEX_RUNTIME__;
    originalMonacoEnvironment = globalThis.MonacoEnvironment;
    originalQueryCommandSupported = document.queryCommandSupported;
    originalHeadHtml = document.head.innerHTML;
    window.monaco = undefined;
    window.__ELEVENEX_RUNTIME__ = { backendOrigin: 'http://backend.test' };
    globalThis.MonacoEnvironment = undefined;
    document.queryCommandSupported ??= () => false;
    document.body.innerHTML = '';
  });

  afterEach(() => {
    window.monaco = originalMonaco;
    window.__ELEVENEX_RUNTIME__ = originalRuntime;
    globalThis.MonacoEnvironment = originalMonacoEnvironment;
    document.queryCommandSupported = originalQueryCommandSupported;
    document.head.innerHTML = originalHeadHtml;
    document.body.innerHTML = '';
  });

  it('loads Monaco from bundled frontend modules instead of /vs assets', async () => {
    const service = new MonacoEditorLoaderService();

    const monaco = await service.load();
    const languageIds = monaco.languages.getLanguages().map((language) => language.id);

    expect(monaco.editor.createModel).toEqual(expect.any(Function));
    expect(languageIds).toEqual(expect.arrayContaining(['go', 'rust', 'typescript']));
    expect(window.monaco).toBe(monaco);
    expect(globalThis.MonacoEnvironment?.getWorker).toEqual(expect.any(Function));
    expect(Array.from(document.scripts).some((element) => element.src.includes('/vs/'))).toBe(false);
    expect(
      Array.from(document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')).some(
        (element) => element.href.includes('/vs/'),
      ),
    ).toBe(false);
  }, 15_000);
});
