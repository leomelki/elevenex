import { describe, expect, it } from 'vitest';
import {
  resolveVisualizationNavigation,
  resolveVisualizationTarget,
  splitMarkdownVisualizations,
} from './markdown-visualization';

const embed = (path: string) => `visualize${JSON.stringify({ path })}`;

describe('visualization directives', () => {
  it('recognizes the attached Codex session format between Markdown blocks', () => {
    const path =
      '/Users/leomelki/Documents/git/elevenex/artifacts/token-usage-20261012/tokens-cout-72h.html';
    const parts = splitMarkdownVisualizations(`# Usage\n\n${embed(path)}\n\nEstimated **cost**.`);
    expect(parts.map((part) => part.kind)).toEqual(['markdown', 'visualization', 'markdown']);
    expect(parts[1]).toMatchObject({ path });
  });

  it('keeps stable, distinct keys for repeated artifacts while text streams', () => {
    const content = `${embed('chart.html')}\n\n${embed('chart.html')}`;
    const first = splitMarkdownVisualizations(content).filter(
      (part) => part.kind === 'visualization',
    );
    const next = splitMarkdownVisualizations(`${content}\n\nMore text`).filter(
      (part) => part.kind === 'visualization',
    );
    expect(first.map((part) => part.key)).toEqual(next.map((part) => part.key));
    expect(new Set(first.map((part) => part.key)).size).toBe(2);
  });

  it.each([
    `\`${embed('chart.html')}\``,
    `\`\`\`text\n${embed('chart.html')}\n\`\`\``,
    `    ${embed('chart.html')}`,
    `<pre>\n${embed('chart.html')}\n</pre>`,
    'visualize{"path":"chart.html"',
    'visualizenot-json',
    'visualize{"path":42}',
    'visualize{"path":""}',
  ])('preserves literal, incomplete or malformed content: %s', (content) => {
    expect(splitMarkdownVisualizations(content).every((part) => part.kind === 'markdown')).toBe(
      true,
    );
  });

  it('retains reference links defined on the other side of an embed', () => {
    const parts = splitMarkdownVisualizations(
      `[Pricing][api]\n\n${embed('chart.html')}\n\n[api]: https://example.test/pricing`,
    );
    const first = parts[0];
    expect(first.kind).toBe('markdown');
    if (first.kind === 'markdown' && typeof first.content !== 'string') {
      expect(first.content.links['api'].href).toBe('https://example.test/pricing');
    }
  });
});

describe('visualization navigation', () => {
  const prefix = 'https://backend.test/api/review-preview/p/capability/';
  it('resolves HTML and index links with URL parameters and escaped file names', () => {
    expect(resolveVisualizationNavigation('folder/my%20chart.html?x=1#detail', prefix)).toEqual({
      path: 'folder/my chart.html',
      search: '?x=1',
      hash: '#detail',
    });
    expect(resolveVisualizationNavigation('./', prefix)).toEqual({
      path: '',
      search: '',
      hash: '',
    });
    expect(resolveVisualizationNavigation('folder/', prefix)).toEqual({
      path: 'folder/',
      search: '',
      hash: '',
    });
  });
  it.each([
    'https://evil.test/chart.html',
    '//evil.test/chart.html',
    'javascript:alert(1)',
    'https://backend.test/api/files/chart.html',
    '../other/chart.html',
    '%2e%2e/other/chart.html',
    '..%2fother.html',
    '..%5cother.html',
    'folder/..%2f..%2fother.html',
    'https://backend.test/api/review-preview/p/capability-other/chart.html',
    'https://user:password@backend.test/api/review-preview/p/capability/chart.html',
    'data.json',
    'bad%zz.html',
    'bad%00.html',
  ])('rejects capability escapes and unsupported targets: %s', (href) => {
    expect(resolveVisualizationNavigation(href, prefix)).toBeNull();
  });
});

describe('visualization file resolution', () => {
  it.each([
    ['/tmp/other/chart.html', null, null, '/tmp/other', 'chart.html'],
    ['charts/cost.html', '/tmp/repo', null, '/tmp/repo/charts', 'cost.html'],
    ['./cost.html', '/tmp/repo', 'docs/readme.md', '/tmp/repo/docs/.', 'cost.html'],
    ['../cost.html', '/tmp/repo', null, '/tmp/repo/..', 'cost.html'],
    ['file:///tmp/my%20chart.html', null, null, '/tmp', 'my chart.html'],
    ['C:\\Users\\me\\chart.html', null, null, 'C:/Users/me', 'chart.html'],
    ['~/artifacts/chart.html', null, null, '~/artifacts', 'chart.html'],
  ])(
    'resolves %s as a directory-scoped capability',
    (path, root, source, expectedRoot, expectedPath) => {
      expect(resolveVisualizationTarget(path!, root, source)).toEqual({
        root: expectedRoot,
        path: expectedPath,
      });
    },
  );

  it.each([
    'https://evil.test/chart.html',
    '//evil.test/chart.html',
    'javascript:alert(1)',
    'data:text/html,hi',
    'file://evil.test/tmp/chart.html',
    '/tmp/data.json',
    '/tmp/\0chart.html',
  ])('rejects %s', (path) => {
    expect(resolveVisualizationTarget(path, '/tmp/repo', null)).toBeNull();
  });

  it('requires checkout context for relative paths', () => {
    expect(resolveVisualizationTarget('chart.html', null, null)).toBeNull();
  });
});
