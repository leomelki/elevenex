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

export function branchItems(
  query: string,
  branches: readonly BranchInfo[],
  allowCreate = false,
): readonly BranchRow[] {
  const text = query.trim();
  const lower = text.toLowerCase();
  const words = lower.split(/[\s/_-]+/).filter(Boolean);
  const matches = branches.filter((branch) =>
    words.every((word) => branch.name.toLowerCase().includes(word)),
  );
  const score = (branch: BranchInfo): number =>
    branch.name.toLowerCase() === lower
      ? 0
      : (branch.isDefault ? 1 : 2) +
        (branch.name.toLowerCase().startsWith(lower) ? 0 : 2);
  const rows: BranchRow[] = matches
    .sort((a, b) => score(a) - score(b))
    .map((branch) => ({ ...branch, kind: 'branch' }));
  if (allowCreate && text && !branches.some((branch) => branch.name === text))
    rows.unshift({
      kind: validBranchName(text) ? 'create' : 'invalid',
      name: text,
    });
  return rows.slice(0, 7);
}

export function selectableBranch(row: BranchRow): boolean {
  return row.kind !== 'invalid' && !row.task;
}

export function branchHighlights(
  text: string,
  query: string,
): readonly { readonly text: string; readonly match: boolean }[] {
  const words = query
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
