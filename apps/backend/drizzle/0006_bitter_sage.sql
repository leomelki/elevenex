ALTER TABLE `sessions` ADD `has_unreviewed_completion` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `sessions` ADD `last_completion_at` text;--> statement-breakpoint
ALTER TABLE `sessions` ADD `last_completion_kind` text;