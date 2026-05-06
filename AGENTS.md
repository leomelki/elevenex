The project is meant to be used in repositories with multiple thousands of files and folders, and hundreds of commits per hour (with newones coming everytime on main origin), and hundreds of branches.

## Commits

- Follow the commit convention in `COMMIT_CONVENTION.md`.
- Use Conventional Commits in the form `feat(scope): description` whenever a scope is applicable.

## Frontend UI

- Use Zard UI components and Tailwind CSS utilities as much as possible when building or modifying frontend UI.
- When a needed Zard UI component is not already installed, do not hesitate to install the relevant component instead of hand-rolling a replacement.

### Dark mode and color best practices

- Dark mode is class-based. The app toggles the `dark` class on the root `html` element, and Tailwind dark variants should be written for that model.
- Prefer semantic design tokens from `apps/frontend/src/styles.css` over hard-coded colors. Use tokens such as `background`, `foreground`, `card`, `popover`, `primary`, `muted`, `accent`, `border`, `input`, `destructive`, `success`, and `warning`.
- When a color needs to be shared between light and dark mode, add or reuse a CSS variable in `styles.css` and map it through `@theme inline` when Tailwind utilities need it.
- Avoid mixing component colors with literal `white`, `black`, `slate-*`, or fixed hex values for normal app surfaces. Use `var(--surface-tint)` and `var(--surface-shade)` in `color-mix()` when a lightening or darkening endpoint is needed.
- Status UI should use semantic tokens: success for active/complete states, warning for pending/attention states, destructive for errors or dangerous actions, and muted for inactive states.
- Keep terminals and embedded code/editor surfaces intentionally dark only when that is a product decision. Otherwise, derive wrappers, labels, borders, and loading states from the theme tokens.
- Every new or modified UI surface should be checked in both light and dark mode. Verify readable contrast, visible focus rings, borders that do not disappear, hover/active states, disabled states, empty states, dialogs, and loading skeletons.
- Do not solve dark mode with one-off `dark:` patches if a semantic token would make the component consistent everywhere.

## Database (apps/backend)

- **ORM**: Drizzle ORM with better-sqlite3
- **Schema files**: `apps/backend/src/database/schema/*.schema.ts`, re-exported from `index.ts`
- **Migrations**: SQL files in `apps/backend/drizzle/`, auto-applied on app startup via `drizzle-orm/better-sqlite3/migrator`
- **No manual setup required**: The database and all tables are created automatically when the backend starts for the first time

### When modifying the database schema

1. Edit or create schema files in `apps/backend/src/database/schema/`
2. Run `pnpm drizzle-kit generate` from `apps/backend/` to generate a new migration file
3. Commit the generated migration file in `apps/backend/drizzle/` alongside the schema change
4. The migration will be applied automatically on next app startup

**Do not** use `drizzle-kit push` in this project — always generate migration files so they are tracked in git and applied consistently across environments.
