CREATE TABLE `session_completion_notices` (
	`session_id` integer PRIMARY KEY NOT NULL,
	`recipient_id` integer NOT NULL,
	`state` text NOT NULL,
	`outcome` text,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`recipient_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `session_completion_notices_state_idx` ON `session_completion_notices` (`state`,`session_id`);--> statement-breakpoint
CREATE INDEX `session_completion_notices_recipient_idx` ON `session_completion_notices` (`recipient_id`,`state`,`session_id`);