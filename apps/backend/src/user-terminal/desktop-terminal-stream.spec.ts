import { DesktopTerminalStream } from './desktop-terminal-stream.js';

describe('Desktop terminal process stream', () => {
  it('orders bounded windows, reports expired offsets and never changes generation on read', () => {
    const stream = new DesktopTerminalStream();
    stream.append('a'.repeat(300_000));
    const first = stream.read(stream.generation, 0);
    expect(first.gap).toBe(true);
    expect(first.from).toBe(300_000 - 256 * 1024);
    expect(first.data.length).toBe(32768);
    const next = stream.read(stream.generation, first.next);
    expect(next.gap).toBe(false);
    expect(next.from).toBe(first.next);
    expect(next.generation).toBe(first.generation);
    expect(stream.read('other-generation', next.next).gap).toBe(true);
    expect(stream.read(stream.generation, 400_000).gap).toBe(true);
  });
  it('uses user input for rerun and never executes a command or URL found in output', () => {
    const stream = new DesktopTerminalStream();
    stream.append('\x1b]133;D;0\x07');
    stream.input('false\r');
    stream.append('\x1b]133;C\x07failure\x1b]133;D;1\x07');
    expect(stream.status).toBe('failed');
    expect(stream.command).toBe('false');
    expect(stream.rerunInput()).toBe('false\r');
    stream.append('\x1b]133;D;1\x07rm -rf anything\nhttp://evil.example:3000/');
    expect(stream.rerunInput()).toBe('false\r');
    expect(stream.port).toBeNull();
    stream.input('\x1b[A\r');
    stream.append('\x1b]133;D;1\x07');
    expect(stream.canRerun).toBe(false);
  });
  it('parses split prompt status, detects only bounded localhost ports, and clears serving on exit', () => {
    const stream = new DesktopTerminalStream();
    stream.append('\x1b]133;');
    stream.append('D;7\x07');
    expect(stream.exitCode).toBe(7);
    stream.append('Listening http://localhost:4317/\r\n');
    expect(stream.port).toBe(4317);
    expect(stream.protocol).toBe('http');
    stream.append('Ready https://localhost:9443/\r\n');
    expect(stream.protocol).toBe('https');
    expect(stream.status).toBe('serving');
    stream.exited(0);
    expect(stream.port).toBeNull();
    expect(stream.status).toBe('exited');
    expect(stream.generation).not.toBe(new DesktopTerminalStream().generation);
  });
  it('does not split Unicode at output page boundaries', () => {
    const stream = new DesktopTerminalStream();
    stream.append('a'.repeat(32767) + '🙂end');
    const first = stream.read(null, 0),
      next = stream.read(stream.generation, first.next);
    expect(first.data + next.data).toBe('a'.repeat(32767) + '🙂end');
  });
  it('does not expose interactive program input as a shell command', () => {
    const stream = new DesktopTerminalStream();
    stream.append('\x1b]133;D;0\x07');
    stream.input('ssh example\rprivate pasted input\r');
    stream.append('\x1b]133;C\x07');
    stream.input('private password\r');
    stream.append('\x1b]133;D;7\x07');
    expect(stream.command).toBe('ssh example');
    expect(stream.rerunInput()).toBe('ssh example\r');
  });
  it('refuses rerun while the shell contains an unfinished or edited input line', () => {
    const stream = new DesktopTerminalStream();
    stream.append('\x1b]133;D;0\x07');
    stream.input('false\r');
    stream.append('\x1b]133;D;1\x07');
    stream.input('unfinished');
    expect(stream.canRerun).toBe(false);
    expect(stream.rerunInput()).toBeNull();
    stream.input('\x15');
    expect(stream.rerunInput()).toBe('false\r');
    stream.input('\x1b[D');
    expect(stream.canRerun).toBe(false);
  });
  it('keeps shell readiness independent from a detected serving indicator', () => {
    const stream = new DesktopTerminalStream();
    stream.append('\x1b]133;D;0\x07Ready http://localhost:3000/\r\n');
    expect(stream.status).toBe('serving');
    stream.input('false\r');
    stream.append('\x1b]133;C\x07\x1b]133;D;1\x07');
    expect(stream.command).toBe('false');
    expect(stream.rerunInput()).toBe('false\r');
  });
});
