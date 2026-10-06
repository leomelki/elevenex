import { TerminalOutputBuffer } from './terminal-output-buffer.js';

describe('TerminalOutputBuffer', () => {
  it('preserves terminal escape sequences and output order', () => {
    const buffer = new TerminalOutputBuffer();
    buffer.append('\x1b[32mhello');
    buffer.append('\x1b[0m\r\n');
    expect(buffer.snapshot()).toBe('\x1b[32mhello\x1b[0m\r\n');
  });

  it('retains only recent output when a hidden terminal keeps writing', () => {
    const buffer = new TerminalOutputBuffer(10);
    buffer.append('older');
    buffer.append('recent');
    expect(buffer.snapshot()).toBe('lderrecent');
    buffer.append('abcdefghijkl');
    expect(buffer.snapshot()).toBe('cdefghijkl');
  });

  it('bounds output across many small chunks and ignores empty writes', () => {
    const buffer = new TerminalOutputBuffer(10);
    for (let i = 0; i < 3000; i++) {
      buffer.append('');
      buffer.append(String(i % 10));
    }
    expect(buffer.snapshot()).toBe('0123456789');
  });
});
