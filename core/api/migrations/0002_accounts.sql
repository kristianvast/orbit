CREATE TABLE IF NOT EXISTS "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"name" text,
	"password_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "users_email_unique" ON "users" USING btree ("email");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "user_sessions" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
	"device_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_sessions_user_idx" ON "user_sessions" USING btree ("user_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "farm_members" (
	"farm_id" uuid NOT NULL,
	"user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
	"role" text NOT NULL CHECK ("role" IN ('owner', 'manager', 'worker', 'viewer')),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	PRIMARY KEY ("farm_id", "user_id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "farm_members_user_idx" ON "farm_members" USING btree ("user_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "farm_invites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"farm_id" uuid NOT NULL,
	"email" text NOT NULL,
	"role" text NOT NULL CHECK ("role" IN ('owner', 'manager', 'worker', 'viewer')),
	"token_hash" text NOT NULL,
	"invited_by" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"accepted_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "farm_invites_token_unique" ON "farm_invites" USING btree ("token_hash");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "farm_invites_farm_idx" ON "farm_invites" USING btree ("farm_id");
