import { Duplex } from 'node:stream';
import { DarwinAppDisplay } from './darwin-display.js';

it.each([
  { flag: 20, issue: 'macos-session', disposition: 'permission' },
  { flag: 25, issue: 'macos-desktop-connection', disposition: 'permission' },
  { flag: 24, issue: undefined, disposition: 'capture-failed' },
])('keeps coalesced frames and input receipts, and reports native failure $flag', async ({ flag, issue, disposition }) => {
  const commands: { id: number; kind: string }[] = [];
  const channel = new Duplex({
    read() {},
    write(chunk: Buffer, _encoding, done) {
      commands.push(JSON.parse(chunk.toString()));
      done();
    },
  });
  const display = new DarwinAppDisplay({
    stdio: [null, null, null, null, channel],
  });
  const receipt = (id: number, flag: number) => {
    const bytes = Buffer.alloc(9);
    bytes.writeUInt32BE(id, 4);
    bytes[8] = flag;
    return bytes;
  };
  const listener = { frame: jest.fn(), end: jest.fn() };
  const stop = display.watch(listener);
  const packet = Buffer.alloc(14);
  packet.writeUInt32BE(5);
  packet.writeUInt16BE(1280, 4);
  packet.writeUInt16BE(800, 6);
  packet[8] = 1;
  packet.set([0, 0, 0, 1, 5], 9);
  const ready = receipt(commands[0].id, 1);
  channel.push(ready.subarray(0, 2));
  channel.push(Buffer.concat([ready.subarray(2), packet]));
  await new Promise((resolve) => setImmediate(resolve));
  expect(listener.frame).toHaveBeenCalledWith(
    expect.objectContaining({
      width: 1280,
      height: 800,
      key: true,
      data: packet.subarray(9),
    }),
  );
  const input = display.input({ kind: 'key', code: 'Enter', down: true });
  expect(commands[1].kind).toBe('key');
  channel.push(receipt(commands[1].id, 2));
  await expect(input).rejects.toThrow('Accessibility');
  channel.push(receipt(0, flag));
  channel.push(packet);
  await new Promise((resolve) => setImmediate(resolve));
  expect(listener.end).toHaveBeenCalledWith(expect.any(String), disposition, issue);
  expect(listener.frame).toHaveBeenCalledTimes(1);
  stop();
  channel.destroy();
});
