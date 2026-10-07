CREATE TABLE "analytics_events" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"user_id" text,
	"room_id" text,
	"props" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "api_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"kind" text DEFAULT 'pat' NOT NULL,
	"label" text NOT NULL,
	"scopes" jsonb DEFAULT '["rooms"]'::jsonb NOT NULL,
	"client_id" text,
	"created_at" bigint NOT NULL,
	"last_used_at" bigint,
	"revoked_at" bigint
);
--> statement-breakpoint
CREATE TABLE "avatar_reports" (
	"id" text PRIMARY KEY NOT NULL,
	"avatar_id" text NOT NULL,
	"reporter_id" text NOT NULL,
	"room_id" text,
	"reason" text NOT NULL,
	"created_at" bigint NOT NULL,
	"resolved_at" bigint,
	"resolution" text
);
--> statement-breakpoint
CREATE TABLE "avatars" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"source_format" text NOT NULL,
	"original_url" text,
	"original_key" text,
	"sheet_url" text NOT NULL,
	"thumb_url" text NOT NULL,
	"sha256" text,
	"frame_counts" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"rows" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"grid" jsonb,
	"pet_json" jsonb,
	"status" text NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "blobs" (
	"sha256" text PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"content_type" text NOT NULL,
	"bytes" integer NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "booth_slots" (
	"room_id" text NOT NULL,
	"slot" integer NOT NULL,
	"user_id" text,
	"consecutive_skips" integer DEFAULT 0 NOT NULL,
	"spins_this_turn" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "booth_slots_room_id_slot_pk" PRIMARY KEY("room_id","slot")
);
--> statement-breakpoint
CREATE TABLE "chat_messages" (
	"id" text PRIMARY KEY NOT NULL,
	"room_id" text NOT NULL,
	"user_id" text NOT NULL,
	"text" text NOT NULL,
	"reactions" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "crate_items" (
	"id" text PRIMARY KEY NOT NULL,
	"room_id" text NOT NULL,
	"user_id" text NOT NULL,
	"track_uri" text NOT NULL,
	"title" text NOT NULL,
	"artists" jsonb NOT NULL,
	"album" text DEFAULT '' NOT NULL,
	"duration_ms" integer NOT NULL,
	"art_url" text,
	"explicit" boolean DEFAULT false NOT NULL,
	"playable" boolean DEFAULT true NOT NULL,
	"position" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "deletion_requests" (
	"user_id" text PRIMARY KEY NOT NULL,
	"requested_at" bigint NOT NULL,
	"completed_at" bigint
);
--> statement-breakpoint
CREATE TABLE "dj_queue" (
	"room_id" text NOT NULL,
	"user_id" text NOT NULL,
	"position" integer NOT NULL,
	"joined_at" bigint NOT NULL,
	"cooldown_until" bigint,
	CONSTRAINT "dj_queue_room_id_user_id_pk" PRIMARY KEY("room_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "identity_links" (
	"user_id" text NOT NULL,
	"provider" text NOT NULL,
	"external_id" text NOT NULL,
	"team_id" text DEFAULT '' NOT NULL,
	"created_at" bigint NOT NULL,
	"last_surface_at" bigint,
	CONSTRAINT "identity_links_provider_team_id_external_id_pk" PRIMARY KEY("provider","team_id","external_id")
);
--> statement-breakpoint
CREATE TABLE "invites" (
	"id" text PRIMARY KEY NOT NULL,
	"room_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" bigint NOT NULL,
	"expires_at" bigint,
	"revoked_at" bigint,
	"uses" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oauth_clients" (
	"client_id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"redirect_uris" jsonb NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "room_members" (
	"room_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role" text NOT NULL,
	"banned" boolean DEFAULT false NOT NULL,
	"muted" boolean DEFAULT false NOT NULL,
	"avatar_hidden" boolean DEFAULT false NOT NULL,
	"set_mode" text DEFAULT 'local' NOT NULL,
	"set_playlist_id" text,
	"set_playlist_name" text,
	"set_snapshot_id" text,
	"set_position" integer DEFAULT 0 NOT NULL,
	"set_notice" text,
	"joined_at" bigint NOT NULL,
	"last_seen_at" bigint,
	CONSTRAINT "room_members_room_id_user_id_pk" PRIMARY KEY("room_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "rooms" (
	"id" text PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"owner_id" text NOT NULL,
	"visibility" text NOT NULL,
	"settings_json" jsonb NOT NULL,
	"created_at" bigint NOT NULL,
	CONSTRAINT "rooms_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"refresh_hash" text NOT NULL,
	"user_agent" text,
	"created_at" bigint NOT NULL,
	"expires_at" bigint NOT NULL,
	"revoked_at" bigint
);
--> statement-breakpoint
CREATE TABLE "slack_installs" (
	"team_id" text PRIMARY KEY NOT NULL,
	"team_name" text,
	"bot_token_enc" text NOT NULL,
	"bot_user_id" text,
	"installed_by" text NOT NULL,
	"installed_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "slack_links" (
	"team_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"room_id" text NOT NULL,
	"card_message_ts" text,
	"messages_since_card" integer DEFAULT 0 NOT NULL,
	"created_at" bigint NOT NULL,
	CONSTRAINT "slack_links_team_id_channel_id_pk" PRIMARY KEY("team_id","channel_id")
);
--> statement-breakpoint
CREATE TABLE "speakers" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"room_id" text NOT NULL,
	"kind" text NOT NULL,
	"spotify_device_id" text,
	"status" text NOT NULL,
	"created_at" bigint NOT NULL,
	"last_heartbeat_at" bigint,
	"last_audible_at" bigint,
	"closed_at" bigint
);
--> statement-breakpoint
CREATE TABLE "spins" (
	"id" text PRIMARY KEY NOT NULL,
	"room_id" text NOT NULL,
	"dj_user_id" text NOT NULL,
	"track_uri" text NOT NULL,
	"title" text NOT NULL,
	"artists" jsonb NOT NULL,
	"album" text DEFAULT '' NOT NULL,
	"art_url" text,
	"explicit" boolean DEFAULT false NOT NULL,
	"duration_ms" integer NOT NULL,
	"started_at" bigint NOT NULL,
	"ended_at" bigint,
	"end_reason" text,
	"hype_count" integer DEFAULT 0 NOT NULL,
	"skip_count" integer DEFAULT 0 NOT NULL,
	"eligible_voters" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "spotify_tokens" (
	"user_id" text PRIMARY KEY NOT NULL,
	"refresh_token_enc" text NOT NULL,
	"access_token_enc" text NOT NULL,
	"expires_at" bigint NOT NULL,
	"scopes" text NOT NULL,
	"client_id" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"spotify_user_id" text NOT NULL,
	"spotify_client_id" text,
	"display_name" text NOT NULL,
	"email" text,
	"avatar_id" text DEFAULT 'preset-bolt' NOT NULL,
	"preset_avatar_id" text DEFAULT 'preset-bolt' NOT NULL,
	"avatar_color" text DEFAULT '#3DE2FF' NOT NULL,
	"is_premium" boolean DEFAULT false NOT NULL,
	"is_admin" boolean DEFAULT false NOT NULL,
	"points" integer DEFAULT 0 NOT NULL,
	"upload_revoked" boolean DEFAULT false NOT NULL,
	"violation_count" integer DEFAULT 0 NOT NULL,
	"deleted_at" bigint,
	"created_at" bigint NOT NULL,
	CONSTRAINT "users_spotify_user_id_unique" UNIQUE("spotify_user_id")
);
--> statement-breakpoint
CREATE TABLE "votes" (
	"spin_id" text NOT NULL,
	"user_id" text NOT NULL,
	"value" text NOT NULL,
	"updated_at" bigint NOT NULL,
	"surface" text NOT NULL,
	CONSTRAINT "votes_spin_id_user_id_pk" PRIMARY KEY("spin_id","user_id")
);
--> statement-breakpoint
CREATE INDEX "analytics_name_at_idx" ON "analytics_events" USING btree ("name","at");--> statement-breakpoint
CREATE UNIQUE INDEX "api_tokens_hash_idx" ON "api_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "api_tokens_user_idx" ON "api_tokens" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "avatar_reports_open_idx" ON "avatar_reports" USING btree ("resolved_at");--> statement-breakpoint
CREATE INDEX "avatars_owner_idx" ON "avatars" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "avatars_status_idx" ON "avatars" USING btree ("status");--> statement-breakpoint
CREATE INDEX "chat_room_created_idx" ON "chat_messages" USING btree ("room_id","created_at");--> statement-breakpoint
CREATE INDEX "crate_items_member_idx" ON "crate_items" USING btree ("room_id","user_id","position");--> statement-breakpoint
CREATE INDEX "identity_links_user_idx" ON "identity_links" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "invites_token_idx" ON "invites" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "invites_room_idx" ON "invites" USING btree ("room_id");--> statement-breakpoint
CREATE INDEX "room_members_user_idx" ON "room_members" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_refresh_idx" ON "sessions" USING btree ("refresh_hash");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "slack_links_room_idx" ON "slack_links" USING btree ("room_id");--> statement-breakpoint
CREATE INDEX "speakers_member_idx" ON "speakers" USING btree ("room_id","user_id");--> statement-breakpoint
CREATE INDEX "spins_room_started_idx" ON "spins" USING btree ("room_id","started_at");