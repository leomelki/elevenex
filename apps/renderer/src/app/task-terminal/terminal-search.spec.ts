import { Terminal } from '@xterm/xterm';
import { findTerminalMatches } from './terminal-search';

vi.hoisted(() => { vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null); });
afterAll(() => vi.restoreAllMocks());

async function withTerminal(data: string, check: (terminal: Terminal) => void): Promise<void> {
  const terminal = new Terminal({ cols: 10, rows: 4, scrollback: 2000 });
  try {
    await new Promise<void>(resolve => terminal.write(data, resolve));
    check(terminal);
  } finally { terminal.dispose(); }
}

it('finds a word spanning soft wraps in physical cell coordinates', async () => {
  await withTerminal('       needle', terminal => {
    expect(findTerminalMatches(terminal.buffer.active, 'needle', terminal.cols))
      .toEqual([{ row: 0, col: 7, length: 6 }]);
  });
});

it('does not join hard newlines', async () => {
  await withTerminal('nee\r\ndle', terminal => {
    expect(findTerminalMatches(terminal.buffer.active, 'needle', terminal.cols)).toEqual([]);
  });
});

it('maps wide and combined cells across wrapping without inventing padding text', async () => {
  await withTerminal('        a界e\u0301🙂', terminal => {
    expect(findTerminalMatches(terminal.buffer.active, 'a界e\u0301🙂', terminal.cols))
      .toEqual([{ row: 0, col: 8, length: 6 }]);
  });
});

it('bounds matches while searching retained output', async () => {
  await withTerminal('a'.repeat(12000), terminal => {
    expect(findTerminalMatches(terminal.buffer.active, 'a', terminal.cols)).toHaveLength(1000);
  });
});
