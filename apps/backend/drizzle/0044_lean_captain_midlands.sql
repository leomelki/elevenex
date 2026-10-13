CREATE INDEX `sessions_repo_activity_idx` ON `sessions` (`repo_id`,`surface`,`last_state_change_at`,`id`);--> statement-breakpoint
CREATE INDEX `sessions_workspace_activity_idx` ON `sessions` (`workspace_id`,`surface`,`last_state_change_at`,`id`);--> statement-breakpoint
CREATE INDEX `sessions_folder_status_idx` ON `sessions` (`folder_id`,`surface`,`status`,`id`);--> statement-breakpoint
CREATE INDEX `sessions_mcp_token_idx` ON `sessions` (`mcp_agent_token`);