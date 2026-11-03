CREATE TABLE `animals` (
	`id` text PRIMARY KEY NOT NULL,
	`species` text NOT NULL,
	`name` text,
	`ear_tag_number` text,
	`national_id` text,
	`breed` text,
	`sex` text DEFAULT 'unknown' NOT NULL,
	`birth_date` text,
	`group_name` text,
	`status` text DEFAULT 'active' NOT NULL,
	`notes` text,
	`farm_id` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`deleted_at` text,
	`hlc` text NOT NULL,
	`origin_device` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `animals_farm_idx` ON `animals` (`farm_id`);--> statement-breakpoint
CREATE INDEX `animals_ear_tag_idx` ON `animals` (`farm_id`,`ear_tag_number`);--> statement-breakpoint
CREATE TABLE `cameras` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`location` text,
	`onvif_xaddr` text,
	`rtsp_url` text,
	`credential_ref` text,
	`status` text DEFAULT 'unknown' NOT NULL,
	`farm_id` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`deleted_at` text,
	`hlc` text NOT NULL,
	`origin_device` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `cameras_farm_idx` ON `cameras` (`farm_id`);--> statement-breakpoint
CREATE TABLE `connectors` (
	`id` text PRIMARY KEY NOT NULL,
	`vendor` text NOT NULL,
	`kind` text NOT NULL,
	`name` text,
	`config` text DEFAULT '{}' NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`last_sync_at` text,
	`last_error` text,
	`farm_id` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`deleted_at` text,
	`hlc` text NOT NULL,
	`origin_device` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `connectors_farm_idx` ON `connectors` (`farm_id`);--> statement-breakpoint
CREATE TABLE `device_bindings` (
	`id` text PRIMARY KEY NOT NULL,
	`device_id` text NOT NULL,
	`animal_id` text NOT NULL,
	`wearable` integer NOT NULL,
	`bound_at` text NOT NULL,
	`unbound_at` text,
	`farm_id` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`deleted_at` text,
	`hlc` text NOT NULL,
	`origin_device` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `device_bindings_animal_idx` ON `device_bindings` (`animal_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `device_bindings_one_active_wearable_per_animal` ON `device_bindings` (`animal_id`) WHERE "device_bindings"."wearable" = 1 and "device_bindings"."unbound_at" is null and "device_bindings"."deleted_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX `device_bindings_one_active_binding_per_device` ON `device_bindings` (`device_id`) WHERE "device_bindings"."unbound_at" is null and "device_bindings"."deleted_at" is null;--> statement-breakpoint
CREATE TABLE `devices` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`vendor` text,
	`model` text,
	`serial` text,
	`connection` text,
	`status` text DEFAULT 'offline' NOT NULL,
	`battery_pct` real,
	`last_seen_at` text,
	`farm_id` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`deleted_at` text,
	`hlc` text NOT NULL,
	`origin_device` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `devices_farm_idx` ON `devices` (`farm_id`);--> statement-breakpoint
CREATE INDEX `devices_kind_idx` ON `devices` (`farm_id`,`kind`);--> statement-breakpoint
CREATE TABLE `farms` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`timezone` text DEFAULT 'UTC' NOT NULL,
	`farm_id` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`deleted_at` text,
	`hlc` text NOT NULL,
	`origin_device` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `observations` (
	`id` text PRIMARY KEY NOT NULL,
	`animal_id` text,
	`device_id` text,
	`kind` text NOT NULL,
	`ts` text NOT NULL,
	`value_num` real,
	`value_json` text,
	`source` text NOT NULL,
	`farm_id` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`deleted_at` text,
	`hlc` text NOT NULL,
	`origin_device` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `observations_animal_ts_idx` ON `observations` (`animal_id`,`ts`);--> statement-breakpoint
CREATE INDEX `observations_farm_kind_ts_idx` ON `observations` (`farm_id`,`kind`,`ts`);--> statement-breakpoint
CREATE TABLE `outbox` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`op` text NOT NULL,
	`table_name` text NOT NULL,
	`row_id` text NOT NULL,
	`payload` text NOT NULL,
	`hlc` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	`created_at` text NOT NULL,
	`acked_at` text
);
--> statement-breakpoint
CREATE INDEX `outbox_pending_idx` ON `outbox` (`acked_at`,`seq`);--> statement-breakpoint
CREATE TABLE `snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text,
	`tool_call_id` text,
	`description` text NOT NULL,
	`changes` text NOT NULL,
	`created_at` text NOT NULL,
	`undone_at` text
);
--> statement-breakpoint
CREATE INDEX `snapshots_created_idx` ON `snapshots` (`created_at`);--> statement-breakpoint
CREATE TABLE `sync_state` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` text NOT NULL
);
