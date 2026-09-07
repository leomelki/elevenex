CREATE TABLE `composer_drafts` (
	`session_id` integer PRIMARY KEY NOT NULL,
	`text` text DEFAULT '' NOT NULL,
	`diff_mentions_json` text DEFAULT '[]' NOT NULL,
	`session_mentions_json` text DEFAULT '[]' NOT NULL,
	`images_json` text DEFAULT '[]' NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
