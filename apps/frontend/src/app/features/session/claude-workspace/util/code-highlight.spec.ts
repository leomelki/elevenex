import { describe, expect, it } from 'vitest';
import {
  highlightedPatchHtml,
  highlightedUnifiedDiffHtml,
} from './code-highlight';

describe('code-highlight diff line numbers', () => {
  it('offsets edit hunks when start lines are provided', () => {
    const html = highlightedUnifiedDiffHtml(
      'const a = 1;\nconst b = 2;',
      'const a = 1;\nconst b = 3;',
      'src/app.ts',
      { oldStartLine: 41, newStartLine: 41 },
    );

    expect(html).toContain('cw-diff-ln--old">41<');
    expect(html).toContain('cw-diff-ln--new">42<');
  });

  it('renders similar edit lines as one inline change row', () => {
    const html = highlightedUnifiedDiffHtml(
      'const total = previous + 1;',
      'const total = next + 1;',
      'src/app.ts',
    );

    expect(html).toContain('cw-diff-change');
    expect(html).toContain('diff-inline-del');
    expect(html).toContain('diff-inline-add');
    expect(html).not.toContain('cw-diff-del');
    expect(html).not.toContain('cw-diff-add');
  });

  it('keeps unrelated edit lines split', () => {
    const html = highlightedUnifiedDiffHtml('one', 'zzzzzzzzzzzzzzzz', 'README.md');

    expect(html).not.toContain('cw-diff-change');
    expect(html).toContain('cw-diff-del');
    expect(html).toContain('cw-diff-add');
  });

  it('uses unified patch hunk headers for line numbers', () => {
    const html = highlightedPatchHtml([
      '@@ -12,2 +12,2 @@',
      ' const a = 1;',
      '-const b = 2;',
      '+const b = 3;',
    ].join('\n'));

    expect(html).toContain('cw-diff-ln--old">12<');
    expect(html).toContain('cw-diff-ln--new">12<');
    expect(html).toContain('cw-diff-ln--old">13<');
    expect(html).toContain('cw-diff-ln--new">13<');
    expect(html).toContain('cw-diff-change');
    expect(html).toContain('diff-inline-del');
    expect(html).toContain('diff-inline-add');
  });
});
