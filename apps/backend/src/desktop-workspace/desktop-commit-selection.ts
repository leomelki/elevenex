import { BadRequestException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { worktreeSimpleGit } from '../config/system-paths.js';
import type { GitStatusSummary } from '../git/git.service.js';

export interface CommitSelection {
  includeUnstaged: boolean;
  excluded: string[];
  includedSecrets: string[];
}
export function commitSelection(value: unknown): CommitSelection {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new BadRequestException('Invalid commit selection.');
  const raw = value as Record<string, unknown>;
  const paths = (value: unknown): string[] => {
    if (
      !Array.isArray(value) ||
      value.length > 1000 ||
      value.some(
        (path) =>
          typeof path !== 'string' ||
          !path ||
          path.length > 4096 ||
          path.includes('\0') ||
          path.startsWith('/') ||
          path.split('/').includes('..'),
      )
    )
      throw new BadRequestException('Invalid commit paths.');
    const paths = value as string[];
    if (paths.reduce((bytes, path) => bytes + path.length, 0) > 65536)
      throw new BadRequestException('Commit selection exceeds its size limit.');
    return [...new Set(paths)];
  };
  if (typeof raw.includeUnstaged !== 'boolean')
    throw new BadRequestException('Invalid commit selection.');
  return {
    includeUnstaged: raw.includeUnstaged,
    excluded: paths(raw.excluded),
    includedSecrets: paths(raw.includedSecrets),
  };
}
export function mayHoldSecrets(path: string): boolean {
  return (
    /^(\.env(?:\..*)?|id_(?:rsa|ed25519|ecdsa)|credentials(?:\..*)?)$/i.test(
      basename(path),
    ) || /\.(?:pem|key|p12|pfx)$/i.test(path)
  );
}
export async function commitRevision(
  path: string,
  status: GitStatusSummary,
): Promise<string> {
  const indexPath = resolve(
    path,
    (
      await worktreeSimpleGit(path, { readOnly: true }).raw([
        'rev-parse',
        '--git-path',
        'index',
      ])
    ).trim(),
  );
  const index = await readFile(indexPath);
  return createHash('sha256')
    .update(index)
    .update(
      JSON.stringify([
        status.headSha,
        [
          ...new Set(
            status.files.map((file) =>
              JSON.stringify([file.path, file.oldPath ?? null]),
            ),
          ),
        ].sort(),
      ]),
    )
    .digest('hex');
}
export function selectedPaths(
  status: GitStatusSummary,
  selection: CommitSelection,
): string[] {
  const excluded = new Set(selection.excluded),
    secrets = new Set(selection.includedSecrets);
  return [
    ...new Set(
      status.files
        .filter(
          (file) =>
            (selection.includeUnstaged || file.staged) &&
            !excluded.has(file.path) &&
            (!mayHoldSecrets(file.path) || secrets.has(file.path)),
        )
        .map((file) => file.path),
    ),
  ];
}
