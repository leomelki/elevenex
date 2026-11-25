CREATE TABLE `session_launches` (
	`key` text PRIMARY KEY NOT NULL,
	`fingerprint` text NOT NULL,
	`session_id` integer NOT NULL,
	`delivery` text,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `session_launches_session_id_unique` ON `session_launches` (`session_id`);--> statement-breakpoint
ALTER TABLE `sessions` ADD `delegated_by_session_id` integer REFERENCES sessions(id) ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE `sessions` ADD `agent_selection` text;--> statement-breakpoint
CREATE INDEX `sessions_delegated_by_idx` ON `sessions` (`delegated_by_session_id`);
