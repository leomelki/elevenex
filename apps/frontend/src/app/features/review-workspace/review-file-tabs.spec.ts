import { describe, expect, it } from 'vitest';
import { isMarkdownPath } from './review-file-tabs.component';

describe('isMarkdownPath', () => {
  it('recognises markdown extensions', () => {
    expect(isMarkdownPath('README.md')).toBe(true);
    expect(isMarkdownPath('docs/guide.markdown')).toBe(true);
    expect(isMarkdownPath('docs/Guide.MD')).toBe(true);
    expect(isMarkdownPath('site/page.mdx')).toBe(true);
  });

  it('rejects everything else', () => {
    expect(isMarkdownPath('src/app.ts')).toBe(false);
    expect(isMarkdownPath('CHANGELOG')).toBe(false);
    // A path that merely contains ".md" is not a markdown file.
    expect(isMarkdownPath('src/md.ts')).toBe(false);
    expect(isMarkdownPath('notes.md.bak')).toBe(false);
  });
});
