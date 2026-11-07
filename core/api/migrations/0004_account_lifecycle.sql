ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "email_verified_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "terms_version" text;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "terms_accepted_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "data_consent_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "user_sessions" ADD COLUMN IF NOT EXISTS "id" uuid DEFAULT gen_random_uuid() NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "user_sessions_id_unique" ON "user_sessions" USING btree ("id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "email_tokens" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
	"purpose" text NOT NULL CHECK ("purpose" IN ('verify', 'reset')),
	"email" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "email_tokens_user_idx" ON "email_tokens" USING btree ("user_id", "purpose", "created_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "login_failures" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "login_failures_email_at_idx" ON "login_failures" USING btree ("email", "at");
--> statement-breakpoint
ALTER TABLE "farm_subscriptions" ADD COLUMN IF NOT EXISTS "stripe_event_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "hardware_orders" ADD COLUMN IF NOT EXISTS "user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE "hardware_orders" ADD COLUMN IF NOT EXISTS "shipping" jsonb;
--> statement-breakpoint
ALTER TABLE "hardware_orders" ADD COLUMN IF NOT EXISTS "amount_total" integer;
--> statement-breakpoint
ALTER TABLE "hardware_orders" ADD COLUMN IF NOT EXISTS "currency" text;
--> statement-breakpoint
ALTER TABLE "hardware_orders" ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone DEFAULT now() NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "hardware_orders_user_idx" ON "hardware_orders" USING btree ("user_id");
