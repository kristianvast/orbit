CREATE TABLE "camera_layouts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"layout" jsonb NOT NULL,
	"farm_id" uuid NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"deleted_at" timestamp with time zone,
	"hlc" text NOT NULL,
	"origin_device" text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "camera_layouts_one_live_per_farm" ON "camera_layouts" USING btree ("farm_id") WHERE "camera_layouts"."deleted_at" is null;