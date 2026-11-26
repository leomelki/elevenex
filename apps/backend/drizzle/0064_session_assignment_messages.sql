CREATE TABLE `session_prompt_receipts` (
	`id` text PRIMARY KEY NOT NULL,
	`key` text NOT NULL,
	`fingerprint` text NOT NULL,
	`session_id` integer NOT NULL,
	`sender_id` integer,
	`delivery` text NOT NULL,
	`disposition` text,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`sender_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `session_prompt_receipts_key_unique` ON `session_prompt_receipts` (`key`);--> statement-breakpoint
CREATE INDEX `session_prompt_receipts_session_idx` ON `session_prompt_receipts` (`session_id`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_session_completion_notices` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`session_id` integer NOT NULL,
	`message_id` text,
	`prompt_id` text,
	`completion_after` text,
	`reply_id` text,
	`reply_text` text,
	`recipient_id` integer NOT NULL,
	`state` text NOT NULL,
	`action_key` text,
	`action_delivered` integer DEFAULT false NOT NULL,
	`outcome` text,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`prompt_id`) REFERENCES `session_prompt_receipts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`recipient_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
-- Preserve existing completion ownership; the additional fields apply to later assignments.
INSERT INTO `__new_session_completion_notices`("id", "session_id", "recipient_id", "state", "action_key", "action_delivered", "outcome") SELECT "session_id", "session_id", "recipient_id", "state", "action_key", "action_delivered", "outcome" FROM `session_completion_notices`;--> statement-breakpoint
DROP TABLE `session_completion_notices`;--> statement-breakpoint
ALTER TABLE `__new_session_completion_notices` RENAME TO `session_completion_notices`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `session_completion_notices_state_idx` ON `session_completion_notices` (`state`,`id`);--> statement-breakpoint
CREATE INDEX `session_completion_notices_recipient_idx` ON `session_completion_notices` (`recipient_id`,`state`,`id`);--> statement-breakpoint
CREATE INDEX `session_completion_notices_session_idx` ON `session_completion_notices` (`session_id`,`state`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `session_completion_notices_prompt_idx` ON `session_completion_notices` (`prompt_id`);