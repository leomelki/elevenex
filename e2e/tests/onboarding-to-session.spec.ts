import { expect, test } from '@playwright/test';

import {
  END_SCREEN_SCREENSHOT,
  TEST_REPO_BRANCH,
  TEST_REPO_PATH,
} from '../fixtures/environment';

const PROJECT_NAME = 'E2E Project';
const WORKSPACE_BRANCH = 'e2e-workspace';

/**
 * Full first-run journey, driven entirely through the UI:
 *
 *   fresh app → onboarding → create project (real git repo)
 *     → create workspace (git worktree) → auto-created session
 *
 * Win condition: the project, repo, workspace (worktree) and session are all
 * visible together in the sidebar tree while sitting inside the session view.
 */
test('first run: onboarding through to a live session in the sidebar', async ({ page }) => {
  // The seeded repo's first commit can take a moment to surface as a branch.
  test.setTimeout(180_000);

  // ---------------------------------------------------------------------------
  // 1. Onboarding — fresh database redirects "/" to "/onboarding".
  // ---------------------------------------------------------------------------
  await page.goto('/');
  await expect(page).toHaveURL(/\/onboarding$/);

  await page.getByRole('button', { name: 'Local backend' }).click();

  // Agent step: Claude is selected by default — just continue.
  await page.getByRole('button', { name: 'Continue' }).click();

  // Claude surface step: Claude UI is selected by default — finish.
  await page.getByRole('button', { name: 'Finish setup' }).click();

  // Onboarding complete → projects view with the sidebar.
  await expect(page).toHaveURL(/\/projects$/);
  // The sidebar header's "Create project" action (aria-label) — distinct from
  // the empty-state button and the wizard's submit CTA that share the label.
  const createProjectAction = page.locator('button[aria-label="Create project"]');
  await expect(createProjectAction).toBeVisible();

  // ---------------------------------------------------------------------------
  // 2. Create the first project pointing at the seeded git repository.
  // ---------------------------------------------------------------------------
  await createProjectAction.click();

  const wizard = page.locator('.project-wizard-panel');
  await expect(wizard).toBeVisible();

  // Step: project name.
  await wizard
    .getByPlaceholder('Infra platform, storefront, mobile app...')
    .fill(PROJECT_NAME);
  await clickWizardNext(page);

  // Step: repositories. Target the inner <input> of the path autocomplete
  // (its host element also carries the placeholder attribute).
  const repoInput = wizard.locator('input.pac__input');
  await repoInput.fill(TEST_REPO_PATH);
  // Dismiss the path-autocomplete overlay so it can't intercept the Next click.
  await repoInput.press('Escape');
  await clickWizardNext(page);

  // Local backend has no port-forward step, so we're now on the review step.
  const createCta = wizard.getByRole('button', { name: 'Create project' });
  await expect(createCta).toBeVisible();
  await createCta.click();

  // Wizard closes; the new project + repo land in the sidebar tree.
  await expect(wizard).toBeHidden();
  const projectRow = page.locator(`[data-project-row-id]`, { hasText: PROJECT_NAME });
  await expect(projectRow).toBeVisible();
  await expect(page.locator('.sidebar-label--repo', { hasText: 'test-repo' })).toBeVisible();

  // ---------------------------------------------------------------------------
  // 3. Create a workspace (git worktree) on a brand-new branch.
  // ---------------------------------------------------------------------------
  await page.getByRole('button', { name: 'New workspace' }).first().click();

  // Branch search dialog: type a new branch name and create it.
  const branchFilter = page.getByPlaceholder('Filter branches...');
  await expect(branchFilter).toBeVisible();
  await branchFilter.fill(WORKSPACE_BRANCH);
  await page.getByRole('button', { name: `Create "${WORKSPACE_BRANCH}"` }).click();

  // Origin step: base the new branch on the seeded default branch.
  await page
    .getByRole('button', { name: new RegExp(`^${TEST_REPO_BRANCH}\\b`) })
    .click();

  // Worktree sheet: create a fresh worktree (pool is empty on first run).
  await page.getByRole('button', { name: 'Create a new worktree' }).click();
  await page.getByRole('button', { name: 'Create and link' }).click();

  // ---------------------------------------------------------------------------
  // 4. Win condition — a session was auto-created and we land in its view,
  //    with project + repo + workspace + session all visible in the sidebar.
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
    page.locator('[data-workspace-row]').first(),
    'worktree visible in sidebar',
  ).toBeVisible();
  await expect(
    page.locator('.sidebar-label--branch', { hasText: WORKSPACE_BRANCH }),
    'worktree branch label visible in sidebar',
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

/** Click the wizard's "Next" button and wait for it to advance. */
async function clickWizardNext(page: import('@playwright/test').Page) {
  const next = page.locator('.project-wizard-footer').getByRole('button', { name: 'Next' });
  await expect(next).toBeEnabled();
  await next.click();
}
