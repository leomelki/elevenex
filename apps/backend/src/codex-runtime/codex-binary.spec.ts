import {
  codexBinaryIdentity,
  selectCodexBinary,
} from './codex-binary.js';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('Codex executable identity', () => {
  it('detects an upgrade at the same path without launching another process', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'codex-binary-'));
    const binary = join(directory, 'codex');
    try {
      await writeFile(binary, 'first installation');
      const first = await codexBinaryIdentity(binary);
      expect(first).not.toBeNull();
      expect(await codexBinaryIdentity(binary)).toBe(first);
      await writeFile(binary, 'updated installation with a different executable');
      expect(await codexBinaryIdentity(binary)).not.toBe(first);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe('selectCodexBinary', () => {
  it('uses the installed CLI so model discovery and execution stay current', () => {
    expect(selectCodexBinary('/usr/local/bin/codex')).toBe(
      '/usr/local/bin/codex',
    );
  });

  it('uses the command name when Codex is not installed', () => {
    expect(selectCodexBinary(null)).toBe('codex');
  });

  it('honors an explicit binary without assuming how it was installed', () => {
    expect(
      selectCodexBinary('/usr/local/bin/codex', '/custom/tools/codex'),
    ).toBe('/custom/tools/codex');
  });
});
