CREATE TABLE `repo_worktrees` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`repo_root_path` text NOT NULL,
	`path` text NOT NULL,
	`name` text NOT NULL,
	`created_from_ref` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `repo_worktrees_repo_root_path_path_unique` ON `repo_worktrees` (`repo_root_path`,`path`);--> statement-breakpoint
ALTER TABLE `workspaces` ADD `pool_worktree_id` integer REFERENCES repo_worktrees(id);--> statement-breakpoint
ALTER TABLE `workspaces` ADD `link_status` text DEFAULT 'linked' NOT NULL;--> statement-breakpoint
ALTER TABLE `workspaces` ADD `desired_branch` text;--> statement-breakpoint
ALTER TABLE `workspaces` ADD `unlinked_at` text;--> statement-breakpoint
ALTER TABLE `workspaces` ADD `unlinked_by_project_id` integer;--> statement-breakpoint
ALTER TABLE `workspaces` ADD `pending_stash_commit` text;--> statement-breakpoint
ALTER TABLE `workspaces` ADD `pending_stash_message` text;--> statement-breakpoint
ALTER TABLE `workspaces` ADD `pending_stash_created_at` text;--> statement-breakpoint
ALTER TABLE `workspaces` ADD `pending_stash_status` text;