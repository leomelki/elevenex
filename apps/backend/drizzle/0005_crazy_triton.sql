ALTER TABLE `project_browser_state` RENAME TO `project_browser_state__old`;--> statement-breakpoint
CREATE TABLE `project_browser_state` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` integer NOT NULL,
	`tab_id` text NOT NULL,
	`url` text NOT NULL,
	`position` integer NOT NULL,
	`is_active` integer DEFAULT false NOT NULL,
	`custom_title` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint
INSERT INTO `project_browser_state` (`project_id`, `tab_id`, `url`, `position`, `is_active`, `custom_title`, `created_at`, `updated_at`)
SELECT
	`project_id`,
	'legacy-' || `project_id`,
	`url`,
	0,
	1,
	NULL,
	`created_at`,
	`updated_at`
FROM `project_browser_state__old`;--> statement-breakpoint
DROP TABLE `project_browser_state__old`;--> statement-breakpoint
CREATE UNIQUE INDEX `project_browser_state_project_tab_idx` ON `project_browser_state` (`project_id`,`tab_id`);
