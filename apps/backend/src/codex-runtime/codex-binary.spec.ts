import { selectCodexBinary } from './codex-binary.js';

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
