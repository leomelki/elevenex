CREATE TABLE `workspaces` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`repo_id` integer NOT NULL,
	`name` text NOT NULL,
	`path` text NOT NULL,
	`is_default` integer DEFAULT false NOT NULL,
	`created_from_ref` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`repo_id`) REFERENCES `repos`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workspaces_repo_id_name_unique` ON `workspaces` (`repo_id`,`name`);--> statement-breakpoint
CREATE UNIQUE INDEX `workspaces_repo_id_path_unique` ON `workspaces` (`repo_id`,`path`);--> statement-breakpoint
ALTER TABLE `sessions` ADD `workspace_id` integer REFERENCES workspaces(id);--> statement-breakpoint
INSERT INTO `workspaces` (`repo_id`, `name`, `path`, `is_default`, `created_from_ref`, `created_at`, `updated_at`)
SELECT `id`, 'Default', `path`, 1, 'HEAD', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM `repos`;--> statement-breakpoint
UPDATE `sessions`
SET `workspace_id` = (
  SELECT `workspaces`.`id`
  FROM `workspaces`
  WHERE `workspaces`.`repo_id` = `sessions`.`repo_id`
    AND `workspaces`.`path` = `sessions`.`worktree_path`
  LIMIT 1
);
