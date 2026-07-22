CREATE TABLE `demand_events` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`origin_area` text NOT NULL,
	`destination_name` text NOT NULL,
	`category` text NOT NULL,
	`requested_date` text NOT NULL,
	`hour_bucket` integer NOT NULL,
	`outcome` text NOT NULL,
	`reason` text NOT NULL,
	`journey_type` text DEFAULT 'unknown' NOT NULL
);
--> statement-breakpoint
CREATE INDEX `demand_created_at_idx` ON `demand_events` (`created_at`);--> statement-breakpoint
CREATE INDEX `demand_area_time_idx` ON `demand_events` (`origin_area`,`hour_bucket`);--> statement-breakpoint
CREATE INDEX `demand_category_outcome_idx` ON `demand_events` (`category`,`outcome`);