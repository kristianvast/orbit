ALTER TABLE "farm_subscriptions" DROP CONSTRAINT "farm_subscriptions_plan_check";
--> statement-breakpoint
UPDATE "farm_subscriptions"
SET "plan" = CASE "plan" WHEN 'pen' THEN 'cam2' WHEN 'barn' THEN 'cam6' ELSE "plan" END;
--> statement-breakpoint
ALTER TABLE "farm_subscriptions" ADD CONSTRAINT "farm_subscriptions_plan_check"
CHECK ("plan" IN ('free', 'orion', 'cam2', 'cam4', 'cam6'));
