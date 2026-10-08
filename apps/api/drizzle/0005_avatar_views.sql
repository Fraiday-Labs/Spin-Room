ALTER TABLE "avatars" ADD COLUMN "views" jsonb;--> statement-breakpoint
ALTER TABLE "avatars" ADD COLUMN "views_url" text;--> statement-breakpoint
ALTER TABLE "avatars" ADD COLUMN "choices" jsonb;