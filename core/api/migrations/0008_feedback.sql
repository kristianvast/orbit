CREATE TABLE "feedback" (
  "id" uuid PRIMARY KEY NOT NULL DEFAULT gen_random_uuid(),
  "user_id" uuid,
  "farm_id" uuid,
  "kind" text NOT NULL,
  "message" text NOT NULL,
  "contact_email" text,
  "app_version" text,
  "os" text,
  "locale" text,
  "diagnostics" text,
  "status" text NOT NULL DEFAULT 'new',
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "submissions" (
  "id" uuid PRIMARY KEY NOT NULL DEFAULT gen_random_uuid(),
  "user_id" uuid NOT NULL,
  "farm_id" uuid,
  "kind" text NOT NULL,
  "name" text NOT NULL,
  "title" text NOT NULL,
  "description" text NOT NULL,
  "app_version" text,
  "files" jsonb NOT NULL,
  "bytes" integer NOT NULL,
  "status" text NOT NULL DEFAULT 'pending',
  "review_note" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "reviewed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "submissions_user_created_idx" ON "submissions" ("user_id", "created_at");
--> statement-breakpoint
CREATE TABLE "feedback_rate_events" (
  "id" uuid PRIMARY KEY NOT NULL DEFAULT gen_random_uuid(),
  "identity" text NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX "feedback_rate_events_identity_created_idx" ON "feedback_rate_events" ("identity", "created_at");
