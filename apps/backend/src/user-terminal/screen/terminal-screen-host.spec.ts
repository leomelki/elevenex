import { join } from 'node:path';
import { Terminal } from '@xterm/headless';
import { TerminalScreenHost } from './terminal-screen-host.js';
import { TerminalParserTail } from './terminal-parser-tail.js';

const worker = join(__dirname, '../../../dist/user-terminal/screen/terminal-screen-worker.js');
const write = (terminal: Terminal, data: string) => new Promise<void>(resolve => terminal.write(data, resolve));
describe('Isolated authoritative terminal screen', () => {
  it('restores color, alternate-screen state, cursor and a fragmented control sequence', async () => {
    const host = new TerminalScreenHost(worker), replies: string[] = [];
    const terminal = new Terminal({ cols: 40, rows: 8, allowProposedApi: true });
    try {
      host.open(1, 40, 8, { pause: () => {}, resume: () => {}, reply: data => replies.push(data) });
      const data = '\x1b[31mnormal\x1b[?1049h\x1b[2;4H\x1b[32mgreen\x1b[6n\x1b[38;2;';
      host.write(1, data, data.length);
      const snapshot = await host.snapshot(1);
      await write(terminal, snapshot.data + '10;20;30mX');
      expect(replies).toEqual(['\x1b[2;9R']);
      expect(terminal.buffer.active.type).toBe('alternate');
      expect(terminal.buffer.active.cursorX).toBe(9);
      expect(terminal.buffer.active.cursorY).toBe(1);
      expect(terminal.buffer.active.getLine(1)?.getCell(3)?.getFgColor()).toBe(2);
      expect(terminal.buffer.active.getLine(1)?.getCell(8)?.getFgColor()).toBe(0x0a141e);
    } finally { host.dispose(); terminal.dispose(); }
  });
  it('returns bounded confirmed context and resumes a paused producer on disposal', async () => {
    const host = new TerminalScreenHost(worker), pause = jest.fn(), resume = jest.fn();
    host.open(1, 80, 24, { pause, resume, reply: () => {} });
    host.write(1, 'real output\r\n', 13);
    expect(await host.context(1)).toBe('real output');
    host.write(1, 'x'.repeat(300000), 300013);
    expect(pause).toHaveBeenCalledTimes(1);
    host.dispose(); expect(resume).toHaveBeenCalledTimes(1);
    await expect(host.snapshot(1)).rejects.toThrow('unavailable');
  });
  it('keeps unfinished parser tails bounded and preserves all chunk splits', () => {
    const data = '\x1b]2;partial';
    for (let split = 0; split <= data.length; split++) {
      const tail = new TerminalParserTail(); tail.append(data.slice(0, split)); tail.append(data.slice(split));
      expect(tail.suffix()).toBe(data); tail.append('\x07'); expect(tail.suffix()).toBe('');
    }
    const tail = new TerminalParserTail(); tail.append('\x1b]'+ 'x'.repeat(70000));
    expect(() => tail.suffix()).toThrow('too large'); tail.append('\x07'); expect(tail.suffix()).toBe('');
  });
  it('rejects pending reads and ignores protocol responses from a retired screen incarnation', async () => {
    const host = new TerminalScreenHost(worker), replacementReply = jest.fn();
    try {
      host.open(1, 80, 24, { pause: () => {}, resume: () => {}, reply: () => {} });
      host.write(1, '\x1b[6n', 4);
      const snapshot = host.snapshot(1);
      const rejected = expect(snapshot).rejects.toThrow('changed');
      host.close(1);
      host.open(1, 80, 24, { pause: () => {}, resume: () => {}, reply: replacementReply });
      host.write(1, 'replacement', 11);
      await rejected; expect(await host.context(1)).toBe('replacement');
      expect(replacementReply).not.toHaveBeenCalled();
    } finally { host.dispose(); }
  });
});
