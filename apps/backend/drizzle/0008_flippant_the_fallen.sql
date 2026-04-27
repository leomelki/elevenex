CREATE TABLE `claude_tool_interactions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`session_id` integer NOT NULL,
	`tool_use_id` text NOT NULL,
	`tool_name` text NOT NULL,
	`interaction_kind` text NOT NULL,
	`decision` text NOT NULL,
	`remember` integer DEFAULT false NOT NULL,
	`response_content` text,
	`request_snapshot` text NOT NULL,
	`created_at` text NOT NULL,
	`resolved_at` text NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `claude_tool_interactions_session_tool_use_idx` ON `claude_tool_interactions` (`session_id`,`tool_use_id`);