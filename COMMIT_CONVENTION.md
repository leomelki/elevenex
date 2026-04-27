# Commit Convention

This repository follows the Conventional Commits format:

```text
<type>(<optional scope>): <description>

<optional body>

<optional footer(s)>
```

Primary examples:

- `feat(auth): add SSO callback handling`
- `fix(api): reject invalid workspace ids`
- `docs(readme): clarify local setup`
- `refactor(frontend): simplify tab state`
- `chore(deps): bump drizzle-kit`
- `feat(router)!: remove legacy route aliases`

## Rules

- Use a lowercase type.
- Use an optional lowercase scope when it helps, for example `backend`, `frontend`, `auth`, `db`, `api`, `deps`, or a package/app name.
- Write the description in imperative mood, for example `add`, `fix`, `remove`, `refactor`.
- Keep the description concise and do not end it with a period.
- Prefer `type(scope): description` when a scope is clear.
- Use `!` after the type or scope for breaking changes, for example `feat(api)!: remove v1 endpoints`.
- Add a `BREAKING CHANGE:` footer when the change is breaking and the impact needs explanation.

## Allowed Types

- `feat`: a new feature
- `fix`: a bug fix
- `docs`: documentation-only changes
- `style`: formatting or whitespace changes with no behavior change
- `refactor`: code changes that neither fix a bug nor add a feature
- `perf`: performance improvements
- `test`: add or update tests
- `build`: build system or dependency changes
- `ci`: CI configuration or workflow changes
- `chore`: maintenance work that does not fit the categories above
- `revert`: revert a previous commit

## Body

Use the body when the why is not obvious from the subject line.

- Separate the body from the header with a blank line.
- Explain motivation, context, and important implementation decisions.
- Wrap long lines if needed for readability.

Example:

```text
fix(sync): avoid duplicate project refresh

The refresh job could be queued twice when the websocket reconnects
during the initial bootstrap phase. Guard the second enqueue path.
```

## Footer

Use footers for issue references and breaking changes.

- `Refs: #123`
- `Closes: #456`
- `BREAKING CHANGE: tokens issued before this change must be rotated`

Example:

```text
feat(api)!: remove legacy branch endpoint

BREAKING CHANGE: clients must use /api/branches/search instead of
/api/branch/list.
```

## Scope Guidance

Good scopes are stable technical areas. Prefer:

- app or package names like `backend`, `frontend`
- bounded subsystems like `auth`, `db`, `git`, `projects`, `branches`
- dependency scopes like `deps`

Avoid:

- ticket ids as scopes
- overly broad scopes like `stuff`
- changing style between singular and plural for the same subsystem

## Practical Defaults

- Default to `feat(...)` for user-visible capability additions.
- Default to `fix(...)` for bug fixes and regressions.
- Use `chore(deps)` for dependency bumps unless they are required for a feature or fix and you want that reflected in the main commit type.
- If a change spans multiple areas, choose the scope that best represents the primary impact, or omit the scope if none is dominant.

## Source

This local guide is based on the Conventional Commits specification and a commonly used community cheatsheet:

- [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0-beta/)
- [Zekfad conventional-commits.md gist](https://gist.github.com/Zekfad/f51cb06ac76e2457f11c80ed705c95a3)
