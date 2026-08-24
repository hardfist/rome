CREATE TABLE `linkedin_participants` (
	`participant_id` text PRIMARY KEY NOT NULL,
	`name` text,
	`headline` text,
	`type` text,
	`is_self` integer DEFAULT false NOT NULL,
	`first_synced_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `linkedin_thread_participants` (
	`thread_id` text NOT NULL,
	`participant_id` text NOT NULL,
	`first_synced_at` integer NOT NULL,
	PRIMARY KEY(`thread_id`, `participant_id`)
);
--> statement-breakpoint
CREATE INDEX `idx_linkedin_thread_participants_participant` ON `linkedin_thread_participants` (`participant_id`);