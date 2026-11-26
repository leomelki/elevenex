CREATE TABLE `task_app_journal` (
	`run_id` text PRIMARY KEY NOT NULL,
	`task_id` integer NOT NULL,
	`request_hash` text NOT NULL,
	`launch_hash` text NOT NULL,
	`mode` text NOT NULL,
	`phase` text NOT NULL,
	`started_at` integer NOT NULL,
	`expires_at` integer,
	`supervisor_pid` integer,
	`supervisor_birth` text,
	FOREIGN KEY (`task_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `task_app_journal_request_idx` ON `task_app_journal` (`task_id`,`request_hash`);--> statement-breakpoint
CREATE INDEX `task_app_journal_recent_idx` ON `task_app_journal` (`task_id`,`started_at`);--> statement-breakpoint
CREATE INDEX `task_app_journal_expiry_idx` ON `task_app_journal` (`expires_at`);--> statement-breakpoint
CREATE INDEX `task_app_journal_phase_idx` ON `task_app_journal` (`phase`,`task_id`);