ALTER TABLE `session_completion_notices` ADD `action_key` text;--> statement-breakpoint
ALTER TABLE `session_completion_notices` ADD `action_delivered` integer DEFAULT false NOT NULL;