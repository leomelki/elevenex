import { parse } from 'smol-toml';
import type { McpConfigRecord } from './mcp-config.types.js';

/** Locate table blocks in an already validated document without treating string
 * contents or nested arrays as headers. Parsing each header retains TOML's own
 * handling of quoted/dotted keys; the scan is linear in the document size. */
export function tomlTableRanges(raw: string): {
  start: number;
  end: number;
  header: McpConfigRecord;
}[] {
  const tables: { start: number; end: number; header: McpConfigRecord }[] = [];
  let quote: string | null = null;
  let multiline = false;
  let depth = 0;
  let lineStart = 0;
  let leading = true;
  for (let index = 0; index < raw.length; index++) {
    const character = raw[index];
    if (character === '\n') {
      lineStart = index + 1;
      leading = true;
      continue;
    }
    if (quote) {
      if (quote === '"' && character === '\\') {
        // Escapes (including multiline line continuation) cannot close a string.
        if (raw[index + 1] !== '\n') index++;
      } else if (character === quote) {
        if (!multiline) quote = null;
        else if (raw.startsWith(quote.repeat(3), index)) {
          // Four/five quotes include one/two literal quotes before the delimiter.
          while (raw[index + 1] === quote) index++;
          quote = null;
        }
      }
      continue;
    }
    if (
      leading &&
      (character === ' ' || character === '\t' || character === '\r')
    )
      continue;
    if (leading && depth === 0 && character === '[') {
      const newline = raw.indexOf('\n', index);
      const end = newline < 0 ? raw.length : newline;
      const header = parse(
        `${raw.slice(index, end)}\n__elevenex_marker = true`,
      );
      if (tables.length) tables[tables.length - 1].end = lineStart;
      tables.push({ start: lineStart, end: raw.length, header });
      index = end - 1;
      leading = false;
      continue;
    }
    leading = false;
    if (character === '#') {
      const newline = raw.indexOf('\n', index);
      index = newline < 0 ? raw.length : newline - 1;
    } else if (character === '"' || character === "'") {
      quote = character;
      multiline = raw.startsWith(character.repeat(3), index);
      if (multiline) index += 2;
    } else if (character === '[' || character === '{') depth++;
    else if (character === ']' || character === '}') depth--;
  }
  return tables;
}
