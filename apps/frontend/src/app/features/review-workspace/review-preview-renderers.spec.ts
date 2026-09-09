import {
  isHtmlPath,
  isMarkdownPath,
  resolveReviewPreviewRenderer,
  reviewPreviewRendererForPath,
} from './review-preview-renderers';

describe('review preview renderers', () => {
  it('matches markdown files', () => {
    for (const path of ['README.md', 'docs/a.markdown', 'notes.MDX']) {
      expect(reviewPreviewRendererForPath(path)?.id).toBe('markdown');
      expect(isMarkdownPath(path)).toBe(true);
    }
  });

  it('matches html documents', () => {
    for (const path of ['index.html', 'a/b.htm', 'page.XHTML']) {
      expect(reviewPreviewRendererForPath(path)?.id).toBe('html');
      expect(isHtmlPath(path)).toBe(true);
    }
  });

  it('does not match templates that a browser cannot render alone', () => {
    for (const path of ['card.hbs', 'mail.ejs', 'App.vue', 'Page.svelte']) {
      expect(reviewPreviewRendererForPath(path)).toBeNull();
    }
  });

  it('has no renderer for ordinary code', () => {
    expect(reviewPreviewRendererForPath('src/main.ts')).toBeNull();
    expect(reviewPreviewRendererForPath('style.css')).toBeNull();
  });

  it('opens markdown rendered and html on the diff', () => {
    expect(reviewPreviewRendererForPath('README.md')?.opensByDefault).toBe(true);
    // Rendering HTML runs the repository's own JavaScript, so it is a
    // deliberate click rather than a default.
    expect(reviewPreviewRendererForPath('index.html')?.opensByDefault).toBe(false);
  });

  it('gives the two renderers distinguishable preview icons', () => {
    const markdown = reviewPreviewRendererForPath('README.md');
    const html = reviewPreviewRendererForPath('index.html');
    expect(markdown?.previewIcon).not.toBe(html?.previewIcon);
  });

  it('has no renderer for a url target yet', () => {
    expect(
      resolveReviewPreviewRenderer({ kind: 'url', url: 'http://localhost:5173' }),
    ).toBeNull();
  });
});
