CREATE TABLE `session_reply_returns` (
	`session_id` integer NOT NULL,
	`item_id` text NOT NULL,
	`recipient_id` integer NOT NULL,
	`at` text NOT NULL,
	PRIMARY KEY(`session_id`, `item_id`, `recipient_id`),
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`recipient_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `session_reply_returns_recent_idx` ON `session_reply_returns` (`session_id`,`at`);--> statement-breakpoint
CREATE INDEX `session_reply_returns_recipient_idx` ON `session_reply_returns` (`recipient_id`);