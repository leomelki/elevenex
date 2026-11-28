import type { IBuffer } from '@xterm/xterm';

export interface TerminalMatch {
  readonly row: number;
  readonly col: number;
  readonly length: number;
}

/** Search retained logical lines, preserving physical cell coordinates for selection. */
export function findTerminalMatches(buffer: IBuffer, needle: string, cols: number): readonly TerminalMatch[] {
  const matches: TerminalMatch[] = [];
  if (!needle) return matches;
  let text = '';
  let starts: number[] = [];
  let ends: number[] = [];
  for (let row = 0; row < buffer.length && matches.length < 1000; row++) {
    const line = buffer.getLine(row);
    if (!line) continue;
    let end = line.length;
    // Empty padding is not text (a wide character may wrap before the final cell).
    // Explicitly written spaces remain searchable.
    while (end && line.getCell(end - 1)?.getCode() === 0) end--;
    for (let column = 0; column < end; column++) {
      const cell = line.getCell(column);
      if (!cell || !cell.getWidth()) continue;
      const value = (cell.getChars() || ' ').toLocaleLowerCase();
      text += value;
      for (let unit = 0; unit < value.length; unit++) {
        starts.push(row * cols + column);
        ends.push(row * cols + column + cell.getWidth());
      }
    }
    if (buffer.getLine(row + 1)?.isWrapped) continue;
    let from = 0;
    let offset: number;
    while (matches.length < 1000 && (offset = text.indexOf(needle, from)) >= 0) {
      const start = starts[offset]!;
      matches.push({ row: Math.floor(start / cols), col: start % cols,
        length: ends[offset + needle.length - 1]! - start });
      from = offset + needle.length;
    }
    text = '';
    starts = [];
    ends = [];
  }
  return matches;
}
