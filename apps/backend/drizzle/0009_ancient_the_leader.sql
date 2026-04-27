CREATE TABLE `worktree_contexts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`repo_id` integer NOT NULL,
	`worktree_path` text NOT NULL,
	`root_ref` text,
	`context_sentence` text,
	`generation_status` text DEFAULT 'idle' NOT NULL,
	`generated_at` text,
	`last_used_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`repo_id`) REFERENCES `repos`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `worktree_contexts_repo_worktree_idx` ON `worktree_contexts` (`repo_id`,`worktree_path`);--> statement-breakpoint
ALTER TABLE `repos` ADD `preferred_context_root_ref` text;--> statement-breakpoint
ALTER TABLE `sessions` ADD `has_injected_worktree_context` integer DEFAULT false NOT NULL;