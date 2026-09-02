CREATE TABLE `review_chats` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`parent_session_id` integer NOT NULL,
	`child_session_id` integer NOT NULL,
	`provider` text NOT NULL,
	`title` text NOT NULL,
	`mode` text DEFAULT 'readonly' NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`scope` text NOT NULL,
	`file_path` text,
	`anchors_json` text NOT NULL,
	`change_hash` text,
	`fingerprint` text,
	`anchor_message_id` text NOT NULL,
	`anchor_message_kind` text NOT NULL,
	`turn_key` text,
	`promoted_fork_id` integer,
	`last_read_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`parent_session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`child_session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `review_chats_child_session_id_unique` ON `review_chats` (`child_session_id`);--> statement-breakpoint
CREATE INDEX `review_chats_parent_idx` ON `review_chats` (`parent_session_id`);