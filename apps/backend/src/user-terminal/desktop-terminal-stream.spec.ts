import { DesktopTerminalStream } from './desktop-terminal-stream.js';

const token = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const start = '\x1b]133;C;' + token + '\x07';
const prompt = (code: number) =>
  '\x1b]133;D;' + token + ';' + code + '\x07\x1b]133;B;' + token + '\x07';
const command = (value: string) =>
  '\x1b]133;E;' +
  token +
  ';' +
  value.replaceAll('\\', '\\\\').replaceAll(';', '\\x3b') +
  '\x07';

describe('Desktop terminal process stream', () => {
  it('pages at resize boundaries and carries the grid that produced each page', () => {
    const stream = new DesktopTerminalStream();
    stream.append('startup');
    stream.resize(32, 8);
    stream.append('prompt');
    const first = stream.read(null, 0);
    expect(first).toMatchObject({
      data: 'startup',
      size: { cols: 80, rows: 24 },
      next: 7,
      more: true,
    });
    const second = stream.read(stream.generation, first.next);
    expect(second).toMatchObject({
      data: 'prompt',
      size: { cols: 32, rows: 8 },
      from: 7,
      more: false,
    });
    stream.resize(40, 10);
    expect(stream.read(stream.generation, second.next)).toMatchObject({
      data: '',
      size: { cols: 40, rows: 10 },
      more: false,
    });
    // Multiple resizes without intervening output retain only the latest grid.
    stream.resize(50, 12);
    stream.append('next');
    expect(stream.read(stream.generation, second.next)).toMatchObject({
      data: 'next',
      size: { cols: 50, rows: 12 },
    });
  });
  it('bounds geometry history and reports a gap when earlier resize boundaries expire', () => {
    const stream = new DesktopTerminalStream();
    for (let index = 0; index < 1000; index++) {
      stream.append('x');
      stream.resize(32 + (index % 2), 8);
    }
    const first = stream.read(stream.generation, 0);
    expect(first.gap).toBe(true);
    expect(first.from).toBe(745);
    expect(first.size).toEqual({ cols: 32, rows: 8 });
    stream.append('y'.repeat(300_000));
    const expired = stream.read(stream.generation, 0);
    expect(expired.from).toBe(stream.sequence - 256 * 1024);
    expect(expired.size).toEqual({ cols: 33, rows: 8 });
    expect(expired.data).toBe('y'.repeat(32768));
  });
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
  it('uses authenticated shell-reported commands after editing rather than keystrokes', () => {
    const stream = new DesktopTerminalStream(null, token);
    stream.append(prompt(0));
    stream.input('different text\x1b[A\r');
    expect(stream.command).toBe('');
    stream.append(command('printf "actual; 🙂"; false') + start + prompt(1));
    expect(stream.command).toBe('printf "actual; 🙂"; false');
    expect(stream.rerunInput()).toBe('printf "actual; 🙂"; false\r');
    stream.input('unfinished\x15');
    expect(stream.rerunInput()).toBeNull();
    stream.append(prompt(1));
    expect(stream.rerunInput()).toBeNull();
  });
  it('never captures foreground input, passwords, or a command from ordinary output', () => {
    const stream = new DesktopTerminalStream(null, token);
    stream.append(prompt(0));
    stream.input('ssh host\rSECRET_PASSWORD\r');
    stream.append(command('ssh host') + start);
    stream.input('OTHER_SECRET\r');
    stream.append('rm -rf something\n' + prompt(1));
    expect(stream.command).toBe('ssh host');
    expect(stream.rerunInput()).toBeNull();
    expect(JSON.stringify(stream)).not.toContain('SECRET_PASSWORD');
    expect(JSON.stringify(stream)).not.toContain('OTHER_SECRET');
  });
  it('does not split Unicode at output page boundaries', () => {
    const stream = new DesktopTerminalStream();
    stream.append('a'.repeat(32767) + '🙂end');
    const first = stream.read(null, 0),
      next = stream.read(stream.generation, first.next);
    expect(first.data + next.data).toBe('a'.repeat(32767) + '🙂end');
  });
  it.each(['packet', 'queued', 'foreground'])(
    'does not append a rerun to uncertain %s input',
    (mode) => {
      const stream = new DesktopTerminalStream(null, token);
      stream.append(prompt(0));
      stream.input(mode === 'packet' ? 'false\runsent' : 'false\r');
      if (mode === 'queued') stream.input('unsent');
      stream.append(command('false') + start);
      if (mode === 'foreground') {
        stream.input('unsent');
        // Bash may report the identified command only after it finishes.
        stream.append(command('false'));
      }
      stream.append(prompt(1));
      expect(stream.command).toBe('false');
      expect(stream.rerunInput()).toBeNull();
      stream.input('\r');
      stream.append(command('false') + start + prompt(1));
      expect(stream.rerunInput()).toBe('false\r');
    },
  );
  it('keeps command/status frames ordered and single-use at every chunk boundary', () => {
    const text =
      command('echo http://localhost:3000/; false') +
      start +
      'https://localhost:9443/\r\n' +
      prompt(7);
    for (let split = 0; split <= text.length; split++) {
      const stream = new DesktopTerminalStream(null, token);
      stream.append(text.slice(0, split));
      stream.append(text.slice(split));
      expect(stream.status).toBe('failed');
      expect(stream.port).toBeNull();
      expect(stream.command).toBe('echo http://localhost:3000/; false');
      expect(stream.rerunInput()).toBe('echo http://localhost:3000/; false\r');
      stream.input('unsent');
      stream.append('more output');
      expect(stream.rerunInput()).toBeNull();
    }
  });
  it.each([
    '',
    'x'.repeat(4095) + '🙂',
    'bad\ncommand',
    'bad\rcommand',
    'bad\x1bcommand',
  ])(
    'does not make an unsafe or oversize reported command repeatable',
    (value) => {
      const stream = new DesktopTerminalStream(null, token);
      stream.append(command(value) + start + prompt(1));
      expect(stream.command.length).toBeLessThanOrEqual(4096);
      expect(stream.rerunInput()).toBeNull();
    },
  );
  it('rejects foreign markers, invalid escaping and untrusted OSC command text', () => {
    const stream = new DesktopTerminalStream(null, token);
    stream.append(
      command('foreign').replace(token, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'),
    );
    stream.append('\x1b]133;B\x07\x1b]133;D;1\x07');
    expect(stream.command).toBe('');
    stream.append('\x1b]133;E;' + token + ';bad\\q\x07' + prompt(1));
    expect(stream.command).toBe('Shell command');
    expect(stream.canRerun).toBe(false);
  });
  it('exposes optional integration state without making it a process prerequisite', () => {
    const stream = new DesktopTerminalStream(null, token);
    expect(stream.integration).toBe('pending');
    const now = Date.now();
    const time = jest.spyOn(Date, 'now').mockReturnValue(now + 10001);
    try {
      expect(stream.integration).toBe('unavailable');
    } finally {
      time.mockRestore();
    }
    stream.append(prompt(0));
    expect(stream.integration).toBe('active');
    stream.configureIntegration('disabled');
    stream.append(command('false') + start + prompt(1));
    expect(stream.integration).toBe('disabled');
    expect(stream.canRerun).toBe(false);
    stream.append('Listening http://localhost:4317/\n');
    // Plain terminals can discover services too, independent of command tracking.
    const plain = new DesktopTerminalStream(null, token);
    plain.configureIntegration('unsupported');
    plain.append('Listening http://localhost:4317/\n');
    expect(plain.port).toBe(4317);
    plain.exited(7);
    expect(plain.status).toBe('failed');
    expect(plain.port).toBeNull();
  });
});
