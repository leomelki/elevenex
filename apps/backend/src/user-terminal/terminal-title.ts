const MAX_TITLE = 120;

/** Display-only metadata. Never use a terminal title as a command or permission. */
export function reportedTerminalTitle(raw: string): string | null {
  if (raw.length > 1024 || /[\uD800-\uDFFF]/u.test(raw)) return null;
  // Keep terminal controls, line separators and directional overrides out of
  // tabs/tooltips. A process may change its title, never the surrounding UI.
  const title = raw
    // eslint-disable-next-line no-control-regex -- Strip untrusted terminal title controls.
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  let bounded = title.slice(0, MAX_TITLE);
  if (/[\uD800-\uDBFF]$/.test(bounded)) bounded = bounded.slice(0, -1);
  return bounded || null;
}

/** A conservative leading literal executable name, with no arguments. This is
 * a command label, not foreground-process discovery or a shell parser. Quoted
 * heads, expansions and assignments fall back to the saved shell name. */
export function commandTerminalTitle(command: string | null): string | null {
  if (!command) return null;
  const word = /^\s*([a-zA-Z0-9_./:@%+,\\-]+)(?=$|\s|[;&|<>])/.exec(
    command,
  )?.[1];
  if (!word) return null;
  const name = word.split(/[\\/]/).at(-1);
  return name ? reportedTerminalTitle(name) : null;
}
