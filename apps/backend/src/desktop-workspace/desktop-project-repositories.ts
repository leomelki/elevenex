import { BadRequestException, ConflictException } from '@nestjs/common';
import { mkdir, realpath, rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { execFileAsync } from '../terminal/async-process.js';

/** Only network Git transports; never Git's executable helpers or local paths. */
export function cloneRepositoryName(value: string): string | null {
  let pathname: string;
  if (/^git@[a-z0-9.-]+:[^\s?#]+$/i.test(value))
    pathname = value.slice(value.indexOf(':') + 1);
  else {
    try {
      const url = new URL(value);
      if (
        !['https:', 'ssh:'].includes(url.protocol) ||
        !url.hostname ||
        url.password ||
        url.search ||
        url.hash ||
        (url.protocol === 'https:' && url.username)
      )
        return null;
      pathname = url.pathname;
    } catch {
      return null;
    }
  }
  const name = basename(pathname.replace(/\/+$/, '')).replace(/\.git$/, '');
  return /^[a-z0-9][a-z0-9._-]{0,99}$/i.test(name) ? name : null;
}

export interface ProjectRepositorySetup {
  readonly path: string;
  readonly clone?: string;
  readonly initialize?: boolean;
}

function absolutePath(value: string): string {
  const expanded =
    value === '~' || value.startsWith('~/')
      ? homedir() + value.slice(1)
      : value;
  if (!isAbsolute(expanded) || expanded.includes('\0'))
    throw new BadRequestException('Choose an absolute repository path.');
  return resolve(expanded);
}

/** Validate the entire selection before touching disk; legacy paths stay read-only. */
export async function prepareProjectRepositories(
  entries: readonly ProjectRepositorySetup[],
  signal: AbortSignal,
): Promise<readonly string[]> {
  const normalized = await Promise.all(
    entries.map(async (entry) => {
      const path = absolutePath(entry.path);
      if (entry.clone) {
        const name = cloneRepositoryName(entry.clone);
        if (!name || path !== join(homedir(), 'code', name))
          throw new BadRequestException(
            'Invalid clone destination or Git URL.',
          );
        if (await stat(path).catch(() => null))
          throw new ConflictException(
            'The clone destination already exists. Choose its folder instead.',
          );
        return { ...entry, path };
      }
      const info = await stat(path).catch(() => null);
      if (!info?.isDirectory())
        throw new BadRequestException(
          'The repository folder could not be found.',
        );
      return { ...entry, path: await realpath(path) };
    }),
  );
  signal.throwIfAborted();
  if (new Set(normalized.map((entry) => entry.path)).size !== entries.length)
    throw new BadRequestException('Duplicate repository paths.');
  // Reject invalid existing entries before a different entry starts setup.
  for (const entry of normalized) {
    if (
      !entry.clone &&
      !entry.initialize &&
      !(await stat(join(entry.path, '.git')).catch(() => null))
    )
      throw new BadRequestException(
        'Choose the root folder of a Git repository.',
      );
  }
  for (const entry of normalized) {
    signal.throwIfAborted();
    if (entry.clone) {
      await mkdir(join(homedir(), 'code'), { recursive: true }).catch(() => {
        throw new BadRequestException(
          'The clone destination could not be created. Check folder permissions.',
        );
      });
      try {
        await mkdir(entry.path);
      } catch {
        throw new ConflictException(
          'The clone destination already exists. Choose its folder instead.',
        );
      }
      try {
        await git(
          [
            '-c',
            'protocol.allow=never',
            '-c',
            'protocol.https.allow=always',
            '-c',
            'protocol.ssh.allow=always',
            'clone',
            '--quiet',
            '--',
            entry.clone,
            entry.path,
          ],
          join(homedir(), 'code'),
          signal,
        );
      } catch (error) {
        // This request exclusively created the destination; never remove a pre-existing folder.
        await rm(entry.path, { recursive: true, force: true });
        throw error;
      }
    } else if (
      entry.initialize &&
      !(await stat(join(entry.path, '.git')).catch(() => null))
    ) {
      await git(['init', '--initial-branch=main'], entry.path, signal);
      // An empty root commit enables isolated task workspaces without committing the person's files.
      await git(
        [
          '-c',
          'user.name=Elevenex',
          '-c',
          'user.email=elevenex@localhost',
          '-c',
          'commit.gpgsign=false',
          'commit',
          '--allow-empty',
          '--no-verify',
          '-m',
          'Initialize repository',
        ],
        entry.path,
        signal,
      );
    }
  }
  return normalized.map((entry) => entry.path);
}

async function git(
  args: readonly string[],
  cwd: string,
  signal: AbortSignal,
): Promise<void> {
  try {
    await execFileAsync('git', args, {
      cwd,
      signal,
      timeout: 120_000,
      maxBuffer: 64 * 1024,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
        GIT_SSH_COMMAND: 'ssh -oBatchMode=yes -oStrictHostKeyChecking=yes',
      },
    });
  } catch {
    signal.throwIfAborted();
    throw new BadRequestException(
      'Repository setup failed. Check Git access and folder permissions.',
    );
  }
}
