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
    expect(blocks[0]).toMatchObject({ type: 'heading', content: 'Public title', startLine: 4 });
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

  it('merges wrapped list continuation lines into the previous item', () => {
    const blocks = parsePlanMarkdownBlocks(`- First item with text
  that continues here
- Second item`);

    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toMatchObject({
      type: 'list-item',
      content: 'First item with text\nthat continues here',
    });
    expect(blocks[1]).toMatchObject({ type: 'list-item', content: 'Second item' });
  });

  it('merges loose list continuation paragraphs without swallowing the next item', () => {
    const blocks = parsePlanMarkdownBlocks(`- First

  Body of first

- Second`);

    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toMatchObject({
      type: 'list-item',
      content: 'First\n\nBody of first',
    });
    expect(blocks[1]).toMatchObject({ type: 'list-item', content: 'Second' });
  });

  it('does not treat nested list items as continuation text', () => {
    const blocks = parsePlanMarkdownBlocks(`- Parent
  - Child
- Sibling`);

    expect(blocks).toHaveLength(3);
    expect(blocks[0]).toMatchObject({ type: 'list-item', content: 'Parent', level: 0 });
    expect(blocks[1]).toMatchObject({ type: 'list-item', content: 'Child', level: 1 });
    expect(blocks[2]).toMatchObject({ type: 'list-item', content: 'Sibling', level: 0 });
  });

  it('preserves ordered list start values', () => {
    const blocks = parsePlanMarkdownBlocks(`5. Five
6. Six
- Bullet`);

    expect(blocks).toHaveLength(3);
    expect(blocks[0]).toMatchObject({ ordered: true, orderedStart: 5 });
    expect(blocks[1]).toMatchObject({ ordered: true, orderedStart: 6 });
    expect(blocks[2]).toMatchObject({ ordered: false, orderedStart: undefined });
  });

  it('keeps block-level elements after list items separate', () => {
    const blocks = parsePlanMarkdownBlocks(`- Item
# Heading

> Quote

\`\`\`ts
const value = 1;
\`\`\``);

    expect(blocks.map((block) => block.type)).toEqual([
      'list-item',
      'heading',
      'blockquote',
      'code',
    ]);
  });
});
