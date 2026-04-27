CREATE TABLE `user_terminals` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`worktree_path` text NOT NULL,
	`name` text NOT NULL,
	`shell` text NOT NULL,
	`created_at` text NOT NULL
);
