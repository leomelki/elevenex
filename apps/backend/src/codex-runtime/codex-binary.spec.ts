import {
  selectCodexBinary,
  selectCodexSdkBinaryOverride,
} from './codex-binary.js';

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
