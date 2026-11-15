function redirectsWorkspace(key: string): boolean {
  const name = key.toLowerCase();
  // An inherited include could reintroduce core.worktree indirectly. Includes
  // in system/global/repository config files still follow Git's normal rules.
  return (
    name === 'core.worktree' ||
    name === 'include.path' ||
    (name.startsWith('includeif.') && name.endsWith('.path'))
  );
}

function invalidConfiguration(): never {
  // Values can contain credentials: never include the input in an error.
  throw new Error('Invalid inherited Git command configuration.');
}

/** Git's single-quoted environment encoding; this never evaluates shell text. */
function quotedValue(
  text: string,
  start: number,
): { value: string; end: number } {
  if (text[start] !== "'") return invalidConfiguration();
  let value = '';
  for (let index = start + 1; index < text.length; index++) {
    if (text[index] !== "'") {
      value += text[index];
      continue;
    }
    if (
      text[index + 1] === '\\' &&
      (text[index + 2] === "'" || text[index + 2] === '!') &&
      text[index + 3] === "'"
    ) {
      value += text[index + 2];
      index += 3;
      continue;
    }
    return { value, end: index + 1 };
  }
  return invalidConfiguration();
}

function filterParameters(text: string): string {
  const retained: string[] = [];
  let changed = false;
  let cursor = 0;
  while (cursor < text.length) {
    const start = cursor;
    const token = quotedValue(text, cursor);
    cursor = token.end;
    let key = token.value.split('=', 1)[0];
    if (text[cursor] === '=') {
      // Git supports both the older 'key=value' and newer 'key'='value'
      // encodings. Preserve the original encoding for older Git versions.
      key = token.value;
      cursor++;
      if (text[cursor] === "'") cursor = quotedValue(text, cursor).end;
    }
    if (cursor < text.length && !/\s/.test(text[cursor]))
      invalidConfiguration();
    if (redirectsWorkspace(key)) changed = true;
    else retained.push(text.slice(start, cursor));
    while (cursor < text.length && /\s/.test(text[cursor])) cursor++;
  }
  return changed ? retained.join(' ') : text;
}

/** Filter only workspace redirection, preserving other command-scope config. */
export function filterGitCommandConfiguration(env: NodeJS.ProcessEnv): void {
  const rawCount = env.GIT_CONFIG_COUNT;
  if (rawCount !== undefined && rawCount !== '') {
    if (!/^[\t\n\v\f\r ]*\+?\d+$/.test(rawCount)) invalidConfiguration();
    const count = Number(rawCount);
    // Each active pair needs two environment entries. Bound work by the
    // actual environment size rather than trusting an inherited count.
    if (!Number.isSafeInteger(count) || count > Object.keys(env).length / 2)
      invalidConfiguration();
    const retained: { key: string; value: string }[] = [];
    let changed = false;
    for (let index = 0; index < count; index++) {
      const key = env[`GIT_CONFIG_KEY_${index}`];
      const value = env[`GIT_CONFIG_VALUE_${index}`];
      if (key === undefined || value === undefined) invalidConfiguration();
      if (redirectsWorkspace(key)) changed = true;
      else retained.push({ key, value });
    }
    if (changed) {
      for (const key of Object.keys(env))
        if (/^GIT_CONFIG_(KEY|VALUE)_\d+$/.test(key)) delete env[key];
      delete env.GIT_CONFIG_COUNT;
      if (retained.length) env.GIT_CONFIG_COUNT = String(retained.length);
      retained.forEach(({ key, value }, index) => {
        env[`GIT_CONFIG_KEY_${index}`] = key;
        env[`GIT_CONFIG_VALUE_${index}`] = value;
      });
    }
  }
  if (env.GIT_CONFIG_PARAMETERS) {
    const parameters = filterParameters(env.GIT_CONFIG_PARAMETERS);
    if (parameters) env.GIT_CONFIG_PARAMETERS = parameters;
    else delete env.GIT_CONFIG_PARAMETERS;
  }
}
