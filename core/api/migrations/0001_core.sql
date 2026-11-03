CREATE TABLE IF NOT EXISTS "api_tokens" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"farm_id" uuid NOT NULL,
	"name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "api_tokens_farm_idx" ON "api_tokens" USING btree ("farm_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "farm_budgets" (
	"farm_id" uuid PRIMARY KEY NOT NULL,
	"monthly_token_budget" bigint NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "llm_usage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"farm_id" uuid NOT NULL,
	"model" text,
	"path" text NOT NULL,
	"status" integer NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"total_tokens" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "llm_usage_farm_created_idx" ON "llm_usage" USING btree ("farm_id","created_at");
