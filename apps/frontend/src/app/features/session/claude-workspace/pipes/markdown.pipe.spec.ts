import { TestBed } from '@angular/core/testing';
import { DomSanitizer } from '@angular/platform-browser';
import { provideZonelessChangeDetection, SecurityContext } from '@angular/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MarkdownPipe } from './markdown.pipe';

const API_BASE = 'http://backend.test/api';
const WORKTREE = '/tmp/repo';

describe('MarkdownPipe', () => {
  let pipe: MarkdownPipe;
  let sanitizer: DomSanitizer;

  beforeEach(() => {
    window.__ELEVENEX_RUNTIME__ = { apiBaseUrl: API_BASE };
    TestBed.configureTestingModule({
      providers: [provideZonelessChangeDetection(), MarkdownPipe],
    });
    pipe = TestBed.inject(MarkdownPipe);
    sanitizer = TestBed.inject(DomSanitizer);
  });

  afterEach(() => {
    delete window.__ELEVENEX_RUNTIME__;
  });

  function render(
    markdown: string,
    worktreePath?: string | null,
    sourcePath?: string | null,
  ): string {
    return (
      sanitizer.sanitize(SecurityContext.HTML, pipe.transform(markdown, worktreePath, sourcePath)) ??
      ''
    );
  }

  function imageSrc(
    markdown: string,
    worktreePath?: string | null,
    sourcePath?: string | null,
  ): string | null {
    const host = document.createElement('div');
    host.innerHTML = render(markdown, worktreePath, sourcePath);
    return host.querySelector('img')?.getAttribute('src') ?? null;
  }

  function rawUrl(relativePath: string): string {
    return `${API_BASE}/worktrees/${encodeURIComponent(WORKTREE)}/raw/${encodeURIComponent(
      relativePath,
    )}`;
  }

  it('renders headings, tables and fenced code', () => {
    const html = render(
      [
        '# Title',
        '',
        '## Section',
        '',
        '| A | B |',
        '| - | - |',
        '| 1 | 2 |',
        '',
        '```ts',
        'const x = 1;',
        '```',
      ].join('\n'),
    );

    expect(html).toContain('<h1>Title</h1>');
    expect(html).toContain('<h2>Section</h2>');
    expect(html).toContain('<table>');
    expect(html).toContain('<th>A</th>');
    expect(html).toContain('<td>1</td>');
    expect(html).toContain('language-ts');
  });

  it('resolves a relative image against the document’s own directory', () => {
    expect(imageSrc('![a](./img/a.png)', WORKTREE, 'docs/guide.md')).toBe(
      rawUrl('docs/img/a.png'),
    );
    expect(imageSrc('![a](img/a.png)', WORKTREE, 'docs/guide.md')).toBe(rawUrl('docs/img/a.png'));
  });

  it('walks out of the document’s directory for a parent-relative image', () => {
    expect(imageSrc('![a](../assets/a.png)', WORKTREE, 'docs/deep/guide.md')).toBe(
      rawUrl('docs/assets/a.png'),
    );
  });

  it('treats a leading slash as worktree-root-relative', () => {
    expect(imageSrc('![a](/assets/a.png)', WORKTREE, 'docs/guide.md')).toBe(
      rawUrl('assets/a.png'),
    );
  });

  it('resolves against the worktree root when no source path is given', () => {
    expect(imageSrc('![a](img/a.png)', WORKTREE)).toBe(rawUrl('img/a.png'));
  });

  it('drops a query string that would otherwise be read as part of the filename', () => {
    expect(imageSrc('![a](a.png?v=2)', WORKTREE, 'README.md')).toBe(rawUrl('a.png'));
  });

  it('leaves absolute and data URLs alone', () => {
    expect(imageSrc('![a](https://cdn.test/a.png)', WORKTREE, 'docs/guide.md')).toBe(
      'https://cdn.test/a.png',
    );
    expect(imageSrc('![a](//cdn.test/a.png)', WORKTREE, 'docs/guide.md')).toBe(
      '//cdn.test/a.png',
    );
    expect(imageSrc('![a](data:image/png;base64,AAA)', WORKTREE, 'docs/guide.md')).toBe(
      'data:image/png;base64,AAA',
    );
  });

  it('leaves images untouched when there is no worktree to resolve against', () => {
    expect(imageSrc('![a](img/a.png)')).toBe('img/a.png');
  });

  it('keeps the alt text and title', () => {
    const html = render('![Alt text](a.png "A title")', WORKTREE, 'README.md');
    expect(html).toContain('alt="Alt text"');
    expect(html).toContain('title="A title"');
  });

  it('renders a GFM task list with a marker that survives sanitising', () => {
    // Angular's sanitizer strips `<input>`, so marked's default checkbox would
    // leave nothing behind and a checklist would read as a plain list.
    const host = document.createElement('div');
    host.innerHTML = render('- [x] done\n- [ ] todo');
    const markers = Array.from(host.querySelectorAll('.cw-task'));

    expect(markers.map((marker) => marker.className)).toEqual([
      'cw-task cw-task--done',
      'cw-task cw-task--todo',
    ]);
    expect(markers.map((marker) => marker.textContent)).toEqual(['☑', '☐']);
  });

  it('strips scripts', () => {
    expect(render('<script>alert(1)</script>ok')).not.toContain('<script>');
  });
});
