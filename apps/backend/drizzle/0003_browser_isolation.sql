CREATE TABLE `project_browser_state` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` integer NOT NULL,
	`url` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `project_browser_state_project_idx` ON `project_browser_state` (`project_id`);
--> statement-breakpoint
INSERT INTO `project_browser_state` (`project_id`, `url`, `created_at`, `updated_at`)
SELECT `project_id`, `url`, `created_at`, `updated_at`
FROM `worktree_browser_state`
WHERE `id` IN (
	SELECT MAX(`id`) FROM `worktree_browser_state` GROUP BY `project_id`
);
--> statement-breakpoint
DROP TABLE `worktree_browser_state`;
--> statement-breakpoint
CREATE TABLE `browser_isolation_settings` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` integer NOT NULL,
	`mode` text DEFAULT 'shared' NOT NULL,
	`shared_globs` text DEFAULT '[]' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `browser_isolation_settings_project_idx` ON `browser_isolation_settings` (`project_id`);
