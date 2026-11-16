ALTER TABLE `sessions` ADD `parent_session_id` integer REFERENCES sessions(id) ON DELETE SET NULL;--> statement-breakpoint
CREATE INDEX `sessions_parent_idx` ON `sessions` (`parent_session_id`,`workspace_id`,`status`,`id`);--> statement-breakpoint
-- Preserve existing folder membership without inventing conversations or renaming transcripts.
-- Prefer an active member as the parent; archived groups stay in archive history.
WITH members AS MATERIALIZED (
  SELECT id, first_value(id) OVER (
    PARTITION BY folder_id, workspace_id ORDER BY (status = 'archived'), id
  ) AS parent_id
  FROM sessions WHERE folder_id IS NOT NULL AND surface = 'session' AND is_temporary = 0
)
UPDATE sessions SET parent_session_id = (SELECT parent_id FROM members WHERE members.id = sessions.id)
WHERE id IN (SELECT id FROM members);
--> statement-breakpoint
UPDATE sessions SET parent_session_id = NULL WHERE parent_session_id = id;
