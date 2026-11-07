CREATE TABLE "billing_customers" (
  "farm_id" uuid PRIMARY KEY NOT NULL,
  "stripe_customer_id" text NOT NULL UNIQUE
);
--> statement-breakpoint
CREATE TABLE "farm_subscriptions" (
  "farm_id" uuid PRIMARY KEY NOT NULL,
  "plan" text NOT NULL CHECK ("plan" IN ('free', 'pen', 'barn')),
  "interval" text CHECK ("interval" IN ('month', 'year')),
  "status" text NOT NULL,
  "stripe_subscription_id" text UNIQUE,
  "current_period_end" timestamp with time zone,
  "cancel_at_period_end" boolean NOT NULL DEFAULT false,
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "stripe_events" (
  "id" text PRIMARY KEY NOT NULL,
  "type" text NOT NULL,
  "received_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "hardware_orders" (
  "stripe_checkout_session_id" text PRIMARY KEY NOT NULL,
  "email" text,
  "boxes" integer NOT NULL DEFAULT 0,
  "cameras" integer NOT NULL DEFAULT 0,
  "status" text NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "voice_usage" (
  "id" uuid PRIMARY KEY NOT NULL DEFAULT gen_random_uuid(),
  "farm_id" uuid NOT NULL,
  "seconds" integer NOT NULL,
  "model" text NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX "voice_usage_farm_created_idx" ON "voice_usage" ("farm_id", "created_at");
