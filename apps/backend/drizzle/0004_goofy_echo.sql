CREATE TABLE `actions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`worktree_path` text NOT NULL,
	`name` text NOT NULL,
	`command` text NOT NULL,
	`status` text DEFAULT 'idle' NOT NULL,
	`last_run_at` text,
	`last_finished_at` text,
	`last_exit_code` integer,
	`current_output` text DEFAULT '' NOT NULL,
	`last_output` text DEFAULT '' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
