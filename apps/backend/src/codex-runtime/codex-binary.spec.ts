import {
  findNativeWindowsCodexBinary,
  selectCodexBinary,
  selectCodexSdkBinaryOverride,
} from './codex-binary.js';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

describe('selectCodexBinary', () => {
  it('uses the installed CLI so model discovery and execution stay current', () => {
    expect(selectCodexBinary('/usr/local/bin/codex')).toBe(
      '/usr/local/bin/codex',
    );
  });

  it('uses the command name when Codex is not installed', () => {
    expect(selectCodexBinary(null)).toBe('codex');
  });
});

describe('selectCodexSdkBinaryOverride', () => {
  it('omits Windows npm shims that the SDK cannot spawn directly', () => {
    expect(
      selectCodexSdkBinaryOverride('C:\\Users\\me\\bin\\codex.cmd', 'win32'),
    ).toBeUndefined();
    expect(
      selectCodexSdkBinaryOverride('C:\\Tools\\codex.BAT', 'win32'),
    ).toBeUndefined();
  });

  it('uses the native executable behind a Windows npm shim', () => {
    expect(
      selectCodexSdkBinaryOverride(
        'C:\\Users\\me\\bin\\codex.cmd',
        'win32',
        'C:\\Users\\me\\bin\\node_modules\\@openai\\codex-win32-x64\\vendor\\x86_64-pc-windows-msvc\\codex\\codex.exe',
      ),
    ).toMatch(/codex\.exe$/);
  });

  it('keeps native Windows executables', () => {
    expect(selectCodexSdkBinaryOverride('C:\\Tools\\codex.exe', 'win32')).toBe(
      'C:\\Tools\\codex.exe',
    );
  });

  it('lets the SDK resolve its packaged binary when Windows has no CLI', () => {
    expect(selectCodexSdkBinaryOverride(null, 'win32')).toBeUndefined();
  });

  it('preserves POSIX installed and PATH-resolved launchers', () => {
    expect(selectCodexSdkBinaryOverride('/usr/local/bin/codex', 'linux')).toBe(
      '/usr/local/bin/codex',
    );
    expect(selectCodexSdkBinaryOverride(null, 'darwin')).toBe('codex');
  });
});

describe('findNativeWindowsCodexBinary', () => {
  it('resolves the platform package installed beside an npm global shim', () => {
    const npmRoot = mkdtempSync(path.join(tmpdir(), 'elevenex-codex-'));
    try {
      const codexPackageRoot = path.join(
        npmRoot,
        'node_modules',
        '@openai',
        'codex',
      );
      const packageRoot = path.join(
        npmRoot,
        'node_modules',
        '@openai',
        'codex-win32-x64',
      );
      const binaryPath = path.join(
        packageRoot,
        'vendor',
        'x86_64-pc-windows-msvc',
        'codex',
        'codex.exe',
      );
      mkdirSync(codexPackageRoot, { recursive: true });
      mkdirSync(path.dirname(binaryPath), { recursive: true });
      writeFileSync(
        path.join(codexPackageRoot, 'package.json'),
        JSON.stringify({ name: '@openai/codex' }),
      );
      writeFileSync(
        path.join(packageRoot, 'package.json'),
        JSON.stringify({ name: '@openai/codex-win32-x64' }),
      );
      writeFileSync(binaryPath, '');

      expect(
        findNativeWindowsCodexBinary(path.join(npmRoot, 'codex.cmd'), 'x64'),
      ).toBe(binaryPath);
    } finally {
      rmSync(npmRoot, { recursive: true, force: true });
    }
  });
});
