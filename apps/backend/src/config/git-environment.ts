const REPOSITORY_ENV_KEYS = new Set([
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_COMMON_DIR',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_QUARANTINE_PATH',
  'GIT_NAMESPACE',
  'GIT_PREFIX',
  'GIT_INTERNAL_SUPER_PREFIX',
  'GIT_IMPLICIT_WORK_TREE',
  'GIT_SHALLOW_FILE',
  'GIT_GRAFT_FILE',
  'GIT_REPLACE_REF_BASE',
  'GIT_NO_REPLACE_OBJECTS',
  'GIT_CONFIG',
  'GIT_CONFIG_PARAMETERS',
  'GIT_CONFIG_COUNT',
  'GIT_LITERAL_PATHSPECS',
  'GIT_GLOB_PATHSPECS',
  'GIT_NOGLOB_PATHSPECS',
  'GIT_ICASE_PATHSPECS',
]);

/**
 * A Git operation belongs to its explicit cwd. Backends launched from hooks,
 * IDEs or shells can inherit another repository's environment; forwarding it
 * can read or mutate that repository instead. Preserve authentication, global
 * config and executable lookup. Callers can add intentional overrides, such as
 * a temporary GIT_INDEX_FILE, after this boundary.
 */
export function isolateGitEnvironment(
  environment: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const isolated = { ...environment };
  for (const key of Object.keys(isolated)) {
    const name = process.platform === 'win32' ? key.toUpperCase() : key;
    if (
      REPOSITORY_ENV_KEYS.has(name) ||
      /^GIT_CONFIG_(KEY|VALUE)_\d+$/.test(name)
    )
      delete isolated[key];
  }
  return isolated;
}
