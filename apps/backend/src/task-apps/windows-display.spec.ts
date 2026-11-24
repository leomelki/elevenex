import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { windowsInput } from './windows-display.js';
import { windowsLaunchCommand } from './windows-launch.js';
import { videoEncoderArguments } from '../desktop-browser/runtime-video-profiles.js';

it('preserves portrait geometry and UTF-16 input while keeping pointer events inside the owned source', () => {
  const geometry = {
    width: 864,
    height: 1920,
    sourceWidth: 1080,
    sourceHeight: 2400,
  };
  expect(windowsInput({ kind: 'text', text: 'A🙂' }, geometry)).toBe(
    'text 0041d83dde42',
  );
  expect(
    windowsInput({ kind: 'down', button: 0, x: 432, y: 960 }, geometry),
  ).toBe('down 540 1200 0');
  expect(() =>
    windowsInput({ kind: 'move', x: 864, y: 1 }, geometry),
  ).toThrow();
  const args = videoEncoderArguments(
    { executable: 'ffmpeg', kind: 'software' },
    { width: 864, height: 1920, fps: 30, bitrate: 6_000_000, threads: 2 },
    { args: ['-f', 'rawvideo', '-i', 'fixture'], reportsChanges: true },
  );
  expect(args).toContain('scale=864:1920');
});

it('runs a known Windows package-manager shim using Node with the original argument boundaries', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'app-shim-'));
  try {
    await mkdir(join(dir, 'node_modules', 'corepack', 'dist'), {
      recursive: true,
    });
    const script = join(dir, 'node_modules', 'corepack', 'dist', 'pnpm.js');
    await writeFile(script, '');
    await writeFile(join(dir, 'node.exe'), '');
    await writeFile(
      join(dir, 'pnpm.cmd'),
      '@node "%~dp0\\node_modules\\corepack\\dist\\pnpm.js" %*',
    );
    const args = ['run', 'with spaces', '100%', 'A&B'];
    expect(
      await windowsLaunchCommand({ executable: 'pnpm', args }, { PATH: dir }, dir),
    ).toEqual({ executable: join(dir, 'node.exe'), args: [script, ...args] });
    await writeFile(join(dir, 'pnpm.cmd'), '@echo custom shim');
    await expect(
      windowsLaunchCommand({ executable: 'pnpm', args }, { PATH: dir }, dir),
    ).rejects.toThrow('Unsupported');
    await expect(
      windowsLaunchCommand({ executable: join('missing', 'pnpm.cmd'), args }, { PATH: dir }, dir),
    ).rejects.toThrow('unavailable at that path');
    // A relative launch is resolved from the task directory even when a
    // conflicting custom shim in PATH would be rejected.
    const tools = join(dir, 'tools');
    await mkdir(join(tools, 'node_modules', 'corepack', 'dist'), { recursive: true });
    const localScript = join(tools, 'node_modules', 'corepack', 'dist', 'pnpm.js');
    await writeFile(localScript, '');
    await writeFile(join(tools, 'pnpm.cmd'), '@node "%~dp0\\node_modules\\corepack\\dist\\pnpm.js" %*');
    expect(await windowsLaunchCommand({ executable: join('tools', 'pnpm.cmd'), args }, { PATH: dir }, dir))
      .toEqual({ executable: 'node.exe', args: [localScript, ...args] });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
