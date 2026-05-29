CREATE TABLE `plan_chat_forks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`parent_session_id` integer NOT NULL,
	`child_session_id` integer NOT NULL,
	`provider` text NOT NULL,
	`review_id` text NOT NULL,
	`anchor_message_id` text NOT NULL,
	`anchor_message_kind` text NOT NULL,
	`anchor_excerpt` text,
	`plan_excerpt` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`parent_session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`child_session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `plan_chat_forks_child_session_id_unique` ON `plan_chat_forks` (`child_session_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `plan_chat_forks_parent_review_idx` ON `plan_chat_forks` (`parent_session_id`,`review_id`);--> statement-breakpoint
ALTER TABLE `sessions` ADD `surface` text DEFAULT 'session' NOT NULL;