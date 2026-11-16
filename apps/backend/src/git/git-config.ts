/**
 * Parses `git config --get-regexp <pattern>` output into booleans keyed by
 * lower-case config key, following Git's rules: a later value wins, a key
 * without `=` is true, an empty value is false, integers are true when
 * non-zero, and anything else (such as `core.untrackedCache=keep`) is
 * `undefined`. Keys absent from the output are absent from the map.
 *
 * `--get-regexp` exits with status 1 and no output when nothing matches,
 * which simple-git resolves as an empty string, so no special case is needed.
 */
export function parseBooleanConfig(
  output: string,
): Map<string, boolean | undefined> {
  const values = new Map<string, boolean | undefined>();
  for (const line of output.split('\n')) {
    if (!line.trim()) continue;
    const space = line.indexOf(' ');
    const key = (space === -1 ? line : line.slice(0, space)).toLowerCase();
    const raw =
      space === -1
        ? null
        : line
            .slice(space + 1)
            .trim()
            .toLowerCase();
    values.set(key, parseGitBoolean(raw));
  }
  return values;
}

function parseGitBoolean(raw: string | null): boolean | undefined {
  if (raw === null) return true;
  if (raw === '' || raw === 'false' || raw === 'no' || raw === 'off') {
    return false;
  }
  if (raw === 'true' || raw === 'yes' || raw === 'on') return true;
  if (/^-?\d+$/.test(raw)) return Number(raw) !== 0;
  return undefined;
}
