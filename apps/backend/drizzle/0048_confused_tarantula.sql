-- Navigation before this index could create several default rows. Keep the
-- oldest identity and move every conversation, folder, terminal and action
-- before deleting duplicates, so foreign keys never discard session history.
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
CREATE TEMP TABLE default_workspace_folders AS
SELECT folder.id, folder.workspace_id AS original_workspace_id,
       mapping.canonical_id AS workspace_id, folder.name
FROM session_folders folder
JOIN default_workspace_duplicates mapping ON mapping.id = folder.workspace_id;
--> statement-breakpoint
CREATE INDEX default_workspace_folders_name_idx ON default_workspace_folders(workspace_id, name);
--> statement-breakpoint
-- 0036 removed folder-name uniqueness. Some legacy databases can still have
-- that index: rename collisions before moving rows, preserving all folder IDs.
-- Every generated name ends in its unique folder ID. Repeating that suffix
-- until no original name matches also handles user-created suffix collisions.
CREATE TEMP TABLE default_workspace_folder_renames AS
WITH RECURSIVE candidates(id, workspace_id, name) AS (
  SELECT folder.id, folder.workspace_id, folder.name || ' (folder ' || folder.id || ')'
  FROM default_workspace_folders folder
  WHERE folder.original_workspace_id != folder.workspace_id
    AND EXISTS (
      SELECT 1 FROM default_workspace_folders other
      WHERE other.workspace_id = folder.workspace_id AND other.name = folder.name
        AND (other.original_workspace_id = other.workspace_id OR other.id < folder.id)
    )
  UNION ALL
  SELECT candidate.id, candidate.workspace_id,
         candidate.name || ' (folder ' || candidate.id || ')'
  FROM candidates candidate
  WHERE EXISTS (
    SELECT 1 FROM default_workspace_folders original
    WHERE original.workspace_id = candidate.workspace_id AND original.name = candidate.name
  )
)
SELECT candidate.* FROM candidates candidate
WHERE NOT EXISTS (
  SELECT 1 FROM default_workspace_folders original
  WHERE original.workspace_id = candidate.workspace_id AND original.name = candidate.name
);
--> statement-breakpoint
CREATE UNIQUE INDEX default_workspace_folder_renames_id_idx ON default_workspace_folder_renames(id);
--> statement-breakpoint
UPDATE session_folders SET name = (
  SELECT name FROM default_workspace_folder_renames WHERE id = session_folders.id
) WHERE id IN (SELECT id FROM default_workspace_folder_renames);
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
DROP TABLE default_workspace_folder_renames;
--> statement-breakpoint
DROP TABLE default_workspace_folders;
--> statement-breakpoint
DROP TABLE default_workspace_duplicates;
--> statement-breakpoint
-- Keep the final database consistent with 0036 and the generated schema.
DROP INDEX IF EXISTS session_folders_workspace_name_idx;
--> statement-breakpoint
CREATE UNIQUE INDEX `workspaces_repo_default_unique` ON `workspaces` (`repo_id`) WHERE "workspaces"."is_default" = 1;
