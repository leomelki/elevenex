import {
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as commands from './process.js';
import {
  browserAppArmorProfile,
  installBrowserAppArmorProfile,
  missingBrowserPackages,
} from './linux-setup.js';

const step = jest.spyOn(commands, 'runHostStep');
const probe = jest.spyOn(commands, 'probeHostCommand');
const signal = new AbortController().signal;
let directory: string, executable: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'browser-policy-'));
  executable = join(directory, 'Chromium with spaces');
  await writeFile(executable, 'fixture');
  step.mockReset().mockResolvedValue();
  probe.mockReset().mockResolvedValue({ code: 0, output: 'installed' });
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});
afterAll(() => {
  step.mockRestore();
  probe.mockRestore();
});

it('attaches userns permission to exactly this executable, without global wildcard or sysctl changes', async () => {
  const profile = browserAppArmorProfile(await realpath(executable));
  await installBrowserAppArmorProfile(executable, signal, directory);
  expect(await readFile(join(directory, profile.name), 'utf8')).toBe(
    profile.content,
  );
  expect(profile.content).toContain(`"${await realpath(executable)}"`);
  expect(profile.content).toContain('userns,');
  expect(profile.content).not.toContain('*');
  expect(step.mock.calls.map((call) => call[1][0])).toEqual(['-Q', '-r']);
});
it.each([
  '/tmp/evil*',
  '/tmp/a"\nprofile bad {',
  '/tmp/@{HOME}/chrome',
  '/tmp/[ab]/chrome',
])('refuses ambiguous AppArmor attachments: %s', (path) => {
  expect(() => browserAppArmorProfile(path)).toThrow(/safely/);
});
it('refuses administrator policy and symlinks instead of replacing them', async () => {
  const profile = browserAppArmorProfile(await realpath(executable));
  const destination = join(directory, profile.name);
  await writeFile(destination, '# administrator policy');
  await expect(
    installBrowserAppArmorProfile(executable, signal, directory),
  ).rejects.toThrow(/administrator/);
  expect(await readFile(destination, 'utf8')).toBe('# administrator policy');
  await rm(destination);
  await symlink(executable, destination);
  await expect(
    installBrowserAppArmorProfile(executable, signal, directory),
  ).rejects.toThrow(/regular file/);
  expect(step).not.toHaveBeenCalled();
});
it('rolls back a newly published policy when kernel loading fails', async () => {
  step
    .mockResolvedValueOnce()
    .mockRejectedValueOnce(new Error('parser failed'));
  await expect(
    installBrowserAppArmorProfile(executable, signal, directory),
  ).rejects.toThrow('parser failed');
  await expect(
    readFile(
      join(directory, browserAppArmorProfile(await realpath(executable)).name),
    ),
  ).rejects.toMatchObject({ code: 'ENOENT' });
});
it('restores both the previous policy file and its loaded state after a failed update', async () => {
  const profile = browserAppArmorProfile(await realpath(executable));
  const previous = profile.content + '# administrator local addition\n';
  await writeFile(join(directory, profile.name), previous);
  step
    .mockResolvedValueOnce()
    .mockRejectedValueOnce(new Error('load failed'))
    .mockResolvedValueOnce();
  await expect(
    installBrowserAppArmorProfile(executable, signal, directory),
  ).rejects.toThrow('load failed');
  expect(await readFile(join(directory, profile.name), 'utf8')).toBe(previous);
  expect(step).toHaveBeenCalledTimes(3);
});
it('does not install packages that are already present under either t64 or original names', async () => {
  expect(await missingBrowserPackages(signal)).toEqual([]);
  expect(step).not.toHaveBeenCalled();
});
it('selects available package alternatives and rejects missing package candidates', async () => {
  probe.mockImplementation((command, args) =>
    Promise.resolve({
      code: 0,
      output:
        command === 'dpkg-query'
          ? args.at(-1) === 'libnss3'
            ? 'not-installed'
            : 'installed'
          : 'Candidate: 1.2.3',
    }),
  );
  expect(await missingBrowserPackages(signal)).toEqual(['libnss3']);
  probe.mockResolvedValue({ code: 0, output: 'Candidate: (none)' });
  await expect(missingBrowserPackages(signal)).rejects.toThrow(
    /No browser dependency package/,
  );
});
