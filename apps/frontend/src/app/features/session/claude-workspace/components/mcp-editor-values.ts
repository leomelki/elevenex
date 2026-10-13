/** Keep the common one-value-per-line form, using JSON strings for values that
 * would otherwise lose empty arguments, newlines or literal quotation marks. */
export function editorString(value: string): string {
  return !value || /[\r\n]/.test(value) || value.trimStart().startsWith('"')
    ? JSON.stringify(value)
    : value;
}

export function parseEditorString(value: string): string {
  if (!value.trimStart().startsWith('"')) return value;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error('Use a valid JSON string for a quoted value, for example "" or "line\\nnext".');
  }
  if (typeof parsed !== 'string') throw new Error('Each value must be a string.');
  return parsed;
}

export function editorArguments(values: string[]): string {
  return values.map(editorString).join('\n');
}

export function parseEditorArguments(value: string): string[] {
  return value
    .split(/\r?\n/)
    .filter((line) => line !== '')
    .map(parseEditorString);
}

export function editorPairs(values: Record<string, string> = {}): string {
  return Object.entries(values)
    .map(([key, value]) => `${key}=${editorString(value)}`)
    .join('\n');
}

export function parseEditorPairs(raw: string, label: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/).filter((line) => line.trim())) {
    const separator = line.indexOf('=');
    const key = line.slice(0, separator).trim();
    if (
      separator < 1 ||
      !key ||
      Object.hasOwn(result, key) ||
      ['__proto__', 'constructor', 'prototype'].includes(key)
    )
      throw new Error(`${label}: use one unique KEY=value pair per line.`);
    result[key] = parseEditorString(line.slice(separator + 1));
  }
  return result;
}
