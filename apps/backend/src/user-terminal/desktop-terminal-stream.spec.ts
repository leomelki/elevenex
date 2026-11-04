import { DesktopTerminalStream } from './desktop-terminal-stream.js';

const token = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const start = `\x1b]133;C;${token}\x07`;
const prompt = (code: number) =>
  `\x1b]133;D;${token};${code}\x07\x1b]133;B;${token}\x07`;

describe('Desktop terminal process stream', () => {
  it('orders bounded windows, reports expired offsets and never changes generation on read', () => {
    const stream = new DesktopTerminalStream(null, token);
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
    const stream = new DesktopTerminalStream(null, token);
    stream.append(`${prompt(0)}`);
    stream.input('false\r');
    stream.append(`${start}failure${prompt(1)}`);
    expect(stream.status).toBe('failed');
    expect(stream.command).toBe('false');
    expect(stream.rerunInput()).toBe('false\r');
    stream.append(`${prompt(1)}rm -rf anything\nhttp://evil.example:3000/`);
    expect(stream.rerunInput()).toBe('false\r');
    expect(stream.port).toBeNull();
    stream.input('\x1b[A\r');
    stream.append(`${prompt(1)}`);
    expect(stream.canRerun).toBe(false);
  });
  it('parses split prompt status, detects only bounded localhost ports, and clears serving on exit', () => {
    const stream = new DesktopTerminalStream(null, token);
    stream.append('\x1b]133;');
    stream.append(`D;${token};7\x07\x1b]133;B;${token}\x07`);
    expect(stream.exitCode).toBe(7);
    stream.append(`${start}Listening http://localhost:4317/\r\n`);
    expect(stream.port).toBe(4317);
    expect(stream.protocol).toBe('http');
    stream.append('Ready https://localhost:9443/\r\n');
    expect(stream.protocol).toBe('https');
    expect(stream.status).toBe('serving');
    stream.exited(0);
    expect(stream.port).toBeNull();
    expect(stream.status).toBe('exited');
    expect(stream.generation).not.toBe(
      new DesktopTerminalStream(null, token).generation,
    );
  });
  it('does not split Unicode at output page boundaries', () => {
    const stream = new DesktopTerminalStream(null, token);
    stream.append('a'.repeat(32767) + '🙂end');
    const first = stream.read(null, 0),
      next = stream.read(stream.generation, first.next);
    expect(first.data + next.data).toBe('a'.repeat(32767) + '🙂end');
  });
  it('does not expose interactive program input as a shell command', () => {
    const stream = new DesktopTerminalStream(null, token);
    stream.append(`${prompt(0)}`);
    stream.input('ssh example\rprivate pasted input\r');
    stream.append(`${start}`);
    stream.input('private password\r');
    stream.append(`${prompt(7)}`);
    expect(stream.command).toBe('ssh example');
    expect(stream.rerunInput()).toBe('ssh example\r');
  });
  it('refuses rerun while the shell contains an unfinished or edited input line', () => {
    const stream = new DesktopTerminalStream(null, token);
    stream.append(`${prompt(0)}`);
    stream.input('false\r');
    stream.append(`${prompt(1)}`);
    stream.input('unfinished');
    expect(stream.canRerun).toBe(false);
    expect(stream.rerunInput()).toBeNull();
    stream.input('\x15');
    expect(stream.rerunInput()).toBe('false\r');
    stream.input('\x1b[D');
    expect(stream.canRerun).toBe(false);
  });
  it('captures a single-line bracketed paste, including split paste markers', () => {
    const stream = new DesktopTerminalStream(null, token);
    stream.append(`${prompt(0)}`);
    for (const char of '\x1b[200~false\x1b[201~\r') stream.input(char);
    stream.append(`${start}${prompt(1)}`);
    expect(stream.command).toBe('false');
    expect(stream.rerunInput()).toBe('false\r');
  });
  it('does not restore rerun after Ctrl-U when cursor edits may leave unsent text', () => {
    const stream = new DesktopTerminalStream(null, token);
    stream.append(prompt(0));
    stream.input('false\r');
    stream.append(prompt(1));
    stream.input('unsent\x01\x15');
    expect(stream.canRerun).toBe(false);
    expect(stream.rerunInput()).toBeNull();
    stream.input('false\r');
    stream.append(prompt(1));
    expect(stream.command).toBe('Shell command');
    expect(stream.canRerun).toBe(false);
  });
  it.each(['🙂', 'e\u0301'])(
    'refuses to guess shell deletion of %s',
    (text) => {
      const stream = new DesktopTerminalStream(null, token);
      stream.append(prompt(0));
      stream.input(`echo ${text}\x7f\r`);
      stream.append(prompt(1));
      expect(stream.command).toBe('Shell command');
      expect(stream.rerunInput()).toBeNull();
    },
  );
  it('refuses rerun during a paste or after multiline paste and history editing', () => {
    const stream = new DesktopTerminalStream(null, token);
    stream.append(`${prompt(0)}`);
    stream.input('false\r');
    stream.append(`${prompt(1)}`);
    stream.input('\x1b[200');
    expect(stream.canRerun).toBe(false);
    stream.input('~');
    expect(stream.canRerun).toBe(false);
    stream.input('false\ntrue\x1b[201~');
    expect(stream.status).toBe('failed');
    stream.input('\r');
    stream.append(`${prompt(1)}`);
    expect(stream.command).toBe('Shell command');
    expect(stream.canRerun).toBe(false);
    stream.input('false\r');
    stream.append(`${prompt(1)}`);
    stream.input('\x1b[A\r');
    stream.append(`${prompt(1)}`);
    expect(stream.canRerun).toBe(false);
  });
  it('does not mistake prompt text for a running service', () => {
    const stream = new DesktopTerminalStream(null, token);
    stream.append(`${prompt(0)}Ready http://localhost:3000/\r\n`);
    expect(stream.status).toBe('idle');
    stream.input('false\r');
    stream.append(`${start}${prompt(1)}`);
    expect(stream.command).toBe('false');
    expect(stream.rerunInput()).toBe('false\r');
  });
});

it('ignores forged and foreign-shell prompt markers before secret input', () => {
  const stream = new DesktopTerminalStream(null, token);
  stream.append(`\x1b]133;D;${token};0\x07\x1b]133;B;${token}\x07`);
  stream.input('ssh host\r');
  stream.append(`\x1b]133;C;${token}\x07`);
  stream.append('\x1b]133;D;0\x07\x1b]133;B\x07');
  stream.append('\x1b]133;B;bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb\x07Password:');
  stream.input('PRIVATE_PASSWORD\r');
  stream.append(`\x1b]133;D;${token};1\x07\x1b]133;B;${token}\x07`);
  expect(stream.command).toBe('ssh host');
  expect(stream.rerunInput()).toBe('ssh host\r');
});
it('waits for the final ready hook before capturing input from prompt commands', () => {
  const stream = new DesktopTerminalStream(null, token);
  stream.append(`\x1b]133;D;${token};0\x07`);
  stream.input('SECRET\r');
  stream.append(`\x1b]133;B;${token}\x07`);
  expect(stream.command).toBe('');
});
it.each([0, 7])(
  'keeps completion %s authoritative after URLs, for every chunk split',
  (code) => {
    const output = `\x1b]133;C;${token}\x07http://localhost:3000/\r\n\x1b]133;D;${token};${code}\x07\x1b]133;B;${token}\x07`;
    for (let split = 0; split <= output.length; split++) {
      const stream = new DesktopTerminalStream(null, token);
      stream.append(output.slice(0, split));
      stream.append(output.slice(split));
      expect(stream.port).toBeNull();
      expect(stream.status).toBe(code ? 'failed' : 'idle');
      expect(stream.exitCode).toBe(code);
    }
  },
);
