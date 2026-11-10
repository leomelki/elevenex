import {
  codexBinaryIdentity,
  resolveCodexBinary,
  selectCodexBinary,
} from './codex-binary.js';
import * as fs from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { clearBinaryPathCache } from '../config/system-paths.js';

describe('resolveCodexBinary', () => {
  let originalEnv: NodeJS.ProcessEnv;
  let executables: Set<string>;

  beforeEach(() => {
    originalEnv = process.env;
    process.env = { ...originalEnv, PATH: '/tools/first' };
    delete process.env.ELEVENEX_CODEX_BIN;
    clearBinaryPathCache();
    executables = new Set();
    jest
      .spyOn(jest.requireActual<typeof fs>('fs'), 'accessSync')
      .mockImplementation((candidate) => {
        if (!executables.has(String(candidate))) throw new Error('unavailable');
      });
  });

  afterEach(() => {
    jest.restoreAllMocks();
    process.env = originalEnv;
    clearBinaryPathCache();
  });

  it('uses the shared PATH resolution for the installed CLI', () => {
    const installed = join('/tools/first', 'codex');
    executables.add(installed);
    executables.add(join('/usr/local/bin', 'codex'));

    expect(resolveCodexBinary()).toBe(installed);
  });

  it('keeps an explicit runtime path ahead of even a cached installed CLI', () => {
    executables.add(join('/tools/first', 'codex'));
    expect(resolveCodexBinary()).toBe(join('/tools/first', 'codex'));
    process.env.ELEVENEX_CODEX_BIN = '  /custom/codex  ';

    expect(resolveCodexBinary()).toBe('/custom/codex');
  });

  it('resolves a configured command using PATH order before common directories', () => {
    process.env.PATH = ['/tools/first', '/tools/second'].join(delimiter);
    process.env.ELEVENEX_CODEX_BIN = 'custom-codex';
    executables.add(join('/tools/first', 'codex'));
    executables.add(join('/tools/first', 'custom-codex'));
    executables.add(join('/tools/second', 'custom-codex'));
    executables.add(join('/usr/local/bin', 'custom-codex'));

    expect(resolveCodexBinary()).toBe(join('/tools/first', 'custom-codex'));
  });

  it('keeps the command-name fallback when no installation can be found', () => {
    expect(resolveCodexBinary()).toBe('codex');
  });
});

describe('Codex executable identity', () => {
  it('detects an upgrade at the same path without launching another process', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'codex-binary-'));
    const binary = join(directory, 'codex');
    try {
      await writeFile(binary, 'first installation');
      const first = await codexBinaryIdentity(binary);
      expect(first).not.toBeNull();
      expect(await codexBinaryIdentity(binary)).toBe(first);
      await writeFile(
        binary,
        'updated installation with a different executable',
      );
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
