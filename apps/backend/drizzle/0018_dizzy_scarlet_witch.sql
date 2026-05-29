ALTER TABLE `app_settings` ADD `default_agent_provider` text DEFAULT 'claude' NOT NULL;--> statement-breakpoint
ALTER TABLE `app_settings` ADD `onboarding_completed_at` text;