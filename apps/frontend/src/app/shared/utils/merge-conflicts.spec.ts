import { describe, expect, it } from 'vitest';
import {
  applyConflictResolution,
  parseConflictBlocks,
} from './merge-conflicts';

describe('merge conflict utilities', () => {
  it('parses standard conflict markers', () => {
    const content = [
      'before',
      '<<<<<<< HEAD',
      'current',
      '=======',
      'incoming',
      '>>>>>>> feature',
      'after',
      '',
    ].join('\n');

    const blocks = parseConflictBlocks(content);

    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      startLine: 2,
      endLine: 6,
      oursLabel: 'HEAD',
      theirsLabel: 'feature',
      base: null,
    });
    expect(blocks[0].ours.content).toEqual(['current']);
    expect(blocks[0].theirs.content).toEqual(['incoming']);
  });

  it('parses diff3 conflict markers', () => {
    const content = [
      '<<<<<<< ours',
      'current',
      '||||||| base',
      'original',
      '=======',
      'incoming',
      '>>>>>>> theirs',
    ].join('\n');

    const [block] = parseConflictBlocks(content);

    expect(block.baseLabel).toBe('base');
    expect(block.base?.content).toEqual(['original']);
    expect(block.ours.content).toEqual(['current']);
    expect(block.theirs.content).toEqual(['incoming']);
  });

  it('applies current, incoming, and both resolutions without touching surrounding content', () => {
    const content = [
      'before',
      '<<<<<<< HEAD',
      'current',
      '=======',
      'incoming',
      '>>>>>>> feature',
      'after',
      '',
    ].join('\n');
    const [block] = parseConflictBlocks(content);

    expect(applyConflictResolution(content, block, 'current')).toBe('before\ncurrent\nafter\n');
    expect(applyConflictResolution(content, block, 'incoming')).toBe('before\nincoming\nafter\n');
    expect(applyConflictResolution(content, block, 'both')).toBe('before\ncurrent\nincoming\nafter\n');
  });
});
