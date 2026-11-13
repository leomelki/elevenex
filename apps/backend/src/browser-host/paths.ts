import { createRequire } from 'node:module';
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  sep,
} from 'node:path';
import { chromium } from 'playwright-core';
import { getElevenexDataRoot } from '../config/app-data-paths.js';

export function managedBrowserExecutable(
  cache: string,
  configured = chromium.executablePath(),
): string {
  const parts = configured.split(sep);
  const index = parts.findIndex((part) => /^chromium-[0-9]+$/.test(part));
  if (index < 0)
    throw new Error('Browser distribution is not supported on this host');
  return join(cache, ...parts.slice(index));
}

export function playwrightInstaller(): string {
  return join(
    dirname(createRequire(__filename).resolve('playwright-core/package.json')),
    'cli.js',
  );
}

export function browserSetupEntry(): string {
  return extname(__filename) === '.cjs'
    ? join(__dirname, 'browser-setup.cjs')
    : join(__dirname, 'cli.js');
}

/** Display-only shell quoting; execution always uses argv arrays. */
export function browserSetupCommand(
  system = false,
  dataRoot = getElevenexDataRoot(),
  entry = browserSetupEntry(),
  executable = process.execPath,
  platform = process.platform,
  electron = !!process.versions.electron,
): string {
  const args = [
    entry,
    '--data-root',
    dataRoot,
    ...(system ? ['--system'] : []),
  ];
  if (platform === 'win32') {
    const quote = (value: string) => "'" + value.replace(/'/g, "''") + "'";
    return `${electron ? "$env:ELECTRON_RUN_AS_NODE='1'; " : ''}& ${[executable, ...args].map(quote).join(' ')}`;
  }
  const quote = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'";
  const directory = dirname(entry);
  const localNode = relative(directory, executable);
  const node =
    !isAbsolute(localNode) && !localNode.startsWith('..')
      ? './' + localNode
      : executable;
  return `cd ${quote(directory)} && ${system ? 'sudo -- ' : ''}${electron ? 'env ELECTRON_RUN_AS_NODE=1 ' : ''}${[node, basename(entry), ...args.slice(1)].map(quote).join(' ')}`;
}
