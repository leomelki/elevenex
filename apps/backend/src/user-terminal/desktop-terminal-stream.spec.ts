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

describe('Rich shell tracking', () => {
  const cwd = (value: string) =>
    '\x1b]133;P;' +
    token +
    ';' +
    value.replaceAll('\\', '\\\\').replaceAll(';', '\\x3b') +
    '\x07';
  it('retains cwd, timing and exact UTF-16 boundaries at every chunk split', () => {
    const initial = cwd('/work/🙂;one') + '\x1b]133;B;' + token + '\x07';
    const output =
      initial +
      command('false') +
      start +
      '🙂failed\r\n' +
      prompt(7) +
      cwd('/other');
    for (let split = 0; split < output.length; split++) {
      const stream = new DesktopTerminalStream(null, token);
      stream.append(output.slice(0, split));
      stream.append(output.slice(split));
      const page = stream.tracking.page(0);
      expect(page.commands).toHaveLength(1);
      const record = page.commands[0];
      expect(record).toMatchObject({
        id: 1,
        command: 'false',
        confidence: 'exact',
        cwd: '/work/🙂;one',
        state: 'completed',
        exitCode: 7,
        outputStart: initial.length + command('false').length + start.length,
        outputEnd: output.indexOf('\x1b]133;B;', initial.length),
      });
      expect(record.startedAt).toEqual(expect.any(Number));
      expect(record.finishedAt).toEqual(expect.any(Number));
      expect(record.durationMs).toBeGreaterThanOrEqual(0);
      expect(stream.tracking.cwd).toBe('/other');
      expect(stream.read(null, 0).commandStarts).toEqual([
        { id: 1, at: record.outputStart },
      ]);
    }
  });
  it('separates mutable current state from immutable completion pages and marks process exits', () => {
    const stream = new DesktopTerminalStream(null, token);
    stream.append(command('false') + start);
    expect(stream.tracking.page(0)).toMatchObject({
      commands: [],
      current: { id: 1, state: 'running' },
      next: 0,
      gap: false,
    });
    stream.append(prompt(1));
    expect(stream.tracking.page(0)).toMatchObject({
      commands: [{ id: 1, state: 'completed' }],
      current: null,
      next: 1,
    });
    stream.append(command('echo next') + start);
    expect(stream.tracking.page(1)).toMatchObject({
      commands: [],
      current: { id: 2 },
      next: 1,
      gap: false,
    });
    stream.exited(137);
    expect(stream.tracking.page(1)).toMatchObject({
      commands: [{ id: 2, state: 'interrupted', exitCode: null }],
      current: null,
    });
    stream.append(command('after exit') + start + prompt(0));
    expect(stream.tracking.page(2).commands).toEqual([]);
  });
  it('keeps multiline metadata but never injects it into a prompt', () => {
    const stream = new DesktopTerminalStream(null, token);
    stream.append(
      command('echo one\necho two').replace('\n', '\\x0a') + start + prompt(1),
    );
    expect(stream.tracking.latest?.command).toBe('echo one\necho two');
    expect(stream.command).toBe('Shell command');
    expect(stream.canRerun).toBe(false);
  });
  it('does not fabricate starts/durations for completion-only history', () => {
    const stream = new DesktopTerminalStream(null, token);
    stream.append(command('false').replace('133;E;', '133;H;') + prompt(1));
    expect(stream.tracking.latest).toMatchObject({
      command: 'false',
      confidence: 'history',
      startedAt: null,
      durationMs: null,
      outputStart: null,
    });
    stream.append(prompt(1));
    expect(stream.tracking.page(0).commands).toHaveLength(1);
  });
  it('bounds history by count and text and paginates expired cursors', () => {
    const stream = new DesktopTerminalStream(null, token);
    for (let index = 0; index < 250; index++)
      stream.append(command('false') + start + prompt(1));
    const first = stream.tracking.page(0);
    expect(first).toMatchObject({ gap: true, more: true, next: 70 });
    expect(first.commands[0].id).toBe(51);
    expect(first.commands).toHaveLength(20);
    expect(stream.tracking.page(first.next)).toMatchObject({
      gap: false,
      next: 90,
    });
    for (let index = 0; index < 100; index++)
      stream.append(command('a'.repeat(4096)) + start + prompt(0));
    expect(stream.tracking.page(0).commands[0].id).toBeGreaterThan(250);
    expect(stream.tracking.page(99999).gap).toBe(true);
  });
  it('ignores services inside foreign/malformed/oversized OSC and waits for complete ports', () => {
    for (const frame of [
      '\x1b]0;http://localhost:3000/\x07',
      '\x1b]133;E;bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb;http://localhost:3000/\x07',
      '\x1b]133;E;' +
        token +
        ';' +
        'x'.repeat(40000) +
        'http://localhost:3000/\x1b\\',
    ]) {
      const stream = new DesktopTerminalStream(null, token);
      for (let offset = 0; offset < frame.length; offset += 97)
        stream.append(frame.slice(offset, offset + 97));
      expect(stream.port).toBeNull();
      stream.append('http://localhost:4');
      expect(stream.port).toBeNull();
      stream.append('317/');
      expect(stream.port).toBe(4317);
    }
  });
  it.each([false, true])(
    'detects Angular/Vite styled URLs at every chunk split (script: %s)',
    (script) => {
      // Vite colors the URL and separately makes its port bold.
      const output =
        '  \x1b[32m➜\x1b[39m  \x1b[1mLocal\x1b[22m:   ' +
        '\x1b[36mhttp://localhost:\x1b[1m4200\x1b[22m/\x1b[39m\r\n';
      for (let split = 0; split <= output.length; split++) {
        const stream = new DesktopTerminalStream(
          script
            ? { id: 'start', file: 'pnpm', args: ['start'], cmd: 'pnpm start' }
            : null,
        );
        stream.append(output.slice(0, split));
        stream.append(output.slice(split));
        expect(stream.status).toBe('serving');
        expect(stream.port).toBe(4200);
        expect(stream.protocol).toBe('http');
        expect(stream.read(null, 0).data).toBe(output);
      }
    },
  );
  it('waits for a visible port delimiter across styling and single-character chunks', () => {
    const stream = new DesktopTerminalStream();
    for (const char of 'https://[::1]:\x1b[1m4\x1b[22m200\x1b[0m') {
      stream.append(char);
      expect(stream.port).toBeNull();
    }
    stream.append('\n');
    expect(stream.port).toBe(4200);
    expect(stream.protocol).toBe('https');
  });
  it.each([
    'http://localhost:\x1b[2J4200/\n',
    'http://localhost:\x1b[1X4200/\n',
    'http://localhost:\x1b[?1m4200/\n',
    'http://localhost:\x1b[1\x1b[1m4200/\n',
    'http://localhost:4200\x1b[2J\n',
    'http://localhost:\x1b[1m65536\x1b[22m/\n',
    'http://localhost:\x1b[1m0\x1b[22m/\n',
    '\x1b]0;http://localhost:\x1b[1m4200\x1b[22m/\x07',
  ])(
    'does not discover a service from invalid/styled metadata: %j',
    (output) => {
      const stream = new DesktopTerminalStream();
      for (const char of output) stream.append(char);
      expect(stream.port).toBeNull();
      stream.append('http://127.0.0.1:4317/\n');
      expect(stream.port).toBe(4317);
    },
  );
});

describe('Terminal activity titles', () => {
  const title = (value: string) => '\x1b]2;' + value + '\x07';
  it('labels the executing command without its arguments and restores the shell at completion', () => {
    const stream = new DesktopTerminalStream(null, token);
    expect(stream.activityTitle).toBeNull();
    stream.append(prompt(0));
    stream.append(command('/usr/bin/ssh host --secret PRIVATE') + start);
    expect(stream.activityTitle).toBe('ssh');
    stream.append(title('remote editor'));
    expect(stream.activityTitle).toBe('remote editor');
    stream.append(prompt(1));
    expect(stream.activityTitle).toBeNull();
    expect(stream.command).toBe('/usr/bin/ssh host --secret PRIVATE');
    expect(stream.canRerun).toBe(true);
    stream.append(command('node server.js') + start);
    expect(stream.activityTitle).toBe('node');
    stream.exited(1);
    stream.append(title('too late'));
    expect(stream.activityTitle).toBeNull();
  });
  it('never reuses a prompt or earlier command title for a new execution', () => {
    const stream = new DesktopTerminalStream(null, token);
    stream.append(title('startup') + prompt(0) + title('prompt title'));
    expect(stream.activityTitle).toBeNull();
    stream.append(command('nvim file') + start + title('file — nvim'));
    expect(stream.activityTitle).toBe('file — nvim');
    stream.append(title(''));
    expect(stream.activityTitle).toBe('nvim');
    stream.append(prompt(0) + command('sleep 10') + start);
    expect(stream.activityTitle).toBe('sleep');
    stream.append(prompt(0) + command('ENV=value hidden-command') + start);
    expect(stream.activityTitle).toBeNull();
  });
  it('accepts standard titles in plain shells without enabling command tracking or service discovery', () => {
    const stream = new DesktopTerminalStream(null, token);
    stream.configureIntegration('disabled');
    stream.append(title('http://localhost:3000/'));
    expect(stream.activityTitle).toBe('http://localhost:3000/');
    expect(stream.port).toBeNull();
    expect(stream.integration).toBe('disabled');
    expect(stream.canRerun).toBe(false);
    stream.append('\x1b]0;plain shell\x1b\\');
    expect(stream.activityTitle).toBe('plain shell');
    stream.append(title(''));
    expect(stream.activityTitle).toBeNull();
  });
  it('keeps project-script names in charge regardless of output titles', () => {
    const stream = new DesktopTerminalStream(
      { id: 'dev', file: 'pnpm', args: ['run', 'dev'], cmd: 'pnpm run dev' },
      token,
    );
    stream.append(title('node') + command('something else') + start);
    expect(stream.activityTitle).toBeNull();
  });
  it('handles split title frames and bounds display metadata without changing output', () => {
    const frame = title('  editor\r\n\t\u202e🙂 file  ');
    for (let split = 0; split <= frame.length; split++) {
      const stream = new DesktopTerminalStream();
      stream.append(frame.slice(0, split));
      stream.append(frame.slice(split));
      expect(stream.activityTitle).toBe('editor 🙂 file');
      expect(stream.read(null, 0).data).toBe(frame);
    }
    const stream = new DesktopTerminalStream();
    stream.append(title('a'.repeat(119) + '🙂'));
    expect(stream.activityTitle).toBe('a'.repeat(119));
    stream.append(title('x'.repeat(1025)));
    expect(stream.activityTitle).toBeNull();
  });
});
