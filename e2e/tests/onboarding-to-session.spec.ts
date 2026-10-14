import { expect, test } from '@playwright/test';

import {
  END_SCREEN_SCREENSHOT,
  TEST_REPO_BRANCH,
  TEST_REPO_PATH,
} from '../fixtures/environment';

const PROJECT_NAME = 'E2E Project';
const TASK_NAME = 'E2E task';
const TASK_BRANCH = 'e2e-task';

/**
 * Full first-run journey, driven entirely through the UI:
 *
 *   fresh app → onboarding → create project (real git repo)
 *     → create task (isolated git worktree) → auto-created session
 *
 * Win condition: the project, repo, task (worktree) and session are all
 * visible together in the sidebar tree while sitting inside the session view.
 */
test('first run: onboarding through to a live session in the sidebar', async ({ page }, testInfo) => {
  // The seeded repo's first commit can take a moment to surface as a branch.
  test.setTimeout(180_000);
  const taskBranch = testInfo.retry ? `${TASK_BRANCH}-retry-${testInfo.retry}` : TASK_BRANCH;

  // CI retries share the backend. Remove this test's partial project and replay
  // onboarding without replacing the live database or adding a reset API.
  if (testInfo.retry) {
    const response = await page.request.get('/api/projects');
    expect(response.ok()).toBeTruthy();
    const projects: { id: number; name: string }[] = await response.json();
    for (const project of projects.filter((project) => project.name === PROJECT_NAME)) {
      const deleted = await page.request.delete(`/api/projects/${project.id}`);
      expect(deleted.ok()).toBeTruthy();
    }
    await page.route('**/api/settings', async (route) => {
      const response = await route.fetch();
      await route.fulfill({
        response,
        json: { ...await response.json(), onboardingCompletedAt: null },
      });
    });
  }

  // ---------------------------------------------------------------------------
  // 1. Onboarding — fresh database redirects "/" to "/onboarding".
  // ---------------------------------------------------------------------------
  await page.goto('/');
  await expect(page).toHaveURL(/\/onboarding$/);

  await page.getByRole('button', { name: 'Local backend' }).click();

  // Agent step: Claude is selected by default — just continue.
  await page.getByRole('button', { name: 'Continue' }).click();

  // Claude surface step: Claude UI is selected by default — finish.
  if (testInfo.retry) await page.unroute('**/api/settings');
  await page.getByRole('button', { name: 'Finish setup' }).click();

  // Onboarding complete → projects view with the sidebar.
  await expect(page).toHaveURL(/\/projects$/);
  const createProjectAction = page.locator('button[aria-label="Open repository"]');
  await expect(createProjectAction).toBeVisible();

  // ---------------------------------------------------------------------------
  // 2. Create the first project pointing at the seeded git repository.
  // ---------------------------------------------------------------------------
  await createProjectAction.click();

  const wizard = page.locator('[data-project-create]');
  await expect(wizard).toBeVisible();

  // Select a repository, then name the project on the second step.
  const repoInput = wizard.locator('input.pac__input');
  await repoInput.fill(TEST_REPO_PATH);
  // Dismiss suggestions so they cannot intercept the submit click.
  await repoInput.press('Escape');
  const continueCta = wizard.getByRole('button', { name: 'Continue', exact: true });
  await expect(continueCta).toBeEnabled();
  await continueCta.click();
  await wizard.getByLabel('Project name', { exact: true }).fill(PROJECT_NAME);

  const createCta = wizard.getByRole('button', { name: 'Open project' });
  await expect(createCta).toBeVisible();
  await expect(createCta).toBeEnabled();
  await createCta.click();

  // Wizard closes; the new project + repo land in the sidebar tree.
  await expect(wizard).toBeHidden();
  const projectRow = page.locator(`[data-project-row-id]`, { hasText: PROJECT_NAME });
  await expect(projectRow).toBeVisible();
  await expect(page.locator('.sidebar-label--repo', { hasText: 'test-repo' })).toBeVisible();

  // ---------------------------------------------------------------------------
  // 3. Create a task with an isolated environment on a brand-new branch.
  // ---------------------------------------------------------------------------
  await page.getByRole('button', { name: 'New task', exact: true }).first().click();

  const taskDialog = page.getByRole('dialog', { name: 'New task', exact: true });
  await expect(taskDialog).toBeVisible();
  await taskDialog.getByLabel('Task name').fill(TASK_NAME);
  await taskDialog.getByRole('button', { name: 'Continue', exact: true }).click();

  // The task wizard now chooses the branch and its base in separate steps.
  await taskDialog.getByRole('combobox', { name: 'Branch', exact: true }).fill(taskBranch);
  await taskDialog.getByRole('option', { name: `Create ${taskBranch} New branch`, exact: true }).click();

  // Explicitly select the seeded default branch as the base for the new task.
  // Selecting the base submits the task and starts asynchronous worktree setup.
  await expect(taskDialog.getByRole('combobox', { name: 'Base branch', exact: true })).toBeVisible();
  await taskDialog.getByRole('option', { name: new RegExp(`^${TEST_REPO_BRANCH}\\b`) }).click();
  await expect(taskDialog).toBeHidden();

  // ---------------------------------------------------------------------------
  // 4. Win condition — a session was auto-created and we land in its view,
  //    with project + repo + task + session all visible in the sidebar.
  // ---------------------------------------------------------------------------
  await expect(page).toHaveURL(/\/sessions\/\d+$/, { timeout: 60_000 });

  await expect(projectRow, 'project visible in sidebar').toBeVisible();
  await expect(
    page.locator('.sidebar-label--repo', { hasText: 'test-repo' }),
    'repo visible in sidebar',
  ).toBeVisible();
  // The worktree path is derived by the backend, so match on the row existing
  // and carrying the branch we created rather than a hard-coded path.
  await expect(
    page.locator('[data-workspace-row]', { hasText: TASK_NAME }),
    'task environment visible in sidebar',
  ).toBeVisible();
  await expect(
    page.locator('.sidebar-label--branch', { hasText: taskBranch }),
    'task branch label visible in sidebar',
  ).toBeVisible();
  await expect(
    page.locator('[data-session-row-id]').first(),
    'session visible in sidebar',
  ).toBeVisible();

  // Capture the win screen: save to a stable path that CI uploads as its own
  // artifact, and attach it to the Playwright HTML report.
  await page.screenshot({ path: END_SCREEN_SCREENSHOT });
  await test.info().attach('end-screen', {
    path: END_SCREEN_SCREENSHOT,
    contentType: 'image/png',
  });
});
