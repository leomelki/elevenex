CREATE TABLE `desktop_workspace_metadata` (
	`kind` text NOT NULL,
	`resource_id` integer NOT NULL,
	`value` text NOT NULL,
	PRIMARY KEY(`kind`, `resource_id`)
);
