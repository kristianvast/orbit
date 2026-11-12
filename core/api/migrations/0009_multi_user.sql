ALTER TABLE "farm_members"
  ADD COLUMN "use_farm_plan" boolean NOT NULL DEFAULT true,
  ADD COLUMN "monthly_token_limit" bigint,
  ADD COLUMN "usage_source" text CHECK ("usage_source" IN ('farm', 'own'));
--> statement-breakpoint
ALTER TABLE "farm_invites"
  ADD COLUMN "use_farm_plan" boolean NOT NULL DEFAULT false,
  ADD COLUMN "monthly_token_limit" bigint;
--> statement-breakpoint
ALTER TABLE "llm_usage"
  ADD COLUMN "user_id" uuid,
  ADD COLUMN "account_id" uuid,
  ALTER COLUMN "farm_id" DROP NOT NULL;
--> statement-breakpoint
UPDATE "llm_usage" SET "account_id" = "farm_id";
--> statement-breakpoint
ALTER TABLE "llm_usage" ALTER COLUMN "account_id" SET NOT NULL;
--> statement-breakpoint
CREATE INDEX "llm_usage_account_created_idx" ON "llm_usage" ("account_id", "created_at");
--> statement-breakpoint
CREATE INDEX "llm_usage_member_created_idx" ON "llm_usage" ("farm_id", "user_id", "created_at");
--> statement-breakpoint
ALTER TABLE "voice_usage"
  ADD COLUMN "user_id" uuid,
  ADD COLUMN "account_id" uuid,
  ALTER COLUMN "farm_id" DROP NOT NULL;
--> statement-breakpoint
UPDATE "voice_usage" SET "account_id" = "farm_id";
--> statement-breakpoint
ALTER TABLE "voice_usage" ALTER COLUMN "account_id" SET NOT NULL;
--> statement-breakpoint
CREATE INDEX "voice_usage_account_created_idx" ON "voice_usage" ("account_id", "created_at");
--> statement-breakpoint
CREATE INDEX "voice_usage_member_created_idx" ON "voice_usage" ("farm_id", "user_id", "created_at");
