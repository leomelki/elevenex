CREATE TABLE `app_settings` (
	`id` integer PRIMARY KEY NOT NULL,
	`default_claude_session_surface` text DEFAULT 'claude-ui' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
