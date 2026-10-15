CREATE TABLE `turn_changes` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` integer NOT NULL,
	`provider` text NOT NULL,
	`conversation_id` text NOT NULL,
	`started_at` text NOT NULL,
	`finished_at` text NOT NULL,
	`details` text NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `turn_changes_conversation_idx` ON `turn_changes` (`session_id`,`provider`,`conversation_id`);