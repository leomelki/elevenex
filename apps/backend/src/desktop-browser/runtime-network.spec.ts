import * as transport from '@elevenex/browser-network';
import type { LookupAddress, LookupAllOptions } from 'node:dns';
import { RuntimeBrowserNetwork } from './runtime-network.js';

jest.mock('@elevenex/browser-network', () => ({
  ...jest.requireActual<typeof import('@elevenex/browser-network')>(
    '@elevenex/browser-network',
  ),
  __esModule: true,
  browserSocks: jest.fn(),
}));
jest.mock('node:dns/promises', () => ({ __esModule: true, lookup: jest.fn() }));
// This adapter uses only lookup's all-address overload.
const { lookup } = jest.requireMock<{
  lookup: jest.Mock<Promise<LookupAddress[]>, [string, LookupAllOptions]>;
}>('node:dns/promises');
afterEach(() => jest.resetAllMocks());

function fixture() {
  let connect!: Parameters<typeof transport.browserSocks>[0];
  jest.mocked(transport.browserSocks).mockImplementation((resolver) => {
    connect = resolver;
    return Promise.resolve({
      port: 34000,
      close: () => Promise.resolve(),
      disconnect: () => undefined,
    });
  });
  const network = new RuntimeBrowserNetwork(() => true);
  return {
    network,
    connect: (host: string, port = 443) => connect(host, port),
  };
}

it('routes IP literals without DNS and preserves explicitly authorized IPv6 loopback', async () => {
  const f = fixture();
  try {
    await f.network.start();
    expect(await f.connect('1.1.1.1')).toEqual({ host: '1.1.1.1', port: 443 });
    expect(await f.connect('2606:4700:4700::1111')).toEqual({
      host: '2606:4700:4700::1111',
      port: 443,
    });
    expect(lookup).not.toHaveBeenCalled();
    f.network.authorize(new URL('http://[::1]:34000'));
    expect(await f.connect('::1', 34000)).toEqual({ host: '::1', port: 34000 });
    expect(await f.connect('localhost', 34000)).toEqual({
      host: 'localhost',
      port: 34000,
      addresses: [
        { address: '127.0.0.1', family: 4 },
        { address: '::1', family: 6 },
      ],
    });
    await expect(f.connect('::1', 34001)).rejects.toThrow('not authorized');
    await expect(f.connect('192.168.1.1')).rejects.toThrow('Private');
  } finally {
    f.network.close();
  }
});

it('coalesces system resolution and pins multiple public answers without allowing rebinding', async () => {
  const f = fixture();
  const addresses = [
    { address: '2606:4700:4700::1111', family: 6 },
    { address: '1.1.1.1', family: 4 },
  ];
  let finish!: (value: typeof addresses) => void;
  lookup.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  try {
    await f.network.start();
    const a = f.connect('example.test'),
      b = f.connect('example.test', 8443);
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(lookup).toHaveBeenCalledWith('example.test', {
      all: true,
      verbatim: true,
    });
    finish(addresses);
    expect(await a).toEqual({ host: 'example.test', port: 443, addresses });
    expect(await b).toEqual({ host: 'example.test', port: 8443, addresses });
    lookup.mockResolvedValueOnce([
      { address: '1.1.1.1', family: 4 },
      { address: '127.0.0.1', family: 4 },
    ]);
    await expect(f.connect('rebound.test')).rejects.toThrow('Private');
  } finally {
    f.network.close();
  }
});
