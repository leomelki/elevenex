-- Navigation before this index could create several default rows. Keep the
-- oldest identity and move every conversation, folder, terminal and action
-- before deleting duplicates, so foreign keys never discard session history.
-- 0036 permits repeated folder names. Remove any retained legacy index before
-- reassigning folders so their names, IDs and session links stay unchanged.
DROP INDEX IF EXISTS session_folders_workspace_name_idx;
--> statement-breakpoint
CREATE TEMP TABLE `default_workspace_duplicates` AS
SELECT id, (SELECT min(canonical.id) FROM workspaces canonical
            WHERE canonical.repo_id = duplicate.repo_id AND canonical.is_default = 1) AS canonical_id
FROM workspaces duplicate
WHERE is_default = 1;
--> statement-breakpoint
CREATE UNIQUE INDEX default_workspace_duplicates_id_idx ON default_workspace_duplicates(id);
--> statement-breakpoint
-- A lease cannot be merged into another task_id: it has its own primary key
-- and unique path/branch constraints. Preserve any leased duplicate as a task.
UPDATE workspaces SET is_default = 0
WHERE id IN (SELECT id FROM default_workspace_duplicates WHERE id != canonical_id)
  AND id IN (SELECT task_id FROM task_reservations);
--> statement-breakpoint
DELETE FROM default_workspace_duplicates
WHERE id IN (SELECT id FROM workspaces WHERE is_default = 0);
--> statement-breakpoint
UPDATE sessions SET workspace_id = (
  SELECT canonical_id FROM default_workspace_duplicates WHERE id = sessions.workspace_id
) WHERE workspace_id IN (SELECT id FROM default_workspace_duplicates WHERE id != canonical_id);
--> statement-breakpoint
UPDATE session_folders SET workspace_id = (
  SELECT canonical_id FROM default_workspace_duplicates WHERE id = session_folders.workspace_id
) WHERE workspace_id IN (SELECT id FROM default_workspace_duplicates WHERE id != canonical_id);
--> statement-breakpoint
UPDATE user_terminals SET workspace_id = (
  SELECT canonical_id FROM default_workspace_duplicates WHERE id = user_terminals.workspace_id
) WHERE workspace_id IN (SELECT id FROM default_workspace_duplicates WHERE id != canonical_id);
--> statement-breakpoint
UPDATE actions SET workspace_id = (
  SELECT canonical_id FROM default_workspace_duplicates WHERE id = actions.workspace_id
) WHERE workspace_id IN (SELECT id FROM default_workspace_duplicates WHERE id != canonical_id);
--> statement-breakpoint
DELETE FROM workspaces WHERE id IN (SELECT id FROM default_workspace_duplicates WHERE id != canonical_id);
--> statement-breakpoint
DROP TABLE default_workspace_duplicates;
--> statement-breakpoint
CREATE UNIQUE INDEX `workspaces_repo_default_unique` ON `workspaces` (`repo_id`) WHERE "workspaces"."is_default" = 1;
