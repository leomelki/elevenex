import { DesktopTerminalStream } from '../desktop-terminal-stream.js';
import { TerminalServices } from './terminal-services.js';

const listener = (port: number, pid = 20, host = '127.0.0.1', started = 1) => ({
  port,
  pid,
  host,
  started,
});

it('discovers silent listeners, deduplicates families, retains a stable primary and clears closed ports', () => {
  const services = new TerminalServices();
  services.reconcile([
    listener(4200, 20, '::1'),
    listener(4200),
    listener(5173),
  ]);
  expect(services.services).toEqual([
    { port: 4200, host: '127.0.0.1', protocol: 'http', path: '/' },
    { port: 5173, host: '127.0.0.1', protocol: 'http', path: '/' },
  ]);
  services.reconcile([listener(3000), listener(4200), listener(5173)]);
  expect(services.primary?.port).toBe(4200);
  services.reconcile([listener(5173)]);
  expect(services.primary?.port).toBe(5173);
  services.reconcile([]);
  expect(services.primary).toBeNull();
});

it('uses matching hints only for owned ports and expires identity-bound hints when a port changes owners', () => {
  const services = new TerminalServices();
  services.hint(4200, 'https', '/app/');
  services.hint(1234, 'http');
  expect(services.primary).toBeNull();
  services.reconcile([listener(4200)]);
  expect(services.primary).toEqual({
    port: 4200,
    host: '127.0.0.1',
    protocol: 'https',
    path: '/app/',
  });
  services.reconcile(null);
  expect(services.primary).toBeNull();
  expect(services.discovery).toBe('unavailable');
  services.reconcile([listener(4200)]);
  expect(services.primary?.protocol).toBe('https');
  services.reconcile([listener(4200, 20, '127.0.0.1', 2)]);
  expect(services.primary?.protocol).toBe('http');
  services.hint(4200, 'https');
  services.reconcile([]);
  services.reconcile([listener(4200)]);
  expect(services.primary?.protocol).toBe('http');
});

it('bounds listeners/hints and rejects output-supplied authorities, query strings and controls', () => {
  const services = new TerminalServices();
  for (let port = 1; port <= 40; port++) services.hint(port, 'https');
  services.reconcile(
    Array.from({ length: 40 }, (_, index) => listener(index + 1)),
  );
  expect(services.services).toHaveLength(16);
  expect(services.primary?.port).toBe(40);
  expect(services.services.some((service) => service.port === 40)).toBe(true);
  services.reconcile([listener(1)]);
  for (const path of [
    '//example.com',
    '/\\example.com',
    '/bad\nline',
    '/?token=private',
    '/#fragment',
    'https://example.com',
    '/' + 'x'.repeat(2048),
  ]) {
    services.hint(1, 'https', path);
    expect(services.primary?.path).toBe('/');
  }
});

it('keeps background listeners through shell command boundaries and restores execution state when they close', () => {
  const token = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const stream = new DesktopTerminalStream(null, token);
  stream.services.reconcile([listener(4200)]);
  stream.append(`\x1b]133;C;${token}\x07\x1b]133;D;${token};0\x07`);
  expect(stream.status).toBe('serving');
  stream.services.reconcile([]);
  expect(stream.status).toBe('idle');
  stream.services.reconcile([listener(4200)]);
  stream.exited(0);
  expect(stream.status).toBe('exited');
  expect(stream.port).toBeNull();
});

it('preserves only a confined pathname from styled output, independently of chunk boundaries', () => {
  const output =
    'https://localhost:\x1b[1m4200\x1b[22m/app/?secret=ignored#fragment\r\n';
  for (let split = 0; split <= output.length; split++) {
    const stream = new DesktopTerminalStream();
    stream.append(output.slice(0, split));
    stream.append(output.slice(split));
    expect(stream.port).toBeNull();
    stream.services.reconcile([listener(4200)]);
    expect(stream.services.primary).toMatchObject({
      protocol: 'https',
      path: '/app/',
    });
    expect(stream.read(null, 0).data).toBe(output);
  }
});
