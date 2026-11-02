# Elevenex end-to-end tests

Playwright tests that drive the real app (Angular frontend + NestJS backend)
through the first-run journey.

## What it covers

`tests/onboarding-to-session.spec.ts` runs the full happy path, entirely
through the UI:

1. Fresh app → onboarding (local backend, Claude, Claude UI)
2. Create the first project pointing at a seeded git repository
3. Create a workspace (git worktree) on a new branch
4. A session is auto-created and we land in its view

**Win condition:** the project, repo, worktree and session are all visible
together in the sidebar tree.

## How it runs

`playwright.config.ts` boots both dev servers itself (`webServer`):

- backend on `http://127.0.0.1:11111` with a throwaway `DB_PATH`
- frontend (`ng serve`) on `http://127.0.0.1:4200`

Before the servers start, `fixtures/environment.ts` wipes `.tmp/` and seeds a
one-commit git repo at `.tmp/test-repo`, so every run starts from a clean
database (which forces onboarding) and a known-good repository.

No `claude` binary is required: creating the session only writes a database
row — the agent process is spawned later, when a session is opened.

## Running locally

```bash
# from the repo root
pnpm install
pnpm --dir e2e exec playwright install chromium   # one-time
pnpm e2e                                           # or: pnpm --dir e2e test
```

Useful variants (run from `e2e/`):

```bash
pnpm test:headed   # watch it drive a real browser
pnpm test:ui       # Playwright UI mode
pnpm report        # open the last HTML report
```

## CI

`.github/workflows/e2e.yml` runs this on pushes to `main`/`master` and on pull
requests. Reports, traces and videos are uploaded as artifacts.
