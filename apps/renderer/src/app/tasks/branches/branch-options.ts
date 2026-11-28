import { WORKSPACE_BRANCH_NAME_LIMIT } from '@elevenex/shared';
import type { BranchInfo, BranchRow } from '../task.models';

export function branchFromTitle(title: string, prefix = ''): string {
  const slug = title
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/g, '');
  return slug ? prefix + slug : '';
}

/** Mirrors git-check-ref-format's branch restrictions without running git in the renderer. */
export function validBranchName(name: string): boolean {
  const forbidden = '~^:?*[\\';
  const hasForbiddenCharacter = Array.from(name).some(
    (character) =>
      character.charCodeAt(0) <= 32 ||
      character.charCodeAt(0) === 127 ||
      forbidden.includes(character),
  );
  return (
    !!name &&
    name.length <= WORKSPACE_BRANCH_NAME_LIMIT &&
    name !== '@' &&
    !name.startsWith('-') &&
    !name.startsWith('/') &&
    !name.endsWith('/') &&
    !name.endsWith('.') &&
    !hasForbiddenCharacter &&
    !name.includes('..') &&
    !name.includes('@{') &&
    !name.includes('//') &&
    name
      .split('/')
      .every((part) => !part.startsWith('.') && !part.endsWith('.lock'))
  );
}

export function branchRef(branch: BranchInfo): string {
  return branch.ref ?? branch.name;
}

export function shortBranchName(ref: string): string {
  return ref.replace(/^refs\/(heads|remotes)\//, '');
}

export function branchItems(
  query: string,
  branches: readonly BranchInfo[],
  allowCreate = false,
): readonly BranchRow[] {
  const text = query.trim();
  const lower = text.toLowerCase();
  const fullRef = /^refs\/(heads|remotes)\//.test(lower);
  const words = lower.split(/[\s/_-]+/).filter(Boolean);
  const matches = branches.filter((branch) =>
    fullRef
      ? (branch.ref ?? branch.name).toLowerCase().startsWith(lower)
      : words.every((word) => branch.name.toLowerCase().includes(word)),
  );
  const score = (branch: BranchInfo): number => {
    const name = (fullRef ? branchRef(branch) : branch.name).toLowerCase();
    const remoteBranch = branch.remoteBranch?.toLowerCase();
    if (name === lower) return 0;
    if (remoteBranch === lower) return 1;
    if (branch.isDefault) return 2;
    return name.startsWith(lower) || remoteBranch?.startsWith(lower) ? 3 : 4;
  };
  const rows: BranchRow[] = matches
    .sort((a, b) => score(a) - score(b))
    .map((branch) => ({ ...branch, kind: 'branch' }));
  if (allowCreate && text && !fullRef &&
      !branches.some(branch => branch.name === text || branch.remoteBranch === text))
    rows.unshift({
      kind: validBranchName(text) ? 'create' : 'invalid',
      name: text,
    });
  return rows.slice(0, 7);
}

export function selectableBranch(row: BranchRow, allowHeld = false): boolean {
  return row.kind !== 'invalid' && (allowHeld || !row.task);
}

export function branchHighlights(
  text: string,
  query: string,
): readonly { readonly text: string; readonly match: boolean }[] {
  const words = shortBranchName(query)
    .toLowerCase()
    .split(/[\s/_-]+/)
    .filter(Boolean);
  if (!words.length) return [{ text, match: false }];
  const expression = new RegExp(
    `(${words.map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`,
    'ig',
  );
  return text
    .split(expression)
    .map((part, index) => ({ text: part, match: index % 2 === 1 }));
}
