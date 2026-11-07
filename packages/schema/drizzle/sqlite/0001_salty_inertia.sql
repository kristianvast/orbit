CREATE TABLE `camera_layouts` (
	`id` text PRIMARY KEY NOT NULL,
	`layout` text NOT NULL,
	`farm_id` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`deleted_at` text,
	`hlc` text NOT NULL,
	`origin_device` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `camera_layouts_one_live_per_farm` ON `camera_layouts` (`farm_id`) WHERE "camera_layouts"."deleted_at" is null;