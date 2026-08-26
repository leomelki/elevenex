import { selectCodexBinary } from './codex-binary.js';

describe('selectCodexBinary', () => {
  it('prefers the installed CLI so model discovery uses the current Codex version', () => {
    expect(selectCodexBinary('/usr/local/bin/codex', '/app/codex')).toBe(
      '/usr/local/bin/codex',
    );
  });

  it('falls back to the bundled CLI when Codex is not installed', () => {
    expect(selectCodexBinary(null, '/app/codex')).toBe('/app/codex');
  });

  it('uses the command name as a final fallback', () => {
    expect(selectCodexBinary(null, null)).toBe('codex');
  });
});
