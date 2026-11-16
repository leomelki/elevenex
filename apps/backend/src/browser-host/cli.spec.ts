import { parseBrowserSetupArgs } from './cli.js';
import { browserSetupCommand } from './paths.js';

it('requires explicit, validated provisioning options and preserves the selected data root', () => {
  expect(
    parseBrowserSetupArgs(['--check', '--data-root', '/data/backend']),
  ).toMatchObject({ check: true, system: false, dataRoot: '/data/backend' });
  expect(
    parseBrowserSetupArgs(['--system', '--data-root', '/data/backend']),
  ).toMatchObject({
    system: true,
    check: false,
  });
  for (const args of [
    ['--check', '--system'],
    ['--system'],
    ['--data-root'],
    ['--data-root', 'relative'],
    ['--data-root', '/data\nroot'],
    ['--force'],
    ['--check', '--check'],
  ])
    expect(() => parseBrowserSetupArgs(args)).toThrow();
});
it('quotes recovery commands without shell interpolation and uses bundled Node relative to the helper', () => {
  const command = browserSetupCommand(
    true,
    "/data/a'$(danger)",
    '/runtime/browser-setup.cjs',
    '/runtime/node/bin/node',
    'linux',
    false,
  );
  expect(command).toBe(
    "cd '/runtime' && sudo -- './node/bin/node' 'browser-setup.cjs' '--data-root' '/data/a'\\''$(danger)' '--system'",
  );
});
it('preserves Electron-as-Node when applicable and emits PowerShell invocation syntax on Windows', () => {
  expect(
    browserSetupCommand(
      false,
      '/data',
      '/app/browser-setup.cjs',
      '/app/electron',
      'linux',
      true,
    ),
  ).toContain('env ELECTRON_RUN_AS_NODE=1');
  expect(
    browserSetupCommand(
      false,
      "C:\\data's",
      'C:\\app\\browser-setup.cjs',
      'C:\\app\\node.exe',
      'win32',
      false,
    ),
  ).toBe(
    "& 'C:\\app\\node.exe' 'C:\\app\\browser-setup.cjs' '--data-root' 'C:\\data''s'",
  );
});
