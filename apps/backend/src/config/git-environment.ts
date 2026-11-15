import { filterGitCommandConfiguration } from './git-command-configuration.js';

const REPOSITORY_ENV_KEYS = new Set([
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_COMMON_DIR',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_QUARANTINE_PATH',
  'GIT_NAMESPACE',
  'GIT_PREFIX',
  'GIT_INTERNAL_SUPER_PREFIX',
  'GIT_IMPLICIT_WORK_TREE',
  'GIT_SHALLOW_FILE',
  'GIT_GRAFT_FILE',
  'GIT_CONFIG',
  'GIT_LITERAL_PATHSPECS',
  'GIT_GLOB_PATHSPECS',
  'GIT_NOGLOB_PATHSPECS',
  'GIT_ICASE_PATHSPECS',
]);

/**
 * A Git operation belongs to its explicit cwd. Backends launched from hooks,
 * IDEs or shells can inherit another repository's environment; forwarding it
 * can read or mutate that repository instead. Preserve authentication, global
 * config, read-only object caches and executable lookup. Filter inherited
 * command config only where it can redirect the workspace. Callers can add
 * intentional overrides, such as a temporary GIT_INDEX_FILE, afterwards.
 */
export function isolateGitEnvironment(
  environment: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const isolated = { ...environment };
  for (const key of Object.keys(isolated)) {
    const name = process.platform === 'win32' ? key.toUpperCase() : key;
    if (REPOSITORY_ENV_KEYS.has(name)) delete isolated[key];
    else if (
      name !== key &&
      /^GIT_CONFIG_(COUNT|PARAMETERS|KEY_\d+|VALUE_\d+)$/.test(name)
    ) {
      isolated[name] = isolated[key];
      delete isolated[key];
    }
  }
  filterGitCommandConfiguration(isolated);
  return isolated;
}
