CREATE TABLE `task_reservations` (
	`task_id` integer PRIMARY KEY NOT NULL,
	`repository_key` text NOT NULL,
	`branch_name` text,
	`path` text NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `task_reservations_path_unique` ON `task_reservations` (`path`);--> statement-breakpoint
CREATE UNIQUE INDEX `task_reservations_repository_key_branch_name_unique` ON `task_reservations` (`repository_key`,`branch_name`);--> statement-breakpoint
DROP INDEX `workspaces_repo_id_name_unique`;--> statement-breakpoint
DROP INDEX `workspaces_repo_id_path_unique`;--> statement-breakpoint
ALTER TABLE `workspaces` ADD `archived_at` text;--> statement-breakpoint
ALTER TABLE `workspaces` ADD `task_state` text DEFAULT 'ready' NOT NULL;--> statement-breakpoint
ALTER TABLE `workspaces` ADD `task_branch` text;--> statement-breakpoint
ALTER TABLE `workspaces` ADD `source_ref` text;--> statement-breakpoint
ALTER TABLE `workspaces` ADD `checkout_mode` text DEFAULT 'branch' NOT NULL;--> statement-breakpoint
ALTER TABLE `workspaces` ADD `starting_commit` text;--> statement-breakpoint
ALTER TABLE `workspaces` ADD `final_commit` text;--> statement-breakpoint
ALTER TABLE `workspaces` ADD `task_config` text;--> statement-breakpoint
ALTER TABLE `workspaces` ADD `task_error` text;--> statement-breakpoint
ALTER TABLE `workspaces` ADD `task_request_id` text;--> statement-breakpoint
CREATE UNIQUE INDEX `workspaces_task_request_id_unique` ON `workspaces` (`task_request_id`);--> statement-breakpoint
CREATE INDEX `workspaces_repo_lifecycle_idx` ON `workspaces` (`repo_id`,`archived_at`);--> statement-breakpoint
CREATE INDEX `workspaces_assignment_idx` ON `workspaces` (`pool_worktree_id`,`link_status`);--> statement-breakpoint
ALTER TABLE `repos` ADD `task_base_ref` text;--> statement-breakpoint
ALTER TABLE `repo_worktrees` ADD `managed` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `sessions` ADD `transcript_worktree_path` text;--> statement-breakpoint
ALTER TABLE `sessions` ADD `archived_by_task` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `user_terminals` ADD `workspace_id` integer REFERENCES workspaces(id) ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE `actions` ADD `workspace_id` integer REFERENCES workspaces(id) ON DELETE SET NULL;
--> statement-breakpoint
UPDATE sessions SET transcript_worktree_path = worktree_path;
--> statement-breakpoint
UPDATE repo_worktrees SET managed = 1 WHERE path LIKE '%/.worktrees/%';
--> statement-breakpoint
UPDATE user_terminals SET workspace_id = (SELECT id FROM workspaces WHERE workspaces.path = user_terminals.worktree_path AND link_status = 'linked' AND is_default = 0 ORDER BY updated_at DESC LIMIT 1);
--> statement-breakpoint
UPDATE actions SET workspace_id = (SELECT id FROM workspaces WHERE workspaces.path = actions.worktree_path AND link_status = 'linked' AND is_default = 0 ORDER BY updated_at DESC LIMIT 1);
--> statement-breakpoint
UPDATE workspaces SET task_request_id = 'legacy-workspace-' || id WHERE is_default = 0 AND task_request_id IS NULL;
--> statement-breakpoint
UPDATE workspaces SET task_state = 'failed', task_branch = desired_branch, source_ref = desired_branch,
  task_error = '{"code":"environment_missing","message":"This task needs an environment. Choose a branch and retry setup."}'
  WHERE is_default = 0 AND link_status = 'unlinked' AND archived_at IS NULL;
