CREATE TABLE "voice_demo_sessions" (
  "id" uuid PRIMARY KEY NOT NULL DEFAULT gen_random_uuid(),
  "visitor" text NOT NULL,
  "conversation_id" text,
  "reserved_seconds" integer NOT NULL,
  "charged_seconds" integer,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX "voice_demo_sessions_visitor_created_idx" ON "voice_demo_sessions" ("visitor", "created_at");
--> statement-breakpoint
CREATE INDEX "voice_demo_sessions_created_idx" ON "voice_demo_sessions" ("created_at");
