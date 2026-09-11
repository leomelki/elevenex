import {
  ELEVENEX_BACKEND_MODE_ENV,
  getBackendRuntimeMode,
  shouldUseTmux,
} from './backend-runtime-mode.js';

describe('backend runtime mode', () => {
  it('defaults to local so ordinary backend starts never use tmux', () => {
    expect(getBackendRuntimeMode({})).toBe('local');
    expect(shouldUseTmux({}, 'linux')).toBe(false);
    expect(shouldUseTmux({}, 'darwin')).toBe(false);
  });

  it('uses tmux only for explicitly remote POSIX runtimes', () => {
    const env = { [ELEVENEX_BACKEND_MODE_ENV]: 'remote' };

    expect(getBackendRuntimeMode(env)).toBe('remote');
    expect(shouldUseTmux(env, 'linux')).toBe(true);
    expect(shouldUseTmux(env, 'darwin')).toBe(true);
  });

  it('keeps Windows remote runtimes on native process management', () => {
    const env = { [ELEVENEX_BACKEND_MODE_ENV]: 'remote' };

    expect(shouldUseTmux(env, 'win32')).toBe(false);
  });

  it('treats unknown mode values as local', () => {
    expect(
      getBackendRuntimeMode({ [ELEVENEX_BACKEND_MODE_ENV]: 'unexpected' }),
    ).toBe('local');
  });
});
