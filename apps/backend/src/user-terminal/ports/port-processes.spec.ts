import {
  listenerHost,
  portCommand,
  terminalProcessOwners,
} from './port-processes.js';
import { parseLsofListeners, parsePsProcesses } from './posix-port-snapshot.js';
import { parseProcListeners, parseProcProcess } from './linux-port-snapshot.js';
import {
  parseWindowsListeners,
  parseWindowsProcesses,
} from './windows-port-snapshot.js';

it('accepts complete lsof output with unmatched selections but rejects diagnostics and cancellation', async () => {
  const signal = new AbortController().signal;
  const stdout = 'p10\nn*:4200\n';
  await expect(
    portCommand(
      process.execPath,
      [
        '-e',
        `process.stdout.write(${JSON.stringify(stdout)}); process.exit(1);`,
      ],
      signal,
      true,
    ),
  ).resolves.toBe(stdout);
  await expect(
    portCommand(
      process.execPath,
      ['-e', 'process.stderr.write("permission denied"); process.exit(1);'],
      signal,
      true,
    ),
  ).rejects.toThrow('permission denied');
  const controller = new AbortController();
  const pending = portCommand(
    process.execPath,
    ['-e', 'setInterval(() => {}, 1000);'],
    controller.signal,
    true,
  );
  controller.abort();
  await expect(pending).rejects.toThrow('ABORT_ERR');
});

it('attributes nested wrappers and background children to the nearest terminal, rejecting reused parent PIDs and cycles', () => {
  const rows = [
    { pid: 10, parentPid: 1, started: 10 },
    { pid: 11, parentPid: 10, started: 11 },
    { pid: 12, parentPid: 11, started: 12 },
    { pid: 13, parentPid: 12, started: 13 },
    { pid: 14, parentPid: 10, started: 9 },
    { pid: 20, parentPid: 1, started: 1 },
    { pid: 30, parentPid: 31, started: 2 },
    { pid: 31, parentPid: 30, started: 2 },
  ];
  expect([...terminalProcessOwners(rows, [10, 12, 30])]).toEqual([
    [10, 10],
    [12, 12],
    [30, 30],
    [11, 10],
    [13, 12],
    [31, 30],
  ]);
});

it('parses numeric lsof listeners and excludes established connections and LAN-only binds', () => {
  expect(
    parseLsofListeners('p10\nn*:4200\np11\nn[::1]:5173\nn192.168.1.2:8000\n'),
  ).toEqual([
    { pid: 10, host: '127.0.0.1', port: 4200 },
    { pid: 11, host: '::1', port: 5173 },
  ]);
  expect(() => parseLsofListeners('n*:4200')).toThrow();
  expect(() =>
    parseLsofListeners('p10\nn127.0.0.1:4200->127.0.0.1:99'),
  ).not.toThrow();
  expect(parseLsofListeners('p10\nn127.0.0.1:4200->127.0.0.1:99')).toEqual([]);
});

it('parses locale-independent process birth times without retaining commands', () => {
  const rows = parsePsProcesses(
    '  10 1 Thu Nov  5 19:00:01 2026\n11 10 Thu Nov  5 19:00:02 2026\n',
  );
  expect(rows[1].started).toBeGreaterThan(rows[0].started);
  expect(() => parsePsProcesses('unreadable')).toThrow();
  expect(() => parsePsProcesses('')).toThrow();
  expect(
    parseWindowsProcesses('10 1 1793905201000\r\n11 10 1793905202000\r\n')[1]
      .parentPid,
  ).toBe(10);
  expect(() => parseWindowsProcesses('10 1 undefined')).toThrow();
});

it('parses IPv4/IPv6 Windows listeners without relying on localized state labels', () => {
  expect(
    parseWindowsListeners(
      ' Proto Local Address Foreign Address State PID\r\n' +
        ' TCP 0.0.0.0:4200 0.0.0.0:0 LISTENING 10\r\n' +
        ' TCP [::1]:5173 [::]:0 ABHÖREN 11\r\n' +
        ' TCP 127.0.0.1:4200 127.0.0.1:39999 ESTABLISHED 10\r\n' +
        ' UDP 0.0.0.0:88 *:* 12\r\n',
    ),
  ).toEqual([
    { pid: 10, host: '127.0.0.1', port: 4200 },
    { pid: 11, host: '::1', port: 5173 },
  ]);
  expect(() => parseWindowsListeners('Access denied')).toThrow();
});

it('decodes Linux listener tables in native word order, including IPv6-only sockets', () => {
  const row = (address: string, state: string, inode: string) =>
    `0: ${address}:1068 00000000:0000 ${state} 0:0 0:0 0 1000 0 ${inode} 1\n`;
  expect(
    parseProcListeners(
      'header\n' + row('0100007F', '0A', '11') + row('00000000', '01', '12'),
      true,
    ),
  ).toEqual([{ host: '127.0.0.1', port: 4200, inode: '11' }]);
  expect(
    parseProcListeners(
      'header\n' + row('00000000000000000000000001000000', '0A', '22'),
      true,
    ),
  ).toEqual([{ host: '::1', port: 4200, inode: '22' }]);
  expect(
    parseProcListeners('header\n' + row('7F000001', '0A', '11'), false)[0].host,
  ).toBe('127.0.0.1');
  const stat =
    '10 (server (with) spaces)) S 1 ' +
    Array(17).fill('0').join(' ') +
    ' 12345 0';
  expect(parseProcProcess(stat)).toEqual({
    pid: 10,
    parentPid: 1,
    started: 12345,
  });
});

it.each(['localhost', 'example.com', '192.168.1.2', '::2', '127.0.0.999'])(
  'rejects non-loopback or nonnumeric listener address %s',
  (host) => {
    expect(listenerHost(host)).toBeNull();
  },
);
