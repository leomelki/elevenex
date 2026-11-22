ALTER TABLE `sessions` ADD `nesting_order` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
CREATE INDEX `sessions_nesting_order_idx` ON `sessions` (`parent_session_id`,`workspace_id`,`nesting_order`,`id`);
