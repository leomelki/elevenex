The project is meant to be used in repositories with multiple thousands of files and folders, and hundreds of commits per hour (with newones coming everytime on main origin), and hundreds of branches.

## Commits

- Follow the commit convention in `COMMIT_CONVENTION.md`.
- Use Conventional Commits in the form `feat(scope): description` whenever a scope is applicable.

## Frontend UI

- Use Zard UI components and Tailwind CSS utilities as much as possible when building or modifying frontend UI.
- When a needed Zard UI component is not already installed, do not hesitate to install the relevant component instead of hand-rolling a replacement.

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
