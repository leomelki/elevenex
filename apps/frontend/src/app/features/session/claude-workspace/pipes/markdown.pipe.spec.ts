import { TestBed } from '@angular/core/testing';
import { DomSanitizer } from '@angular/platform-browser';
import { provideZonelessChangeDetection, SecurityContext } from '@angular/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MarkdownPipe, resolveLocalFileTarget } from './markdown.pipe';

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
      sanitizer.sanitize(
        SecurityContext.HTML,
        pipe.transform(markdown, worktreePath, sourcePath),
      ) ?? ''
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
    expect(imageSrc('![a](./img/a.png)', WORKTREE, 'docs/guide.md')).toBe(rawUrl('docs/img/a.png'));
    expect(imageSrc('![a](img/a.png)', WORKTREE, 'docs/guide.md')).toBe(rawUrl('docs/img/a.png'));
  });

  it('walks out of the document’s directory for a parent-relative image', () => {
    expect(imageSrc('![a](../assets/a.png)', WORKTREE, 'docs/deep/guide.md')).toBe(
      rawUrl('docs/assets/a.png'),
    );
  });

  it('treats a leading slash as worktree-root-relative', () => {
    expect(imageSrc('![a](/assets/a.png)', WORKTREE, 'docs/guide.md')).toBe(rawUrl('assets/a.png'));
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
    expect(imageSrc('![a](//cdn.test/a.png)', WORKTREE, 'docs/guide.md')).toBe('//cdn.test/a.png');
    expect(imageSrc('![a](data:image/png;base64,AAA)', WORKTREE, 'docs/guide.md')).toBe(
      'data:image/png;base64,AAA',
    );
  });

  it('leaves images untouched when there is no worktree to resolve against', () => {
    expect(imageSrc('![a](img/a.png)')).toBe('img/a.png');
  });

  it('resolves raw HTML images the same way as markdown ones', () => {
    // Documents size images with `<img width>`; left alone, the browser would
    // look for the file next to the app instead of in the worktree.
    const host = document.createElement('div');
    host.innerHTML = render(
      '<img src="./img/a.png" width="240" alt="Diagram">',
      WORKTREE,
      'docs/guide.md',
    );
    const image = host.querySelector('img');

    expect(image?.getAttribute('src')).toBe(rawUrl('docs/img/a.png'));
    expect(image?.getAttribute('width')).toBe('240');
  });

  it('reads an absolute path inside the worktree as that worktree file', () => {
    expect(imageSrc(`![a](${WORKTREE}/docs/shot.png)`, WORKTREE, 'notes/plan.md')).toBe(
      rawUrl('docs/shot.png'),
    );
    // Sessions store their worktree with a trailing slash.
    expect(imageSrc(`![a](${WORKTREE}/docs/shot.png)`, `${WORKTREE}/`, 'notes/plan.md')).toContain(
      `/raw/${encodeURIComponent('docs/shot.png')}`,
    );
  });

  it('encodes a filename with spaces exactly once however it is written', () => {
    expect(imageSrc('![a](<my shot.png>)', WORKTREE, 'README.md')).toBe(rawUrl('my shot.png'));
    expect(imageSrc('![a](my%20shot.png)', WORKTREE, 'README.md')).toBe(rawUrl('my shot.png'));
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

  it('marks worktree file links with editor targets and source positions', () => {
    const host = document.createElement('div');
    host.innerHTML = render(`[component](${WORKTREE}/src/app.component.ts:42:7)`, WORKTREE);
    const anchor = host.querySelector('a');

    expect(anchor?.classList.contains('cw-local-file-link')).toBe(true);
    expect(resolveLocalFileTarget(anchor?.getAttribute('href') ?? '', WORKTREE)).toEqual({
      path: 'src/app.component.ts',
      line: 42,
      column: 7,
    });
  });

  it('resolves repository-relative links and GitHub-style line fragments', () => {
    expect(resolveLocalFileTarget('../src/app.ts#L12C3', WORKTREE, 'docs/guide.md')).toEqual({
      path: 'src/app.ts',
      line: 12,
      column: 3,
    });
    expect(resolveLocalFileTarget('src/app.ts', WORKTREE)).toEqual({ path: 'src/app.ts' });
  });

  it('does not turn external or out-of-worktree absolute links into editor targets', () => {
    expect(resolveLocalFileTarget('https://example.com/file.ts', WORKTREE)).toBeNull();
    expect(resolveLocalFileTarget('/tmp/another-repo/file.ts:4', WORKTREE)).toBeNull();
    expect(resolveLocalFileTarget('../../outside.ts', WORKTREE, 'docs/guide.md')).toBeNull();
  });

  it('supports Windows worktree paths without treating the drive letter as a URL scheme', () => {
    expect(resolveLocalFileTarget('C:\\repo\\src\\app.ts:9', 'C:\\repo')).toEqual({
      path: 'src/app.ts',
      line: 9,
    });
    expect(resolveLocalFileTarget('D:\\other\\app.ts:9', 'C:\\repo')).toBeNull();
  });

  it('strips scripts', () => {
    expect(render('<script>alert(1)</script>ok')).not.toContain('<script>');
  });
});
