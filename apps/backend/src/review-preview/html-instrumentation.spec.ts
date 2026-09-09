import { transformPreviewHtml } from './html-instrumentation.js';

const BASE = {
  previewPrefix: '/api/review-preview/p/abc/',
  filePath: 'docs/demo/index.html',
  previewId: 'abc',
  bridgeUrl: '/api/review-preview/p/abc/___ex/bridge.js',
};

function transform(source: string) {
  return transformPreviewHtml({ ...BASE, source });
}

describe('transformPreviewHtml', () => {
  it('annotates elements with the source lines they span', () => {
    const { html, instrumented } = transform(
      ['<html>', '<body>', '<p>hello</p>', '</body>', '</html>'].join('\n'),
    );

    expect(instrumented).toBe(true);
    // <p> is on the third line of the source.
    expect(html).toMatch(/<p[^>]*data-ex-line="3"/);
    expect(html).toMatch(/<p[^>]*data-ex-end-line="3"/);
  });

  it('records the full span of a multi-line element', () => {
    const { html } = transform(
      ['<html><body>', '<div>', '  <span>a</span>', '</div>', '</body></html>'].join('\n'),
    );

    const div = /<div([^>]*)>/.exec(html)?.[1] ?? '';
    expect(div).toContain('data-ex-line="2"');
    expect(div).toContain('data-ex-end-line="4"');
  });

  it('gives every annotated element a distinct id', () => {
    const { html } = transform('<html><body><p>a</p><p>b</p></body></html>');
    const ids = [...html.matchAll(/data-ex-id="(\d+)"/g)].map((match) => match[1]);

    expect(ids.length).toBeGreaterThan(1);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('leaves parser-synthesised elements unannotated', () => {
    // No <html>/<head>/<body> in the source: the parser invents them, and they
    // have no source location to point at.
    const { html } = transform('<p>bare</p>');

    expect(html).toMatch(/<p[^>]*data-ex-line="1"/);
    expect(html).toMatch(/<body>/);
    expect(html).not.toMatch(/<body[^>]*data-ex-line/);
  });

  it('omits the inner-span attributes on void elements', () => {
    const { html } = transform('<html><body><img src="a.png"></body></html>');
    const img = /<img([^>]*)>/.exec(html)?.[1] ?? '';

    expect(img).toContain('data-ex-line="1"');
    expect(img).not.toContain('data-ex-so');
  });

  it('keeps the doctype through the round trip', () => {
    const { html } = transform('<!DOCTYPE html>\n<html><body><p>x</p></body></html>');
    expect(html.toLowerCase()).toContain('<!doctype html>');
  });

  it('re-roots root-absolute urls onto the preview prefix', () => {
    const { html } = transform(
      '<html><head><link href="/assets/a.css"></head>' +
        '<body><script src="/assets/a.js"></script></body></html>',
    );

    expect(html).toContain('href="/api/review-preview/p/abc/assets/a.css"');
    expect(html).toContain('src="/api/review-preview/p/abc/assets/a.js"');
  });

  it('leaves relative and absolute urls alone', () => {
    const { html } = transform(
      '<html><body><img src="./a.png"><img src="//cdn.example.com/b.png">' +
        '<img src="https://example.com/c.png"></body></html>',
    );

    expect(html).toContain('src="./a.png"');
    expect(html).toContain('src="//cdn.example.com/b.png"');
    expect(html).toContain('src="https://example.com/c.png"');
  });

  it('re-roots every candidate in a srcset', () => {
    const { html } = transform(
      '<html><body><img srcset="/a.png 1x, ./b.png 2x"></body></html>',
    );

    expect(html).toContain('/api/review-preview/p/abc/a.png 1x');
    expect(html).toContain('./b.png 2x');
  });

  it('injects the bridge as the first child of head', () => {
    const { html } = transform(
      '<html><head><title>t</title></head><body></body></html>',
    );

    // `<title` rather than `<title>`: the tag carries data attributes now.
    expect(html.indexOf(BASE.bridgeUrl)).toBeLessThan(html.indexOf('<title'));
    expect(html).toContain('data-ex-instrumented="1"');
    expect(html).toContain('data-ex-path="docs/demo/index.html"');
  });

  it('injects the bridge into a document with no head', () => {
    const { html } = transform('<p>no head here</p>');
    expect(html).toContain(BASE.bridgeUrl);
  });

  it('does not descend into template contents', () => {
    const { html } = transform(
      '<html><body><template><p>inert</p></template></body></html>',
    );
    // The template itself is annotated; what it holds never renders.
    expect(html).toMatch(/<template[^>]*data-ex-line/);
    expect(html).toMatch(/<p>inert<\/p>/);
  });

  it('does not throw on malformed markup', () => {
    expect(() => transform('<div><p>unclosed<div><<>')).not.toThrow();
  });

  it('falls back to plain injection for a document too large to annotate', () => {
    const filler = '<p>x</p>'.repeat(300_000);
    const { html, instrumented } = transform(`<html><head></head><body>${filler}</body></html>`);

    expect(instrumented).toBe(false);
    expect(html).toContain('data-ex-instrumented="0"');
    expect(html).not.toContain('data-ex-line');
  });
});
