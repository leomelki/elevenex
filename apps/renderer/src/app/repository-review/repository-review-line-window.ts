import type { DiffHunk } from "../views";

/** Merge wire pages at a hunk boundary while retaining stable line identities. */
export function lineCount(hunks: readonly DiffHunk[]): number {
  return hunks.reduce((total, hunk) => total + hunk.lines.length, 0);
}
export function mergeHunks(
  left: readonly DiffHunk[],
  right: readonly DiffHunk[],
): readonly DiffHunk[] {
  const last = left.at(-1),
    first = right[0];
  if (!last || !first || last.id !== first.id) return [...left, ...right];
  return [
    ...left.slice(0, -1),
    { ...last, after: first.after, lines: [...last.lines, ...first.lines] },
    ...right.slice(1),
  ];
}
export function sliceHunks(
  hunks: readonly DiffHunk[],
  start: number,
  end: number,
): readonly DiffHunk[] {
  let skipped = 0;
  return hunks.flatMap((hunk) => {
    const from = Math.max(0, start - skipped),
      until = Math.min(hunk.lines.length, end - skipped);
    skipped += hunk.lines.length;
    return until > from
      ? [
          {
            ...hunk,
            lines: hunk.lines.slice(from, until),
            before: from === 0 ? hunk.before : undefined,
            after: until === hunk.lines.length ? hunk.after : undefined,
          },
        ]
      : [];
  });
}
