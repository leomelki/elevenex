CREATE TABLE `antigravity_turns` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`session_id` integer NOT NULL,
	`items` text NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `antigravity_turns_session_idx` ON `antigravity_turns` (`session_id`,`id`);--> statement-breakpoint
ALTER TABLE `sessions` ADD `antigravity_session_id` text;--> statement-breakpoint
ALTER TABLE `sessions` ADD `antigravity_selection` text;