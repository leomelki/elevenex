ALTER TABLE `workspaces` ADD `task_created_by_session_id` integer;--> statement-breakpoint
ALTER TABLE `workspaces` ADD `task_temporary` integer DEFAULT false NOT NULL;