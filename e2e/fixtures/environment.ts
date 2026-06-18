import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';

/**
 * Shared, deterministic locations for the end-to-end run.
 *
 * Both the Playwright config (which boots the backend) and the test specs
 * import these so the backend, the seeded git repository and the assertions
 * all agree on where things live.
 */
export const E2E_ROOT = path.resolve(__dirname, '..');
export const TMP_DIR = path.join(E2E_ROOT, '.tmp');

/** Fresh sqlite database so the app always starts at onboarding. */
export const DB_PATH = path.join(TMP_DIR, 'elevenex-e2e.db');

/** A real git repository the wizard can attach as the first project repo. */
export const TEST_REPO_PATH = path.join(TMP_DIR, 'test-repo');

/** Default branch of the seeded repository (origin for the new workspace). */
export const TEST_REPO_BRANCH = 'main';

/** Ports the dev servers listen on (matches apps/frontend/proxy.conf.json). */
export const BACKEND_PORT = 11111;
export const FRONTEND_PORT = 4200;

function git(args: string[], cwd: string) {
  execFileSync('git', args, {
    cwd,
    stdio: 'pipe',
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
      // Keep the seeded commit reproducible and independent of any global config.
      GIT_AUTHOR_NAME: 'Elevenex E2E',
      GIT_AUTHOR_EMAIL: 'e2e@elevenex.test',
      GIT_COMMITTER_NAME: 'Elevenex E2E',
      GIT_COMMITTER_EMAIL: 'e2e@elevenex.test',
    },
  });
}

/**
 * Wipe and recreate the temp directory, then seed a one-commit git repo.
 *
 * Runs once at config-load time, before the backend boots, so every run
 * starts from a clean database and a known-good repository. This is a
 * test-setup script (not a backend hot path), so synchronous git calls are
 * fine here.
 */
export function prepareE2eEnvironment(): void {
  rmSync(TMP_DIR, { recursive: true, force: true });
  mkdirSync(TEST_REPO_PATH, { recursive: true });

  git(['-c', `init.defaultBranch=${TEST_REPO_BRANCH}`, 'init'], TEST_REPO_PATH);
  // Repo-local identity as well, so worktree operations never need global config.
  git(['config', 'user.name', 'Elevenex E2E'], TEST_REPO_PATH);
  git(['config', 'user.email', 'e2e@elevenex.test'], TEST_REPO_PATH);

  writeFileSync(
    path.join(TEST_REPO_PATH, 'README.md'),
    '# Elevenex E2E test repository\n\nSeeded by the Playwright onboarding flow.\n',
  );
  git(['add', 'README.md'], TEST_REPO_PATH);
  git(['commit', '-m', 'chore: seed e2e repository'], TEST_REPO_PATH);
}
