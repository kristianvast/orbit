ALTER TABLE "users" ADD COLUMN "google_sub" text;
--> statement-breakpoint
CREATE UNIQUE INDEX "users_google_sub_unique" ON "users" ("google_sub");
--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "password_hash" DROP NOT NULL;
