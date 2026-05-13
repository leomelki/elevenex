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
  });
});
