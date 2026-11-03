CREATE TABLE "animals" (
	"id" uuid PRIMARY KEY NOT NULL,
	"species" text NOT NULL,
	"name" text,
	"ear_tag_number" text,
	"national_id" text,
	"breed" text,
	"sex" text DEFAULT 'unknown' NOT NULL,
	"birth_date" date,
	"group_name" text,
	"status" text DEFAULT 'active' NOT NULL,
	"notes" text,
	"farm_id" uuid NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"deleted_at" timestamp with time zone,
	"hlc" text NOT NULL,
	"origin_device" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cameras" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"location" text,
	"onvif_xaddr" text,
	"rtsp_url" text,
	"credential_ref" text,
	"status" text DEFAULT 'unknown' NOT NULL,
	"farm_id" uuid NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"deleted_at" timestamp with time zone,
	"hlc" text NOT NULL,
	"origin_device" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "connectors" (
	"id" uuid PRIMARY KEY NOT NULL,
	"vendor" text NOT NULL,
	"kind" text NOT NULL,
	"name" text,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"last_sync_at" timestamp with time zone,
	"last_error" text,
	"farm_id" uuid NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"deleted_at" timestamp with time zone,
	"hlc" text NOT NULL,
	"origin_device" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "device_bindings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"device_id" uuid NOT NULL,
	"animal_id" uuid NOT NULL,
	"wearable" boolean NOT NULL,
	"bound_at" timestamp with time zone NOT NULL,
	"unbound_at" timestamp with time zone,
	"farm_id" uuid NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"deleted_at" timestamp with time zone,
	"hlc" text NOT NULL,
	"origin_device" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "devices" (
	"id" uuid PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"vendor" text,
	"model" text,
	"serial" text,
	"connection" jsonb,
	"status" text DEFAULT 'offline' NOT NULL,
	"battery_pct" double precision,
	"last_seen_at" timestamp with time zone,
	"farm_id" uuid NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"deleted_at" timestamp with time zone,
	"hlc" text NOT NULL,
	"origin_device" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "farms" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"timezone" text DEFAULT 'UTC' NOT NULL,
	"farm_id" uuid NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"deleted_at" timestamp with time zone,
	"hlc" text NOT NULL,
	"origin_device" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "observations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"animal_id" uuid,
	"device_id" uuid,
	"kind" text NOT NULL,
	"ts" timestamp with time zone NOT NULL,
	"value_num" double precision,
	"value_json" jsonb,
	"source" text NOT NULL,
	"farm_id" uuid NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"deleted_at" timestamp with time zone,
	"hlc" text NOT NULL,
	"origin_device" text NOT NULL
);
--> statement-breakpoint
CREATE INDEX "animals_farm_idx" ON "animals" USING btree ("farm_id");--> statement-breakpoint
CREATE INDEX "animals_ear_tag_idx" ON "animals" USING btree ("farm_id","ear_tag_number");--> statement-breakpoint
CREATE INDEX "cameras_farm_idx" ON "cameras" USING btree ("farm_id");--> statement-breakpoint
CREATE INDEX "connectors_farm_idx" ON "connectors" USING btree ("farm_id");--> statement-breakpoint
CREATE INDEX "device_bindings_animal_idx" ON "device_bindings" USING btree ("animal_id");--> statement-breakpoint
CREATE UNIQUE INDEX "device_bindings_one_active_wearable_per_animal" ON "device_bindings" USING btree ("animal_id") WHERE "device_bindings"."wearable" = true and "device_bindings"."unbound_at" is null and "device_bindings"."deleted_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "device_bindings_one_active_binding_per_device" ON "device_bindings" USING btree ("device_id") WHERE "device_bindings"."unbound_at" is null and "device_bindings"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "devices_farm_idx" ON "devices" USING btree ("farm_id");--> statement-breakpoint
CREATE INDEX "devices_kind_idx" ON "devices" USING btree ("farm_id","kind");--> statement-breakpoint
CREATE INDEX "observations_animal_ts_idx" ON "observations" USING btree ("animal_id","ts");--> statement-breakpoint
CREATE INDEX "observations_farm_kind_ts_idx" ON "observations" USING btree ("farm_id","kind","ts");