import { describe, expect, it } from 'vitest';
import { groupPlanMarkdownBlocks, parsePlanMarkdownBlocks } from './plan-markdown-blocks';

describe('parsePlanMarkdownBlocks', () => {
  it('parses visible review blocks from plan markdown', () => {
    const blocks = parsePlanMarkdownBlocks(`# Title

Intro with \`mentioned\` text.

## Steps
- [x] Done
- Pending

> Risk callout

\`\`\`ts
const value = 1;
\`\`\`

| Area | Status |
| --- | --- |
| UI | Ready |
`);

    expect(blocks.map((block) => block.type)).toEqual([
      'heading',
      'paragraph',
      'heading',
      'list-item',
      'list-item',
      'blockquote',
      'code',
      'table',
    ]);
    expect(blocks[0]).toMatchObject({ content: 'Title', level: 1, startLine: 1 });
    expect(blocks[3]).toMatchObject({ content: 'Done', checked: true });
    expect(blocks[6]).toMatchObject({ content: 'const value = 1;', language: 'ts' });
  });

  it('strips frontmatter before parsing headings', () => {
    const blocks = parsePlanMarkdownBlocks(`---
title: Internal
---
# Public title`);

    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ type: 'heading', content: 'Public title', startLine: 1 });
  });

  it('groups consecutive list items for a single list visual block', () => {
    const blocks = parsePlanMarkdownBlocks(`Before

- First
- Second

After`);

    const groups = groupPlanMarkdownBlocks(blocks);

    expect(groups.map((group) => group.map((block) => block.type))).toEqual([
      ['paragraph'],
      ['list-item', 'list-item'],
      ['paragraph'],
    ]);
  });
});
