ALTER TABLE "animals" ADD COLUMN "identifier_scheme" text;--> statement-breakpoint
ALTER TABLE "animals" ADD COLUMN "alternative_identifiers" jsonb;--> statement-breakpoint
ALTER TABLE "animals" ADD COLUMN "reproduction_status" text;--> statement-breakpoint
ALTER TABLE "animals" ADD COLUMN "lactation_status" text;