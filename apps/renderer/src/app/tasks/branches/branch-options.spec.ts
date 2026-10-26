import { describe, expect, it } from 'vitest';
import {
  branchFromTitle,
  branchHighlights,
  branchItems,
  validBranchName,
} from './branch-options';

describe('branch choices', () => {
  it('matches every word, keeps recent input order, and promotes the default', () => {
    const branches = [
      { name: 'fix/refund-rate', when: 'now' },
      { name: 'fix/rate-refund', isDefault: true },
      { name: 'fix/refund' },
    ];
    expect(branchItems('rate refund', branches).map((row) => row.name)).toEqual(
      ['fix/rate-refund', 'fix/refund-rate'],
    );
    expect(branchItems('', branches)[0]?.isDefault).toBe(true);
    expect(branches[0]?.name).toBe('fix/refund-rate');
  });
  it('caps results, offers new names, and never offers an existing held name for creation', () => {
    expect(
      branchItems(
        'topic',
        Array.from({ length: 20 }, (_, index) => ({ name: `topic-${index}` })),
        true,
      ),
    ).toHaveLength(7);
    expect(branchItems('feature/new', [], true)).toEqual([
      { kind: 'create', name: 'feature/new' },
    ]);
    expect(
      branchItems(
        'feature/held',
        [{ name: 'feature/held', task: 'Other task' }],
        true,
      ),
    ).toEqual([{ kind: 'branch', name: 'feature/held', task: 'Other task' }]);
  });
  it.each([
    'bad name',
    'bad..name',
    '/leading',
    'trailing/',
    '.hidden',
    'feature/.hidden',
    'feature/name.lock',
    '@',
    'name@{one}',
    'name\\part',
    'name[one',
    'name.',
    '-name',
  ])('rejects invalid git branch %s', (name) => {
    expect(validBranchName(name)).toBe(false);
    expect(branchItems(name, [], true)[0]?.kind).toBe('invalid');
  });
  it('infers an accented task title and keeps the branch slug bounded', () => {
    expect(branchFromTitle(' Réparer: rate-limit refunds! ', 'leo/')).toBe(
      'leo/reparer-rate-limit-refunds',
    );
    expect(branchFromTitle('x'.repeat(80))).toHaveLength(48);
    expect(branchFromTitle('?!', 'leo/')).toBe('');
  });
  it('highlights literal query text without changing the branch name', () => {
    const parts = branchHighlights('feature/refund-rate', 'refund rate');
    expect(parts.filter((part) => part.match).map((part) => part.text)).toEqual(
      ['refund', 'rate'],
    );
    expect(parts.map((part) => part.text).join('')).toBe('feature/refund-rate');
  });
});
