ALTER TABLE "slack_links" ADD COLUMN "moments_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "slack_links" ADD COLUMN "recap_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "slack_links" ADD COLUMN "time_zone" text;--> statement-breakpoint
ALTER TABLE "slack_links" ADD COLUMN "last_recap_at" bigint;