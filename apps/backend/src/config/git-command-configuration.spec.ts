import { isolateGitEnvironment } from './git-environment.js';

const quote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;

describe('inherited Git command configuration', () => {
  it('retains performance, authentication and policy settings unchanged', () => {
    const env = {
      GIT_CONFIG_COUNT: '3',
      GIT_CONFIG_KEY_0: 'core.untrackedCache',
      GIT_CONFIG_VALUE_0: 'true',
      GIT_CONFIG_KEY_1: 'credential.helper',
      GIT_CONFIG_VALUE_1: '!helper with spaces',
      GIT_CONFIG_KEY_2: 'core.fsmonitor',
      GIT_CONFIG_VALUE_2: '/custom hook',
      GIT_CONFIG_PARAMETERS: `${quote('core.preloadIndex=true')} ${quote("user.name=O'Brien!")}`,
      GIT_ALTERNATE_OBJECT_DIRECTORIES: '/shared/read-only/objects',
      GIT_NO_REPLACE_OBJECTS: '1',
      GIT_REPLACE_REF_BASE: 'refs/custom-replace',
      GIT_INDEX_VERSION: '4',
      GIT_CONFIG_NOSYSTEM: '1',
    };
    expect(isolateGitEnvironment(env)).toEqual(env);
  });

  it('removes redirection pairs and keeps the ordering and values of other pairs', () => {
    const env = {
      GIT_CONFIG_COUNT: '4',
      GIT_CONFIG_KEY_0: 'core.preloadIndex',
      GIT_CONFIG_VALUE_0: 'false',
      GIT_CONFIG_KEY_1: 'Core.WorkTree',
      GIT_CONFIG_VALUE_1: '/foreign',
      GIT_CONFIG_KEY_2: 'core.preloadIndex',
      GIT_CONFIG_VALUE_2: 'true',
      GIT_CONFIG_KEY_3: 'includeIf.gitdir:/foreign/.path',
      GIT_CONFIG_VALUE_3: '/foreign/config',
    };
    expect(isolateGitEnvironment(env)).toEqual({
      GIT_CONFIG_COUNT: '2',
      GIT_CONFIG_KEY_0: 'core.preloadIndex',
      GIT_CONFIG_VALUE_0: 'false',
      GIT_CONFIG_KEY_1: 'core.preloadIndex',
      GIT_CONFIG_VALUE_1: 'true',
    });
    expect(env.GIT_CONFIG_COUNT).toBe('4');
  });

  it.each([
    `${quote('core.worktree=/foreign')} ${quote("credential.helper=!helper 'quoted' $(literal)")}`,
    `${quote('core.worktree')}=${quote('/foreign')} ${quote('credential.helper')}=${quote("!helper 'quoted' $(literal)")}`,
  ])(
    'handles Git parameter encoding without evaluating values: %s',
    (parameters) => {
      const result = isolateGitEnvironment({
        GIT_CONFIG_PARAMETERS: parameters,
      });
      expect(result.GIT_CONFIG_PARAMETERS).not.toContain('core.worktree');
      expect(result.GIT_CONFIG_PARAMETERS).toContain('credential.helper');
      expect(result.GIT_CONFIG_PARAMETERS).toContain('$(literal)');
    },
  );

  it('preserves modern implicit booleans and escaped exclamation marks', () => {
    const parameters =
      "'core.preloadindex'= 'test.value'='wow'\\!'ok' 'core.worktree'='/foreign'";
    expect(
      isolateGitEnvironment({ GIT_CONFIG_PARAMETERS: parameters }),
    ).toEqual({
      GIT_CONFIG_PARAMETERS: "'core.preloadindex'= 'test.value'='wow'\\!'ok'",
    });
  });

  it('does not mistake a subsection or a value for a workspace override', () => {
    const parameters = `${quote('remote.core.worktree.url=https://example.test')} ${quote('test.value=core.worktree=/foreign')}`;
    expect(
      isolateGitEnvironment({ GIT_CONFIG_PARAMETERS: parameters }),
    ).toEqual({ GIT_CONFIG_PARAMETERS: parameters });
  });

  it.each([
    { GIT_CONFIG_COUNT: '999999999999999999999' },
    { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'test.value' },
    { GIT_CONFIG_PARAMETERS: "'test.value=private-token" },
    { GIT_CONFIG_PARAMETERS: "'test.value'='private-token'trailing" },
  ])('rejects malformed configuration without disclosing its values', (env) => {
    expect(() => isolateGitEnvironment(env)).toThrow(
      'Invalid inherited Git command configuration.',
    );
    try {
      isolateGitEnvironment(env);
    } catch (error) {
      expect(String(error)).not.toContain('private-token');
    }
  });
});
