import { MarkdownPipe, resolveLocalFileTarget } from '@/shared/agent-chat/markdown/markdown.pipe';
import { provideZonelessChangeDetection, SecurityContext } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { DomSanitizer } from '@angular/platform-browser';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

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

  it.each([
    ['/tmp/outside.png', '/tmp/outside.png'],
    ['~/Pictures/shot.png', '~/Pictures/shot.png'],
    ['file:///tmp/my%20shot.png', '/tmp/my shot.png'],
    ['C:/Users/me/shot.png', 'C:/Users/me/shot.png'],
    ['../outside.png', '/tmp/outside.png'],
    ['/tmp/repo/../outside.png', '/tmp/repo/../outside.png'],
  ])('resolves external chat image %s on the backend host', (href, path) => {
    expect(imageSrc(`![Shot](${href})`, WORKTREE)).toBe(
      `${API_BASE}/filesystem/media?path=${encodeURIComponent(path)}`,
    );
  });

  it('resolves absolute media without a checkout context', () => {
    expect(imageSrc('![Shot](/tmp/shot.png)')).toBe(
      `${API_BASE}/filesystem/media?path=%2Ftmp%2Fshot.png`,
    );
  });

  it('resolves external video sources and posters and preserves seek fragments', () => {
    const host = document.createElement('div');
    host.innerHTML = render(
      '<video poster="/tmp/poster.png"><source src="file:///tmp/demo.mp4#t=2"></video>',
      WORKTREE,
    );
    expect(host.querySelector('source')?.getAttribute('src')).toBe(
      `${API_BASE}/filesystem/media?path=%2Ftmp%2Fdemo.mp4#t=2`,
    );
    expect(host.querySelector('video')?.getAttribute('poster')).toBe(
      `${API_BASE}/filesystem/media?path=%2Ftmp%2Fposter.png`,
    );
  });

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

  function videoHost(markdown: string, sourcePath?: string): HTMLDivElement {
    const host = document.createElement('div');
    host.innerHTML = render(markdown, WORKTREE, sourcePath);
    return host;
  }

  it('embeds Markdown image and link video references with accessible controls', () => {
    const host = videoHost('![Demo](clips/demo.mp4)\n\n[Recording](clips/demo.webm)');
    const videos = Array.from(host.querySelectorAll('video'));
    expect(videos).toHaveLength(2);
    expect(videos.map((video) => video.getAttribute('src'))).toEqual([
      rawUrl('clips/demo.mp4'),
      rawUrl('clips/demo.webm'),
    ]);
    expect(videos.map((video) => video.getAttribute('aria-label'))).toEqual(['Demo', 'Recording']);
    for (const video of videos) {
      expect(video.hasAttribute('controls')).toBe(true);
      expect(video.hasAttribute('playsinline')).toBe(true);
      expect(video.getAttribute('preload')).toBe('metadata');
      expect(video.hasAttribute('autoplay')).toBe(false);
    }
  });

  it('resolves HTML video sources and posters relative to the document', () => {
    const host = videoHost(
      '<video poster="./poster.png" width="480" autoplay onplay="alert(1)">' +
        '<source src="../clips/demo.mp4#t=2,5" type="video/mp4">' +
        '<source src="https://cdn.test/demo.webm" type="video/webm"></video>',
      'docs/guide.md',
    );
    const video = host.querySelector('video')!;
    expect(video.getAttribute('poster')).toBe(rawUrl('docs/poster.png'));
    expect(video.getAttribute('width')).toBe('480');
    expect(video.hasAttribute('autoplay')).toBe(false);
    expect(video.hasAttribute('onplay')).toBe(false);
    expect(
      Array.from(video.querySelectorAll('source')).map((source) => source.getAttribute('src')),
    ).toEqual([`${rawUrl('clips/demo.mp4')}#t=2,5`, 'https://cdn.test/demo.webm']);
    expect(video.querySelector('source')?.getAttribute('type')).toBe('video/mp4');
  });

  it('supports absolute local HTML videos and encoded Markdown filenames', () => {
    expect(
      videoHost(`<video src="${WORKTREE}/clips/demo.mp4"></video>`)
        .querySelector('video')
        ?.getAttribute('src'),
    ).toBe(rawUrl('clips/demo.mp4'));
    expect(
      videoHost('![Demo](<clips/my demo.MP4>)').querySelector('video')?.getAttribute('src'),
    ).toBe(rawUrl('clips/my demo.MP4'));
    expect(
      videoHost('![Demo](clips/demo.mp4#t=2)').querySelector('video')?.getAttribute('src'),
    ).toBe(`${rawUrl('clips/demo.mp4')}#t=2`);
  });

  it('preserves remote URLs and does not require a worktree for video embeds', () => {
    const host = document.createElement('div');
    host.innerHTML = render('![Demo](https://cdn.test/demo.mp4?token=123#t=2)');
    expect(host.querySelector('video')?.getAttribute('src')).toBe(
      'https://cdn.test/demo.mp4?token=123#t=2',
    );
    host.innerHTML = render('<video src="demo.webm"></video>');
    expect(host.querySelector('video')?.getAttribute('src')).toBe('demo.webm');
  });

  it('keeps ordinary links, images and code examples unchanged', () => {
    const host = videoHost(
      '[Doc](guide.md)\n\n![Image](shot.png?name=demo.mp4)\n\n' +
        '`![Demo](demo.mp4)`\n\n```html\n<video src="demo.mp4"></video>\n```',
    );
    expect(host.querySelectorAll('video')).toHaveLength(0);
    expect(host.querySelector('a')?.textContent).toBe('Doc');
    expect(host.querySelector('img')?.getAttribute('src')).toBe(rawUrl('shot.png'));
    expect(host.querySelector('pre')?.textContent).toContain('<video');
  });

  it('does not bypass sanitization of player attributes, fallback HTML or surrounding content', () => {
    const host = videoHost(
      '<video src="javascript:alert(1)" poster="javascript:alert(2)" ' +
        'style="position:fixed" onerror="alert(3)">' +
        '<source src="data:text/html,evil"><img src="x" onerror="alert(4)"></video>' +
        '<script>alert(5)</script><iframe src="https://evil.test"></iframe>' +
        '<a href="javascript:alert(6)">bad link</a><img src="x" onerror="alert(7)">',
    );
    const video = host.querySelector('video')!;
    expect(video.hasAttribute('src')).toBe(false);
    expect(video.hasAttribute('poster')).toBe(false);
    expect(video.hasAttribute('style')).toBe(false);
    expect(video.querySelectorAll('source, img')).toHaveLength(0);
    expect(host.querySelectorAll('script, iframe, [onerror]')).toHaveLength(0);
    expect(host.innerHTML).not.toContain('javascript:');
  });
});
