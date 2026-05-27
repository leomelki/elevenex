CREATE TABLE `session_forks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`parent_session_id` integer NOT NULL,
	`child_session_id` integer NOT NULL,
	`provider` text NOT NULL,
	`anchor_message_id` text NOT NULL,
	`anchor_message_kind` text NOT NULL,
	`anchor_excerpt` text,
	`draft` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`parent_session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`child_session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `session_forks_child_session_id_unique` ON `session_forks` (`child_session_id`);