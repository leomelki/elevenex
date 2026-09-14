CREATE TABLE `session_folders` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`repo_id` integer NOT NULL,
	`workspace_id` integer NOT NULL,
	`name` text NOT NULL,
	`archived_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`repo_id`) REFERENCES `repos`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `session_folders_workspace_name_idx` ON `session_folders` (`workspace_id`,`name`);--> statement-breakpoint
ALTER TABLE `sessions` ADD `folder_id` integer REFERENCES session_folders(id) ON DELETE set null;--> statement-breakpoint
ALTER TABLE `sessions` ADD `archived_by_folder` integer DEFAULT false NOT NULL;
