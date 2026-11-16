import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { probeHostCommand, runHostStep } from './process.js';

it('bounds probes and handles absent commands without throwing native output', async () => {
  expect(
    (
      await probeHostCommand(process.execPath, [
        '-e',
        'process.stdout.write("ok")',
      ])
    ).code,
  ).toBe(0);
  expect(
    (await probeHostCommand('/elevenex-missing-probe', [])).code,
  ).toBeNull();
  const controller = new AbortController();
  controller.abort();
  expect(
    (
      await probeHostCommand(
        process.execPath,
        ['-e', 'setInterval(()=>{},1000)'],
        controller.signal,
      )
    ).code,
  ).toBeNull();
});
it('owns an interrupted installer until its process group has been terminated', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'browser-installer-stop-'));
  const marker = join(directory, 'ready');
  const controller = new AbortController();
  const stopped = runHostStep(
    process.execPath,
    [
      '-e',
      'process.on("SIGTERM",()=>{});require("node:fs").writeFileSync(process.argv[1],"ready");setInterval(()=>{},1000)',
      marker,
    ],
    controller.signal,
  );
  const rejected = expect(stopped).rejects.toThrow(/interrupted/);
  try {
    for (let attempt = 0; ; attempt++) {
      try {
        await readFile(marker);
        break;
      } catch {
        if (attempt > 100) throw new Error('Installer fixture did not start');
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
    controller.abort();
    await rejected;
  } finally {
    controller.abort();
    await stopped.catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
}, 10000);
