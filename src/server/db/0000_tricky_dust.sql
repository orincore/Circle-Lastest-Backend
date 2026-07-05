-- Current sql file was generated after introspecting the database
-- If you want to run this migration please uncomment this code before executing migrations
/*
CREATE TYPE "public"."message_receipt_status" AS ENUM('delivered', 'read');--> statement-breakpoint
CREATE TYPE "public"."verification_status" AS ENUM('pending', 'verified', 'rejected', 'expired');--> statement-breakpoint
CREATE TABLE "activity_feed" (
	"id" text PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"data" jsonb NOT NULL,
	"timestamp" timestamp with time zone DEFAULT now() NOT NULL,
	"user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "activity_feed" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "admin_audit_logs" (
	"id" uuid PRIMARY KEY DEFAULT extensions.uuid_generate_v4() NOT NULL,
	"admin_id" uuid,
	"action" text NOT NULL,
	"target_type" text,
	"target_id" uuid,
	"details" jsonb,
	"ip_address" text,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "admin_audit_logs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "analytics_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"event_name" varchar(100) NOT NULL,
	"user_id" uuid,
	"session_id" varchar(100),
	"timestamp" timestamp with time zone NOT NULL,
	"properties" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "analytics_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "admin_roles" (
	"id" uuid PRIMARY KEY DEFAULT extensions.uuid_generate_v4() NOT NULL,
	"user_id" uuid,
	"role" text NOT NULL,
	"granted_by" uuid,
	"granted_at" timestamp with time zone DEFAULT now(),
	"revoked_at" timestamp with time zone,
	"is_active" boolean DEFAULT true,
	CONSTRAINT "admin_roles_user_id_key" UNIQUE("user_id"),
	CONSTRAINT "admin_roles_role_check" CHECK (role = ANY (ARRAY['super_admin'::text, 'moderator'::text, 'support'::text]))
);
--> statement-breakpoint
ALTER TABLE "admin_roles" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "ai_conversations" (
	"id" varchar(255) PRIMARY KEY NOT NULL,
	"user_id" uuid,
	"session_id" varchar(255) NOT NULL,
	"messages" jsonb DEFAULT '[]'::jsonb,
	"status" varchar(50) DEFAULT 'active',
	"intent" varchar(100) DEFAULT 'general',
	"refund_explanation_count" integer DEFAULT 0,
	"estimated_cost" numeric(10, 6) DEFAULT '0.000000',
	"token_count" integer DEFAULT 0,
	"user_context" jsonb,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	"personality" jsonb,
	"conversation_state" jsonb,
	"sentiment_analysis" jsonb,
	"detected_language" varchar(10),
	"escalation_level" varchar(20),
	"satisfaction_rating" integer,
	"proactive_alerts" jsonb,
	CONSTRAINT "ai_conversations_satisfaction_rating_check" CHECK ((satisfaction_rating >= 1) AND (satisfaction_rating <= 5)),
	CONSTRAINT "ai_conversations_status_check" CHECK ((status)::text = ANY (ARRAY[('active'::character varying)::text, ('escalated'::character varying)::text, ('resolved'::character varying)::text, ('abandoned'::character varying)::text]))
);
--> statement-breakpoint
ALTER TABLE "ai_conversations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "friendships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user1_id" uuid NOT NULL,
	"user2_id" uuid NOT NULL,
	"status" varchar(20) DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	"sender_id" uuid,
	CONSTRAINT "unique_friendship" UNIQUE("user1_id","user2_id"),
	CONSTRAINT "check_friendships_status" CHECK ((status)::text = ANY (ARRAY[('pending'::character varying)::text, ('accepted'::character varying)::text, ('active'::character varying)::text, ('inactive'::character varying)::text, ('blocked'::character varying)::text]))
);
--> statement-breakpoint
CREATE TABLE "app_version_config" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"platform" varchar(20) NOT NULL,
	"min_version" varchar(20) DEFAULT '1.0.0' NOT NULL,
	"latest_version" varchar(20) DEFAULT '1.0.0' NOT NULL,
	"force_update" boolean DEFAULT false NOT NULL,
	"update_message" text DEFAULT 'A new version of Circle is available. Please update to continue.',
	"optional_update_message" text DEFAULT 'A new version is available with new features!',
	"store_url" text,
	"updated_at" timestamp with time zone DEFAULT now(),
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "app_version_config_platform_key" UNIQUE("platform"),
	CONSTRAINT "app_version_config_platform_check" CHECK ((platform)::text = ANY (ARRAY[('android'::character varying)::text, ('ios'::character varying)::text]))
);
--> statement-breakpoint
ALTER TABLE "app_version_config" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "giver_request_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"help_request_id" uuid NOT NULL,
	"giver_user_id" uuid NOT NULL,
	"status" varchar(20) DEFAULT 'pending',
	"sent_at" timestamp with time zone DEFAULT now(),
	"responded_at" timestamp with time zone,
	"response_time_seconds" integer,
	"created_at" timestamp with time zone DEFAULT now(),
	"notified_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "unique_request_attempt" UNIQUE("help_request_id","giver_user_id"),
	CONSTRAINT "giver_request_attempts_status_check" CHECK ((status)::text = ANY (ARRAY[('pending'::character varying)::text, ('accepted'::character varying)::text, ('declined'::character varying)::text, ('expired'::character varying)::text]))
);
--> statement-breakpoint
ALTER TABLE "giver_request_attempts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"username" text NOT NULL,
	"first_name" text NOT NULL,
	"last_name" text NOT NULL,
	"age" integer NOT NULL,
	"gender" text NOT NULL,
	"phone_number" text,
	"profile_photo_url" text,
	"password_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now(),
	"interests" text[] DEFAULT '{""}' NOT NULL,
	"needs" text[] DEFAULT '{""}' NOT NULL,
	"latitude" numeric(10, 8),
	"longitude" numeric(11, 8),
	"location_address" text,
	"location_city" text,
	"location_country" text,
	"location_updated_at" timestamp with time zone,
	"location_preference" varchar(50) DEFAULT 'nearby',
	"age_preference" varchar(50) DEFAULT 'flexible',
	"friendship_location_priority" boolean DEFAULT true,
	"relationship_distance_flexible" boolean DEFAULT true,
	"preferences_updated_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone,
	"about" text NOT NULL,
	"circle_points" integer DEFAULT 100,
	"total_matches" integer DEFAULT 0,
	"messages_sent" integer DEFAULT 0,
	"messages_received" integer DEFAULT 0,
	"profile_visits_received" integer DEFAULT 0,
	"total_friends" integer DEFAULT 0,
	"last_active" timestamp DEFAULT CURRENT_TIMESTAMP,
	"stats_updated_at" timestamp DEFAULT CURRENT_TIMESTAMP,
	"total_calls_made" integer DEFAULT 0,
	"total_calls_received" integer DEFAULT 0,
	"total_call_duration_seconds" integer DEFAULT 0,
	"instagram_username" text,
	"invisible_mode" boolean DEFAULT false NOT NULL,
	"last_seen" timestamp with time zone DEFAULT now(),
	"is_suspended" boolean DEFAULT false,
	"suspension_reason" text,
	"suspension_ends_at" timestamp with time zone,
	"suspended_at" timestamp with time zone,
	"suspended_by" uuid,
	"deleted_at" timestamp with time zone,
	"deleted_by" uuid,
	"deletion_reason" text,
	"deletion_feedback" text,
	"email_verified" boolean DEFAULT false,
	"email_verified_at" timestamp with time zone,
	"subscription_plan" varchar(20) DEFAULT 'free',
	"premium_expires_at" timestamp with time zone,
	"is_deleted" boolean DEFAULT false,
	"verification_status" "verification_status" DEFAULT 'pending',
	"verified_at" timestamp with time zone,
	"verification_required" boolean DEFAULT true,
	"is_premium" boolean DEFAULT false,
	"subscription_expires_at" timestamp with time zone,
	"role" text,
	"is_admin" boolean,
	CONSTRAINT "check_about_length" CHECK ((about IS NULL) OR (length(about) <= 500)),
	CONSTRAINT "profiles_age_check" CHECK ((age >= 13) AND (age <= 120)),
	CONSTRAINT "profiles_subscription_plan_check" CHECK ((subscription_plan)::text = ANY (ARRAY[('free'::character varying)::text, ('premium'::character varying)::text, ('premium_plus'::character varying)::text]))
);
--> statement-breakpoint
ALTER TABLE "profiles" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "announcements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" text,
	"message" text NOT NULL,
	"image_url" text,
	"link_url" text,
	"buttons" jsonb,
	"placements" text[],
	"audience" text DEFAULT 'all',
	"countries" text[],
	"min_app_version" text,
	"priority" integer DEFAULT 0,
	"starts_at" timestamp with time zone,
	"ends_at" timestamp with time zone,
	"is_active" boolean DEFAULT true,
	"send_push_on_publish" boolean DEFAULT false,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	"published_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "app_versions" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"user_id" uuid,
	"version" varchar(20) NOT NULL,
	"build_number" varchar(20) NOT NULL,
	"platform" varchar(20) NOT NULL,
	"expo_version" varchar(20),
	"device_id" varchar(100),
	"device_name" varchar(200),
	"device_model" varchar(100),
	"os_version" varchar(50),
	"timestamp" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "app_versions_platform_check" CHECK ((platform)::text = ANY (ARRAY[('ios'::character varying)::text, ('android'::character varying)::text, ('web'::character varying)::text]))
);
--> statement-breakpoint
ALTER TABLE "app_versions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "agent_capabilities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" varchar(100) NOT NULL,
	"name" varchar(200) NOT NULL,
	"languages" text[] DEFAULT '{"RAY['en'::tex"}',
	"specialties" text[] DEFAULT '{"RAY['general_support'::tex"}',
	"current_load" integer DEFAULT 0,
	"max_load" integer DEFAULT 5,
	"availability" varchar(20) DEFAULT 'offline',
	"rating" numeric(3, 2) DEFAULT '0.0',
	"response_time" integer DEFAULT 5,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "agent_capabilities_agent_id_key" UNIQUE("agent_id"),
	CONSTRAINT "agent_capabilities_availability_check" CHECK ((availability)::text = ANY (ARRAY[('available'::character varying)::text, ('busy'::character varying)::text, ('offline'::character varying)::text]))
);
--> statement-breakpoint
CREATE TABLE "crash_reports" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"crash_id" varchar(100) NOT NULL,
	"user_id" uuid,
	"session_id" varchar(100),
	"timestamp" timestamp with time zone NOT NULL,
	"type" varchar(50) NOT NULL,
	"is_fatal" boolean DEFAULT false,
	"error_name" varchar(200) NOT NULL,
	"error_message" text NOT NULL,
	"error_stack" text,
	"device_platform" varchar(20) NOT NULL,
	"device_version" varchar(50),
	"device_model" varchar(100),
	"device_name" varchar(200),
	"app_version" varchar(20) NOT NULL,
	"build_number" varchar(20) NOT NULL,
	"expo_version" varchar(20),
	"is_device" boolean DEFAULT true,
	"breadcrumbs" jsonb DEFAULT '[]'::jsonb,
	"user_context" jsonb DEFAULT '{}'::jsonb,
	"resolved" boolean DEFAULT false,
	"resolved_at" timestamp with time zone,
	"resolved_by" uuid,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "crash_reports_crash_id_key" UNIQUE("crash_id")
);
--> statement-breakpoint
ALTER TABLE "crash_reports" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "blind_date_daily_queue" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"scheduled_date" date NOT NULL,
	"matched_user_id" uuid,
	"match_id" uuid,
	"status" varchar(20) DEFAULT 'pending',
	"processed_at" timestamp with time zone,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "blind_date_daily_queue_user_id_scheduled_date_key" UNIQUE("user_id","scheduled_date"),
	CONSTRAINT "blind_date_daily_queue_status_check" CHECK ((status)::text = ANY (ARRAY[('pending'::character varying)::text, ('matched'::character varying)::text, ('no_match'::character varying)::text, ('skipped'::character varying)::text, ('error'::character varying)::text]))
);
--> statement-breakpoint
CREATE TABLE "daily_match_limits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"date" date DEFAULT CURRENT_DATE NOT NULL,
	"matches_made" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "daily_match_limits_user_id_date_key" UNIQUE("user_id","date")
);
--> statement-breakpoint
CREATE TABLE "chats" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_message_at" timestamp with time zone,
	"message_permission" varchar(20) DEFAULT 'friends_only',
	"is_message_request" boolean DEFAULT false,
	CONSTRAINT "chats_message_permission_check" CHECK ((message_permission)::text = ANY (ARRAY[('everyone'::character varying)::text, ('friends_only'::character varying)::text, ('blocked'::character varying)::text]))
);
--> statement-breakpoint
CREATE TABLE "blind_dating_settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"is_enabled" boolean DEFAULT false,
	"daily_match_time" time DEFAULT '09:00:00',
	"max_active_matches" integer DEFAULT 3,
	"preferred_reveal_threshold" integer DEFAULT 30,
	"auto_match" boolean DEFAULT true,
	"notifications_enabled" boolean DEFAULT true,
	"last_match_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "blind_dating_settings_user_id_key" UNIQUE("user_id")
);
--> statement-breakpoint
CREATE TABLE "chat_mute_settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"chat_id" uuid NOT NULL,
	"is_muted" boolean DEFAULT false,
	"muted_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "chat_mute_settings_user_id_chat_id_key" UNIQUE("user_id","chat_id")
);
--> statement-breakpoint
ALTER TABLE "chat_mute_settings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "chat_user_settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"chat_id" uuid NOT NULL,
	"archived" boolean DEFAULT false NOT NULL,
	"pinned" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_user_settings_user_id_chat_id_key" UNIQUE("user_id","chat_id")
);
--> statement-breakpoint
ALTER TABLE "chat_user_settings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "campaign_analytics" (
	"id" uuid PRIMARY KEY DEFAULT extensions.uuid_generate_v4() NOT NULL,
	"campaign_id" uuid,
	"total_sent" integer DEFAULT 0,
	"delivered" integer DEFAULT 0,
	"opened" integer DEFAULT 0,
	"clicked" integer DEFAULT 0,
	"converted" integer DEFAULT 0,
	"unsubscribed" integer DEFAULT 0,
	"bounced" integer DEFAULT 0,
	"failed" integer DEFAULT 0,
	"updated_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "campaign_analytics_campaign_id_key" UNIQUE("campaign_id")
);
--> statement-breakpoint
CREATE TABLE "conversation_analytics" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"date" date NOT NULL,
	"total_conversations" integer DEFAULT 0,
	"resolved_conversations" integer DEFAULT 0,
	"escalated_conversations" integer DEFAULT 0,
	"average_satisfaction" numeric(3, 2) DEFAULT '0.0',
	"average_response_time" integer DEFAULT 0,
	"total_cost" numeric(10, 2) DEFAULT '0.0',
	"ai_efficiency_score" integer DEFAULT 0,
	"created_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "conversation_analytics_date_key" UNIQUE("date")
);
--> statement-breakpoint
CREATE TABLE "email_otps" (
	"id" uuid PRIMARY KEY DEFAULT extensions.uuid_generate_v4() NOT NULL,
	"email" text NOT NULL,
	"otp" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"attempts" integer DEFAULT 0,
	"verified" boolean DEFAULT false,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	"verified_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "email_otps" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "escalation_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" varchar,
	"user_id" uuid,
	"escalation_reason" text NOT NULL,
	"priority" varchar(20) NOT NULL,
	"sentiment_score" numeric(3, 2),
	"assigned_agent" varchar(100),
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "escalation_logs_priority_check" CHECK ((priority)::text = ANY (ARRAY[('low'::character varying)::text, ('medium'::character varying)::text, ('high'::character varying)::text, ('critical'::character varying)::text]))
);
--> statement-breakpoint
CREATE TABLE "explore_cache_stats" (
	"id" serial PRIMARY KEY NOT NULL,
	"cache_key" varchar(255) NOT NULL,
	"user_id" uuid NOT NULL,
	"endpoint" varchar(100) NOT NULL,
	"hit_count" integer DEFAULT 0,
	"last_hit" timestamp DEFAULT CURRENT_TIMESTAMP,
	"created_at" timestamp DEFAULT CURRENT_TIMESTAMP,
	"expires_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "beta_testers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"full_name" text NOT NULL,
	"email" text NOT NULL,
	"phone" text NOT NULL,
	"age" integer NOT NULL,
	"gender" text NOT NULL,
	"location" text NOT NULL,
	"device_type" text NOT NULL,
	"device_model" text NOT NULL,
	"android_version" text,
	"ios_version" text,
	"occupation" text NOT NULL,
	"testing_experience" text NOT NULL,
	"availability" text NOT NULL,
	"motivation" text NOT NULL,
	"social_media_handle" text,
	"referral_source" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"rejection_reason" text,
	"play_console_added" boolean DEFAULT false,
	"applied_at" timestamp with time zone DEFAULT now() NOT NULL,
	"approved_at" timestamp with time zone,
	"rejected_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "beta_testers_email_key" UNIQUE("email"),
	CONSTRAINT "beta_testers_age_check" CHECK ((age >= 18) AND (age <= 100)),
	CONSTRAINT "beta_testers_device_type_check" CHECK (device_type = ANY (ARRAY['android'::text, 'ios'::text])),
	CONSTRAINT "beta_testers_gender_check" CHECK (gender = ANY (ARRAY['male'::text, 'female'::text, 'other'::text])),
	CONSTRAINT "beta_testers_status_check" CHECK (status = ANY (ARRAY['pending'::text, 'approved'::text, 'rejected'::text]))
);
--> statement-breakpoint
ALTER TABLE "beta_testers" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "blocks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"blocker_id" uuid NOT NULL,
	"blocked_id" uuid NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "blocks_blocker_id_blocked_id_key" UNIQUE("blocker_id","blocked_id"),
	CONSTRAINT "blocks_check" CHECK (blocker_id <> blocked_id)
);
--> statement-breakpoint
ALTER TABLE "blocks" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "blind_date_matches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_a" uuid NOT NULL,
	"user_b" uuid NOT NULL,
	"chat_id" uuid,
	"compatibility_score" numeric(5, 2),
	"status" varchar(20) DEFAULT 'active',
	"message_count" integer DEFAULT 0,
	"reveal_threshold" integer DEFAULT 30,
	"user_a_revealed" boolean DEFAULT false,
	"user_b_revealed" boolean DEFAULT false,
	"revealed_at" timestamp with time zone,
	"reveal_requested_by" uuid,
	"reveal_requested_at" timestamp with time zone,
	"matched_at" timestamp with time zone DEFAULT now(),
	"ended_at" timestamp with time zone,
	"ended_by" uuid,
	"end_reason" varchar(50),
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	"reminder_sent_at" timestamp with time zone,
	CONSTRAINT "blind_date_matches_user_a_user_b_status_key" UNIQUE("user_a","user_b","status"),
	CONSTRAINT "blind_date_matches_status_check" CHECK ((status)::text = ANY (ARRAY[('active'::character varying)::text, ('revealed'::character varying)::text, ('ended'::character varying)::text, ('expired'::character varying)::text, ('blocked'::character varying)::text])),
	CONSTRAINT "unique_blind_date_pair" CHECK (user_a < user_b)
);
--> statement-breakpoint
CREATE TABLE "chat_deletions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"chat_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"deleted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_deletions_chat_id_user_id_key" UNIQUE("chat_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "email_templates" (
	"id" uuid PRIMARY KEY DEFAULT extensions.uuid_generate_v4() NOT NULL,
	"name" text NOT NULL,
	"subject" text NOT NULL,
	"html_content" text NOT NULL,
	"text_content" text,
	"category" text,
	"variables" jsonb,
	"preview_text" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "email_templates_category_check" CHECK (category = ANY (ARRAY['welcome'::text, 'engagement'::text, 're-engagement'::text, 'promotional'::text, 'transactional'::text]))
);
--> statement-breakpoint
CREATE TABLE "feature_usage" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"user_id" uuid,
	"feature_name" varchar(100) NOT NULL,
	"first_used_at" timestamp with time zone NOT NULL,
	"last_used_at" timestamp with time zone NOT NULL,
	"usage_count" integer DEFAULT 1,
	"total_time_seconds" integer DEFAULT 0,
	"feature_data" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "feature_usage_user_id_feature_name_key" UNIQUE("user_id","feature_name")
);
--> statement-breakpoint
ALTER TABLE "feature_usage" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "giver_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"is_available" boolean DEFAULT true,
	"skills" text[],
	"interests" text[],
	"bio" text,
	"categories" text[],
	"profile_embedding" vector(1536),
	"total_helps_given" integer DEFAULT 0,
	"average_rating" numeric(3, 2) DEFAULT '0.00',
	"last_active_at" timestamp with time zone DEFAULT now(),
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "unique_giver_profile" UNIQUE("user_id")
);
--> statement-breakpoint
ALTER TABLE "giver_profiles" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "follow_up_tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" varchar,
	"user_id" uuid,
	"urgency" varchar(20) NOT NULL,
	"reason" text NOT NULL,
	"action_items" jsonb,
	"scheduled_for" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	"assigned_to" varchar(100),
	"status" varchar(20) DEFAULT 'pending',
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "follow_up_tasks_status_check" CHECK ((status)::text = ANY (ARRAY[('pending'::character varying)::text, ('in_progress'::character varying)::text, ('completed'::character varying)::text, ('cancelled'::character varying)::text])),
	CONSTRAINT "follow_up_tasks_urgency_check" CHECK ((urgency)::text = ANY (ARRAY[('low'::character varying)::text, ('medium'::character varying)::text, ('high'::character varying)::text]))
);
--> statement-breakpoint
CREATE TABLE "feedback_analysis" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" varchar,
	"sentiment" varchar(20) NOT NULL,
	"themes" jsonb,
	"action_items" jsonb,
	"urgency" varchar(20) NOT NULL,
	"follow_up_required" boolean DEFAULT false,
	"created_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "feedback_analysis_sentiment_check" CHECK ((sentiment)::text = ANY (ARRAY[('positive'::character varying)::text, ('negative'::character varying)::text, ('neutral'::character varying)::text])),
	CONSTRAINT "feedback_analysis_urgency_check" CHECK ((urgency)::text = ANY (ARRAY[('low'::character varying)::text, ('medium'::character varying)::text, ('high'::character varying)::text]))
);
--> statement-breakpoint
CREATE TABLE "friend_location_notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"from_user_id" uuid NOT NULL,
	"to_user_id" uuid NOT NULL,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "marketing_campaigns" (
	"id" uuid PRIMARY KEY DEFAULT extensions.uuid_generate_v4() NOT NULL,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"status" text DEFAULT 'draft',
	"subject" text,
	"content" text NOT NULL,
	"template_id" uuid,
	"segment_criteria" jsonb,
	"scheduled_at" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	"push_title" text,
	"push_body" text,
	CONSTRAINT "marketing_campaigns_status_check" CHECK (status = ANY (ARRAY['draft'::text, 'scheduled'::text, 'sending'::text, 'sent'::text, 'paused'::text, 'cancelled'::text])),
	CONSTRAINT "marketing_campaigns_type_check" CHECK (type = ANY (ARRAY['push_notification'::text, 'email'::text, 'in_app'::text]))
);
--> statement-breakpoint
CREATE TABLE "help_session_feedback" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"help_request_id" uuid NOT NULL,
	"chat_room_id" uuid,
	"receiver_user_id" uuid NOT NULL,
	"giver_user_id" uuid NOT NULL,
	"receiver_rating" integer,
	"giver_rating" integer,
	"receiver_feedback" text,
	"giver_feedback" text,
	"was_helpful" boolean,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "unique_session_feedback" UNIQUE("help_request_id"),
	CONSTRAINT "help_session_feedback_giver_rating_check" CHECK ((giver_rating >= 1) AND (giver_rating <= 5)),
	CONSTRAINT "help_session_feedback_receiver_rating_check" CHECK ((receiver_rating >= 1) AND (receiver_rating <= 5))
);
--> statement-breakpoint
ALTER TABLE "help_session_feedback" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "message_reactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"message_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"emoji" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "message_reactions_message_id_user_id_emoji_key" UNIQUE("message_id","user_id","emoji")
);
--> statement-breakpoint
ALTER TABLE "message_reactions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "feature_flags" (
	"id" uuid PRIMARY KEY DEFAULT extensions.uuid_generate_v4() NOT NULL,
	"name" text NOT NULL,
	"enabled" boolean DEFAULT false,
	"description" text,
	"rollout_percentage" integer DEFAULT 100,
	"target_users" jsonb,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "feature_flags_name_key" UNIQUE("name"),
	CONSTRAINT "feature_flags_rollout_percentage_check" CHECK ((rollout_percentage >= 0) AND (rollout_percentage <= 100))
);
--> statement-breakpoint
ALTER TABLE "feature_flags" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "matchmaking_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"proposal_id" text NOT NULL,
	"user_a" uuid NOT NULL,
	"user_b" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"accepted_a" boolean DEFAULT false NOT NULL,
	"accepted_b" boolean DEFAULT false NOT NULL,
	"matched_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"cancel_reason" text
);
--> statement-breakpoint
CREATE TABLE "explore_interactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"target_user_id" uuid NOT NULL,
	"action_type" text NOT NULL,
	"interaction_source" text DEFAULT 'explore',
	"created_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "unique_recent_interaction" UNIQUE("user_id","target_user_id","action_type","created_at"),
	CONSTRAINT "explore_interactions_action_type_check" CHECK (action_type = ANY (ARRAY['view'::text, 'like'::text, 'super_like'::text, 'pass'::text])),
	CONSTRAINT "explore_interactions_interaction_source_check" CHECK (interaction_source = ANY (ARRAY['explore'::text, 'search'::text, 'profile_view'::text]))
);
--> statement-breakpoint
ALTER TABLE "explore_interactions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "face_verifications" (
	"id" uuid PRIMARY KEY DEFAULT extensions.uuid_generate_v4() NOT NULL,
	"user_id" uuid NOT NULL,
	"status" "verification_status" DEFAULT 'pending' NOT NULL,
	"video_s3_key" text,
	"verification_data" jsonb,
	"confidence" numeric(3, 2),
	"movements_detected" text[],
	"submitted_at" timestamp with time zone DEFAULT now(),
	"verified_at" timestamp with time zone,
	"expires_at" timestamp with time zone DEFAULT (now() + '24:00:00'::interval),
	"reviewed_by" uuid,
	"review_notes" text,
	"reviewed_at" timestamp with time zone,
	"ip_address" "inet",
	"user_agent" text,
	"device_info" jsonb,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "marketing_automation_rules" (
	"id" uuid PRIMARY KEY DEFAULT extensions.uuid_generate_v4() NOT NULL,
	"name" text NOT NULL,
	"trigger_type" text NOT NULL,
	"trigger_conditions" jsonb,
	"action_type" text NOT NULL,
	"action_config" jsonb,
	"enabled" boolean DEFAULT true,
	"delay_minutes" integer DEFAULT 0,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "marketing_automation_rules_action_type_check" CHECK (action_type = ANY (ARRAY['send_email'::text, 'send_push'::text, 'add_to_segment'::text, 'create_notification'::text]))
);
--> statement-breakpoint
CREATE TABLE "referral_transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"referral_number" varchar(20) NOT NULL,
	"referrer_user_id" uuid NOT NULL,
	"referred_user_id" uuid NOT NULL,
	"referral_code" varchar(12) NOT NULL,
	"reward_amount" numeric(10, 2) DEFAULT '10.00',
	"status" varchar(20) DEFAULT 'pending',
	"rejection_reason" text,
	"verified_by" uuid,
	"verified_at" timestamp with time zone,
	"payment_date" timestamp with time zone,
	"payment_reference" varchar(100),
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "referral_transactions_referral_number_key" UNIQUE("referral_number"),
	CONSTRAINT "unique_referral" UNIQUE("referrer_user_id","referred_user_id"),
	CONSTRAINT "referral_transactions_status_check" CHECK ((status)::text = ANY (ARRAY[('pending'::character varying)::text, ('approved'::character varying)::text, ('rejected'::character varying)::text, ('paid'::character varying)::text]))
);
--> statement-breakpoint
CREATE TABLE "promotional_subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"promo_type" varchar(50) NOT NULL,
	"granted_at" timestamp with time zone DEFAULT now(),
	"subscription_id" uuid,
	"created_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "promotional_subscriptions_user_id_promo_type_key" UNIQUE("user_id","promo_type")
);
--> statement-breakpoint
CREATE TABLE "payment_orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" varchar(100) NOT NULL,
	"user_id" uuid NOT NULL,
	"plan_id" varchar(50) NOT NULL,
	"amount" numeric(10, 2) NOT NULL,
	"currency" varchar(3) DEFAULT 'INR',
	"status" varchar(20) DEFAULT 'created',
	"gateway" varchar(20) DEFAULT 'cashfree',
	"gateway_order_id" varchar(100),
	"gateway_payment_id" varchar(100),
	"payment_method" varchar(50),
	"failure_reason" text,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "payment_orders_order_id_key" UNIQUE("order_id")
);
--> statement-breakpoint
CREATE TABLE "proactive_alerts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid,
	"alert_type" varchar(50) NOT NULL,
	"severity" varchar(20) NOT NULL,
	"message" text NOT NULL,
	"suggested_action" text,
	"preventive_message" text,
	"timeframe" varchar(20),
	"status" varchar(20) DEFAULT 'active',
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "proactive_alerts_severity_check" CHECK ((severity)::text = ANY (ARRAY[('low'::character varying)::text, ('medium'::character varying)::text, ('high'::character varying)::text, ('critical'::character varying)::text])),
	CONSTRAINT "proactive_alerts_status_check" CHECK ((status)::text = ANY (ARRAY[('active'::character varying)::text, ('addressed'::character varying)::text, ('dismissed'::character varying)::text])),
	CONSTRAINT "proactive_alerts_timeframe_check" CHECK ((timeframe)::text = ANY (ARRAY[('immediate'::character varying)::text, ('within_24h'::character varying)::text, ('within_week'::character varying)::text]))
);
--> statement-breakpoint
CREATE TABLE "message_receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"message_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"status" "message_receipt_status" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "message_receipts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "referral_code_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"referral_code" varchar(12) NOT NULL,
	"attempted_by_user_id" uuid,
	"ip_address" varchar(45),
	"user_agent" text,
	"success" boolean DEFAULT false,
	"failure_reason" text,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "satisfaction_ratings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" varchar,
	"user_id" uuid,
	"rating" integer NOT NULL,
	"feedback" text,
	"category" varchar(50) DEFAULT 'overall' NOT NULL,
	"agent_type" varchar(10) DEFAULT 'ai' NOT NULL,
	"agent_id" varchar(100),
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "satisfaction_ratings_agent_type_check" CHECK ((agent_type)::text = ANY (ARRAY[('ai'::character varying)::text, ('human'::character varying)::text])),
	CONSTRAINT "satisfaction_ratings_rating_check" CHECK ((rating >= 1) AND (rating <= 5))
);
--> statement-breakpoint
CREATE TABLE "user_referrals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"referral_code" varchar(12) NOT NULL,
	"total_referrals" integer DEFAULT 0,
	"total_earnings" numeric(10, 2) DEFAULT '0.00',
	"pending_earnings" numeric(10, 2) DEFAULT '0.00',
	"paid_earnings" numeric(10, 2) DEFAULT '0.00',
	"upi_id" varchar(100),
	"upi_verified" boolean DEFAULT false,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "unique_user_referral" UNIQUE("user_id"),
	CONSTRAINT "user_referrals_referral_code_key" UNIQUE("referral_code")
);
--> statement-breakpoint
CREATE TABLE "user_activity_events" (
	"id" uuid PRIMARY KEY DEFAULT extensions.uuid_generate_v4() NOT NULL,
	"user_id" uuid NOT NULL,
	"event_name" text NOT NULL,
	"session_id" text,
	"properties" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "user_activity_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"chat_id" uuid NOT NULL,
	"sender_id" uuid NOT NULL,
	"text" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone,
	"is_edited" boolean DEFAULT false,
	"is_deleted" boolean DEFAULT false,
	"deleted_at" timestamp with time zone,
	"deleted_by" uuid,
	"media_url" text,
	"media_type" text,
	"thumbnail" text,
	"reply_to_id" uuid,
	"is_view_once" boolean DEFAULT false NOT NULL,
	"view_once_viewed_at" timestamp with time zone,
	CONSTRAINT "messages_media_type_check" CHECK ((media_type = ANY (ARRAY['image'::text, 'video'::text])) OR (media_type IS NULL))
);
--> statement-breakpoint
ALTER TABLE "messages" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"recipient_id" uuid NOT NULL,
	"sender_id" uuid,
	"type" varchar(50) NOT NULL,
	"title" varchar(255) NOT NULL,
	"message" text NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb,
	"read" boolean DEFAULT false,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "notifications" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "message_views" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"message_id" uuid NOT NULL,
	"viewer_id" uuid NOT NULL,
	"viewed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "message_views_message_id_viewer_id_key" UNIQUE("message_id","viewer_id")
);
--> statement-breakpoint
CREATE TABLE "nearby_notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"from_user_id" uuid NOT NULL,
	"to_user_id" uuid NOT NULL,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification_templates" (
	"id" uuid PRIMARY KEY DEFAULT extensions.uuid_generate_v4() NOT NULL,
	"name" text NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"category" text,
	"icon" text,
	"image_url" text,
	"deep_link" text,
	"variables" jsonb,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "notification_templates_category_check" CHECK (category = ANY (ARRAY['match'::text, 'message'::text, 'engagement'::text, 're-engagement'::text, 'system'::text]))
);
--> statement-breakpoint
CREATE TABLE "push_tokens" (
	"id" uuid PRIMARY KEY DEFAULT extensions.uuid_generate_v4() NOT NULL,
	"user_id" uuid NOT NULL,
	"token" text NOT NULL,
	"device_type" text,
	"device_name" text,
	"enabled" boolean DEFAULT true,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	"last_used_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "push_tokens_device_type_check" CHECK (device_type = ANY (ARRAY['ios'::text, 'android'::text, 'web'::text]))
);
--> statement-breakpoint
CREATE TABLE "satisfaction_surveys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" varchar,
	"questions" jsonb NOT NULL,
	"overall_score" numeric(3, 2),
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"plan_type" varchar(20) DEFAULT 'free' NOT NULL,
	"status" varchar(20) DEFAULT 'active' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"payment_provider" varchar(50),
	"external_subscription_id" varchar(255),
	"price_paid" numeric(10, 2),
	"currency" varchar(3) DEFAULT 'USD',
	"auto_renew" boolean DEFAULT true,
	"cancelled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "subscriptions_user_id_key" UNIQUE("user_id"),
	CONSTRAINT "subscriptions_plan_type_check" CHECK ((plan_type)::text = ANY (ARRAY[('free'::character varying)::text, ('premium'::character varying)::text, ('premium_plus'::character varying)::text])),
	CONSTRAINT "subscriptions_status_check" CHECK ((status)::text = ANY (ARRAY[('active'::character varying)::text, ('cancelled'::character varying)::text, ('expired'::character varying)::text, ('pending'::character varying)::text]))
);
--> statement-breakpoint
CREATE TABLE "survey_responses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"survey_id" uuid,
	"question_id" varchar(100) NOT NULL,
	"answer" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "user_photos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"photo_url" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "valid_photo_url" CHECK (photo_url ~ '^https?://.*'::text)
);
--> statement-breakpoint
ALTER TABLE "user_photos" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "user_consent" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"user_id" uuid,
	"analytics_consent" boolean DEFAULT false,
	"crash_reporting_consent" boolean DEFAULT false,
	"personalization_consent" boolean DEFAULT false,
	"marketing_consent" boolean DEFAULT false,
	"consent_version" varchar(10) DEFAULT '1.0',
	"consent_timestamp" timestamp with time zone NOT NULL,
	"ip_address" "inet",
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "user_consent_user_id_key" UNIQUE("user_id")
);
--> statement-breakpoint
ALTER TABLE "user_consent" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "user_activities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"activity_type" varchar(50) NOT NULL,
	"points_change" integer NOT NULL,
	"related_user_id" uuid,
	"metadata" jsonb,
	"created_at" timestamp DEFAULT CURRENT_TIMESTAMP
);
--> statement-breakpoint
CREATE TABLE "user_campaign_interactions" (
	"id" uuid PRIMARY KEY DEFAULT extensions.uuid_generate_v4() NOT NULL,
	"campaign_id" uuid,
	"user_id" uuid,
	"action" text NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "user_campaign_interactions_action_check" CHECK (action = ANY (ARRAY['sent'::text, 'delivered'::text, 'opened'::text, 'clicked'::text, 'converted'::text, 'unsubscribed'::text, 'bounced'::text]))
);
--> statement-breakpoint
CREATE TABLE "user_marketing_preferences" (
	"id" uuid PRIMARY KEY DEFAULT extensions.uuid_generate_v4() NOT NULL,
	"user_id" uuid,
	"email_enabled" boolean DEFAULT true,
	"push_enabled" boolean DEFAULT true,
	"sms_enabled" boolean DEFAULT false,
	"frequency_preference" text DEFAULT 'normal',
	"unsubscribed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "user_marketing_preferences_user_id_key" UNIQUE("user_id"),
	CONSTRAINT "user_marketing_preferences_frequency_preference_check" CHECK (frequency_preference = ANY (ARRAY['high'::text, 'normal'::text, 'low'::text]))
);
--> statement-breakpoint
CREATE TABLE "user_reports" (
	"id" uuid PRIMARY KEY DEFAULT extensions.uuid_generate_v4() NOT NULL,
	"reporter_id" uuid,
	"reported_user_id" uuid,
	"report_type" text NOT NULL,
	"reason" text,
	"evidence" jsonb,
	"status" text DEFAULT 'pending',
	"moderator_id" uuid,
	"moderator_notes" text,
	"action_taken" text,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	"resolved_at" timestamp with time zone,
	"message_id" uuid,
	"chat_id" uuid,
	"additional_details" text,
	CONSTRAINT "user_reports_report_type_check" CHECK (report_type = ANY (ARRAY['harassment'::text, 'spam'::text, 'inappropriate_content'::text, 'fake_profile'::text, 'underage'::text, 'other'::text])),
	CONSTRAINT "user_reports_status_check" CHECK (status = ANY (ARRAY['pending'::text, 'reviewing'::text, 'resolved'::text, 'dismissed'::text]))
);
--> statement-breakpoint
ALTER TABLE "user_reports" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "user_matches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user1_id" uuid NOT NULL,
	"user2_id" uuid NOT NULL,
	"match_type" varchar(50) DEFAULT 'regular',
	"matched_at" timestamp DEFAULT CURRENT_TIMESTAMP,
	"created_via" varchar(50) DEFAULT 'matchmaking',
	CONSTRAINT "user_matches_user1_id_user2_id_key" UNIQUE("user1_id","user2_id")
);
--> statement-breakpoint
CREATE TABLE "subscription_transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"order_id" varchar(100),
	"amount" numeric(10, 2) NOT NULL,
	"currency" varchar(3) DEFAULT 'INR',
	"status" varchar(20) NOT NULL,
	"payment_method" varchar(50),
	"gateway" varchar(20) DEFAULT 'cashfree',
	"gateway_transaction_id" varchar(100),
	"description" text,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "system_settings" (
	"key" text PRIMARY KEY DEFAULT 'default' NOT NULL,
	"value" jsonb,
	"description" text,
	"category" text,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now(),
	"auto_moderation" boolean DEFAULT true,
	"profanity_filter" boolean DEFAULT true,
	"image_moderation" boolean DEFAULT true,
	"require_email_verification" boolean DEFAULT true,
	"maintenance_mode" boolean DEFAULT false,
	"registration_enabled" boolean DEFAULT true,
	"matchmaking_enabled" boolean DEFAULT true,
	"chat_enabled" boolean DEFAULT true,
	"max_file_size" integer DEFAULT 10,
	"max_messages_per_day" integer DEFAULT 1000,
	"max_friends_per_user" integer DEFAULT 500,
	"session_timeout" integer DEFAULT 30,
	"max_login_attempts" integer DEFAULT 5,
	CONSTRAINT "system_settings_key_unique" UNIQUE("key")
);
--> statement-breakpoint
ALTER TABLE "system_settings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "referral_payment_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"upi_id" varchar(100) NOT NULL,
	"amount" numeric(10, 2) NOT NULL,
	"status" varchar(20) DEFAULT 'pending',
	"request_date" timestamp with time zone DEFAULT now(),
	"processed_date" timestamp with time zone,
	"processed_by" uuid,
	"payment_reference" varchar(100),
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "referral_payment_requests_status_check" CHECK ((status)::text = ANY (ARRAY[('pending'::character varying)::text, ('processing'::character varying)::text, ('completed'::character varying)::text, ('failed'::character varying)::text]))
);
--> statement-breakpoint
CREATE TABLE "refunds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"subscription_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"amount" numeric(10, 2) NOT NULL,
	"currency" varchar(3) DEFAULT 'USD' NOT NULL,
	"reason" text,
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"processed_by" uuid,
	"payment_provider" varchar(50),
	"external_refund_id" varchar(255),
	"refund_method" varchar(50) DEFAULT 'original_payment_method',
	"admin_notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "refunds_status_check" CHECK ((status)::text = ANY (ARRAY[('pending'::character varying)::text, ('approved'::character varying)::text, ('rejected'::character varying)::text, ('processed'::character varying)::text, ('failed'::character varying)::text]))
);
--> statement-breakpoint
CREATE TABLE "user_profile_visits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"visitor_id" uuid NOT NULL,
	"visited_user_id" uuid NOT NULL,
	"visit_count" integer DEFAULT 1,
	"first_visit_at" timestamp DEFAULT CURRENT_TIMESTAMP,
	"last_visit_at" timestamp DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT "user_profile_visits_visitor_id_visited_user_id_key" UNIQUE("visitor_id","visited_user_id")
);
--> statement-breakpoint
CREATE TABLE "voice_call_participants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"call_id" text NOT NULL,
	"user_id" uuid NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now(),
	"left_at" timestamp with time zone,
	"role" text DEFAULT 'participant' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "voice_call_participants_role_check" CHECK (role = ANY (ARRAY['caller'::text, 'receiver'::text, 'participant'::text]))
);
--> statement-breakpoint
CREATE TABLE "user_sessions" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"session_id" varchar(100) NOT NULL,
	"user_id" uuid,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"duration_seconds" integer,
	"platform" varchar(20) NOT NULL,
	"app_version" varchar(20) NOT NULL,
	"device_id" varchar(100),
	"device_name" varchar(200),
	"screen_views" integer DEFAULT 0,
	"events_count" integer DEFAULT 0,
	"crashes_count" integer DEFAULT 0,
	"country" varchar(2),
	"city" varchar(100),
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "user_sessions_session_id_key" UNIQUE("session_id")
);
--> statement-breakpoint
ALTER TABLE "user_sessions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "verification_attempts" (
	"id" uuid PRIMARY KEY DEFAULT extensions.uuid_generate_v4() NOT NULL,
	"user_id" uuid NOT NULL,
	"verification_id" uuid,
	"success" boolean NOT NULL,
	"failure_reason" text,
	"ip_address" "inet",
	"user_agent" text,
	"device_info" jsonb,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "voice_calls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"call_id" text NOT NULL,
	"caller_id" uuid NOT NULL,
	"receiver_id" uuid NOT NULL,
	"call_type" text DEFAULT 'webrtc' NOT NULL,
	"status" text DEFAULT 'initiated' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now(),
	"connected_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"duration_seconds" integer DEFAULT 0,
	"end_reason" text,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "voice_calls_call_id_key" UNIQUE("call_id"),
	CONSTRAINT "voice_calls_call_type_check" CHECK (call_type = ANY (ARRAY['webrtc'::text, 'audio-fallback'::text])),
	CONSTRAINT "voice_calls_end_reason_check" CHECK (end_reason = ANY (ARRAY['completed'::text, 'declined'::text, 'missed'::text, 'disconnected'::text, 'error'::text])),
	CONSTRAINT "voice_calls_status_check" CHECK (status = ANY (ARRAY['initiated'::text, 'ringing'::text, 'connected'::text, 'ended'::text, 'declined'::text, 'missed'::text]))
);
--> statement-breakpoint
CREATE TABLE "user_subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"plan_type" varchar(20) NOT NULL,
	"status" varchar(20) DEFAULT 'active',
	"started_at" timestamp with time zone DEFAULT now(),
	"expires_at" timestamp with time zone NOT NULL,
	"cancelled_at" timestamp with time zone,
	"payment_gateway" varchar(20) DEFAULT 'cashfree',
	"gateway_subscription_id" varchar(100),
	"amount" numeric(10, 2),
	"currency" varchar(3) DEFAULT 'INR',
	"auto_renew" boolean DEFAULT false,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "unique_active_subscription" UNIQUE("user_id","status")
);
--> statement-breakpoint
CREATE TABLE "blind_date_blocked_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"blind_date_id" uuid NOT NULL,
	"sender_id" uuid NOT NULL,
	"original_message" text NOT NULL,
	"filtered_message" text,
	"blocked_reason" text,
	"detection_confidence" numeric(3, 2),
	"ai_analysis" jsonb,
	"was_released" boolean DEFAULT false,
	"released_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "matchmaking_proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"a" uuid NOT NULL,
	"b" uuid NOT NULL,
	"status" varchar(20) DEFAULT 'pending',
	"type" varchar(50) DEFAULT 'regular',
	"matched_at" timestamp,
	"created_at" timestamp DEFAULT CURRENT_TIMESTAMP,
	"action_source" text DEFAULT 'match_tab',
	CONSTRAINT "matchmaking_proposals_action_source_check" CHECK (action_source = ANY (ARRAY['match_tab'::text, 'explore_tab'::text, 'profile_view'::text]))
);
--> statement-breakpoint
CREATE TABLE "user_segments" (
	"id" uuid PRIMARY KEY DEFAULT extensions.uuid_generate_v4() NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"criteria" jsonb NOT NULL,
	"user_count" integer DEFAULT 0,
	"last_calculated_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "help_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"receiver_user_id" uuid NOT NULL,
	"prompt" text NOT NULL,
	"prompt_embedding" vector(1536),
	"status" varchar(20) DEFAULT 'searching',
	"matched_giver_id" uuid,
	"chat_room_id" uuid,
	"attempts_count" integer DEFAULT 0,
	"declined_giver_ids" uuid[],
	"created_at" timestamp with time zone DEFAULT now(),
	"expires_at" timestamp with time zone DEFAULT (now() + '01:00:00'::interval),
	"matched_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "help_requests_status_check" CHECK ((status)::text = ANY (ARRAY[('searching'::character varying)::text, ('matched'::character varying)::text, ('declined_all'::character varying)::text, ('completed'::character varying)::text, ('cancelled'::character varying)::text, ('expired'::character varying)::text]))
);
--> statement-breakpoint
ALTER TABLE "help_requests" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "chat_members" (
	"chat_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_members_pkey" PRIMARY KEY("chat_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "activity_feed" ADD CONSTRAINT "activity_feed_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_audit_logs" ADD CONSTRAINT "admin_audit_logs_admin_id_fkey" FOREIGN KEY ("admin_id") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analytics_events" ADD CONSTRAINT "analytics_events_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_roles" ADD CONSTRAINT "admin_roles_granted_by_fkey" FOREIGN KEY ("granted_by") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_roles" ADD CONSTRAINT "admin_roles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_conversations" ADD CONSTRAINT "ai_conversations_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "friendships" ADD CONSTRAINT "fk_friendships_user1" FOREIGN KEY ("user1_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "friendships" ADD CONSTRAINT "fk_friendships_user2" FOREIGN KEY ("user2_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "friendships" ADD CONSTRAINT "friendships_sender_id_fkey" FOREIGN KEY ("sender_id") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "giver_request_attempts" ADD CONSTRAINT "giver_request_attempts_giver_user_id_fkey" FOREIGN KEY ("giver_user_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "giver_request_attempts" ADD CONSTRAINT "giver_request_attempts_help_request_id_fkey" FOREIGN KEY ("help_request_id") REFERENCES "public"."help_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profiles" ADD CONSTRAINT "profiles_deleted_by_fkey" FOREIGN KEY ("deleted_by") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profiles" ADD CONSTRAINT "profiles_suspended_by_fkey" FOREIGN KEY ("suspended_by") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_versions" ADD CONSTRAINT "app_versions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crash_reports" ADD CONSTRAINT "crash_reports_resolved_by_fkey" FOREIGN KEY ("resolved_by") REFERENCES "public"."profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crash_reports" ADD CONSTRAINT "crash_reports_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "blind_date_daily_queue" ADD CONSTRAINT "blind_date_daily_queue_match_id_fkey" FOREIGN KEY ("match_id") REFERENCES "public"."blind_date_matches"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "blind_date_daily_queue" ADD CONSTRAINT "blind_date_daily_queue_matched_user_id_fkey" FOREIGN KEY ("matched_user_id") REFERENCES "public"."profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "blind_date_daily_queue" ADD CONSTRAINT "blind_date_daily_queue_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daily_match_limits" ADD CONSTRAINT "daily_match_limits_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "blind_dating_settings" ADD CONSTRAINT "blind_dating_settings_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_user_settings" ADD CONSTRAINT "chat_user_settings_chat_id_fkey" FOREIGN KEY ("chat_id") REFERENCES "public"."chats"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_user_settings" ADD CONSTRAINT "chat_user_settings_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_analytics" ADD CONSTRAINT "campaign_analytics_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "public"."marketing_campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "escalation_logs" ADD CONSTRAINT "escalation_logs_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "public"."ai_conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "escalation_logs" ADD CONSTRAINT "escalation_logs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "blind_date_matches" ADD CONSTRAINT "blind_date_matches_chat_id_fkey" FOREIGN KEY ("chat_id") REFERENCES "public"."chats"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "blind_date_matches" ADD CONSTRAINT "blind_date_matches_ended_by_fkey" FOREIGN KEY ("ended_by") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "blind_date_matches" ADD CONSTRAINT "blind_date_matches_reveal_requested_by_fkey" FOREIGN KEY ("reveal_requested_by") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "blind_date_matches" ADD CONSTRAINT "blind_date_matches_user_a_fkey" FOREIGN KEY ("user_a") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "blind_date_matches" ADD CONSTRAINT "blind_date_matches_user_b_fkey" FOREIGN KEY ("user_b") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_deletions" ADD CONSTRAINT "chat_deletions_chat_id_fkey" FOREIGN KEY ("chat_id") REFERENCES "public"."chats"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_deletions" ADD CONSTRAINT "chat_deletions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_templates" ADD CONSTRAINT "email_templates_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feature_usage" ADD CONSTRAINT "feature_usage_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "giver_profiles" ADD CONSTRAINT "giver_profiles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "follow_up_tasks" ADD CONSTRAINT "follow_up_tasks_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "public"."ai_conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "follow_up_tasks" ADD CONSTRAINT "follow_up_tasks_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback_analysis" ADD CONSTRAINT "feedback_analysis_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "public"."ai_conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "friend_location_notifications" ADD CONSTRAINT "friend_location_notifications_from_user_id_fkey" FOREIGN KEY ("from_user_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "friend_location_notifications" ADD CONSTRAINT "friend_location_notifications_to_user_id_fkey" FOREIGN KEY ("to_user_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "marketing_campaigns" ADD CONSTRAINT "marketing_campaigns_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "help_session_feedback" ADD CONSTRAINT "help_session_feedback_chat_room_id_fkey" FOREIGN KEY ("chat_room_id") REFERENCES "public"."chats"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "help_session_feedback" ADD CONSTRAINT "help_session_feedback_giver_user_id_fkey" FOREIGN KEY ("giver_user_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "help_session_feedback" ADD CONSTRAINT "help_session_feedback_help_request_id_fkey" FOREIGN KEY ("help_request_id") REFERENCES "public"."help_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "help_session_feedback" ADD CONSTRAINT "help_session_feedback_receiver_user_id_fkey" FOREIGN KEY ("receiver_user_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_reactions" ADD CONSTRAINT "message_reactions_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feature_flags" ADD CONSTRAINT "feature_flags_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "explore_interactions" ADD CONSTRAINT "explore_interactions_target_user_id_fkey" FOREIGN KEY ("target_user_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "explore_interactions" ADD CONSTRAINT "explore_interactions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "face_verifications" ADD CONSTRAINT "face_verifications_reviewed_by_fkey" FOREIGN KEY ("reviewed_by") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "face_verifications" ADD CONSTRAINT "face_verifications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "marketing_automation_rules" ADD CONSTRAINT "marketing_automation_rules_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referral_transactions" ADD CONSTRAINT "referral_transactions_referred_user_id_fkey" FOREIGN KEY ("referred_user_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referral_transactions" ADD CONSTRAINT "referral_transactions_referrer_user_id_fkey" FOREIGN KEY ("referrer_user_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referral_transactions" ADD CONSTRAINT "referral_transactions_verified_by_fkey" FOREIGN KEY ("verified_by") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promotional_subscriptions" ADD CONSTRAINT "promotional_subscriptions_subscription_id_fkey" FOREIGN KEY ("subscription_id") REFERENCES "public"."user_subscriptions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promotional_subscriptions" ADD CONSTRAINT "promotional_subscriptions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_orders" ADD CONSTRAINT "payment_orders_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proactive_alerts" ADD CONSTRAINT "proactive_alerts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_receipts" ADD CONSTRAINT "message_receipts_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referral_code_attempts" ADD CONSTRAINT "referral_code_attempts_attempted_by_user_id_fkey" FOREIGN KEY ("attempted_by_user_id") REFERENCES "public"."profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "satisfaction_ratings" ADD CONSTRAINT "satisfaction_ratings_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "public"."ai_conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "satisfaction_ratings" ADD CONSTRAINT "satisfaction_ratings_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_referrals" ADD CONSTRAINT "user_referrals_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_activity_events" ADD CONSTRAINT "user_activity_events_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_chat_id_fkey" FOREIGN KEY ("chat_id") REFERENCES "public"."chats"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_reply_to_id_fkey" FOREIGN KEY ("reply_to_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_recipient_id_fkey" FOREIGN KEY ("recipient_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_sender_id_fkey" FOREIGN KEY ("sender_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_views" ADD CONSTRAINT "message_views_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nearby_notifications" ADD CONSTRAINT "nearby_notifications_from_user_id_fkey" FOREIGN KEY ("from_user_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nearby_notifications" ADD CONSTRAINT "nearby_notifications_to_user_id_fkey" FOREIGN KEY ("to_user_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_templates" ADD CONSTRAINT "notification_templates_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_tokens" ADD CONSTRAINT "push_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "satisfaction_surveys" ADD CONSTRAINT "satisfaction_surveys_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "public"."ai_conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "survey_responses" ADD CONSTRAINT "survey_responses_survey_id_fkey" FOREIGN KEY ("survey_id") REFERENCES "public"."satisfaction_surveys"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_photos" ADD CONSTRAINT "user_photos_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_consent" ADD CONSTRAINT "user_consent_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_activities" ADD CONSTRAINT "user_activities_related_user_id_fkey" FOREIGN KEY ("related_user_id") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_activities" ADD CONSTRAINT "user_activities_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_campaign_interactions" ADD CONSTRAINT "user_campaign_interactions_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "public"."marketing_campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_campaign_interactions" ADD CONSTRAINT "user_campaign_interactions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_marketing_preferences" ADD CONSTRAINT "user_marketing_preferences_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_reports" ADD CONSTRAINT "user_reports_chat_id_fkey" FOREIGN KEY ("chat_id") REFERENCES "public"."chats"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_reports" ADD CONSTRAINT "user_reports_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_reports" ADD CONSTRAINT "user_reports_moderator_id_fkey" FOREIGN KEY ("moderator_id") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_reports" ADD CONSTRAINT "user_reports_reported_user_id_fkey" FOREIGN KEY ("reported_user_id") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_reports" ADD CONSTRAINT "user_reports_reporter_id_fkey" FOREIGN KEY ("reporter_id") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_matches" ADD CONSTRAINT "user_matches_user1_id_fkey" FOREIGN KEY ("user1_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_matches" ADD CONSTRAINT "user_matches_user2_id_fkey" FOREIGN KEY ("user2_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_transactions" ADD CONSTRAINT "subscription_transactions_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "public"."payment_orders"("order_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_transactions" ADD CONSTRAINT "subscription_transactions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "system_settings" ADD CONSTRAINT "system_settings_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referral_payment_requests" ADD CONSTRAINT "referral_payment_requests_processed_by_fkey" FOREIGN KEY ("processed_by") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referral_payment_requests" ADD CONSTRAINT "referral_payment_requests_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_processed_by_fkey" FOREIGN KEY ("processed_by") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_subscription_id_fkey" FOREIGN KEY ("subscription_id") REFERENCES "public"."subscriptions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_profile_visits" ADD CONSTRAINT "user_profile_visits_visited_user_id_fkey" FOREIGN KEY ("visited_user_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_profile_visits" ADD CONSTRAINT "user_profile_visits_visitor_id_fkey" FOREIGN KEY ("visitor_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voice_call_participants" ADD CONSTRAINT "voice_call_participants_call_id_fkey" FOREIGN KEY ("call_id") REFERENCES "public"."voice_calls"("call_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voice_call_participants" ADD CONSTRAINT "voice_call_participants_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_sessions" ADD CONSTRAINT "user_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verification_attempts" ADD CONSTRAINT "verification_attempts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verification_attempts" ADD CONSTRAINT "verification_attempts_verification_id_fkey" FOREIGN KEY ("verification_id") REFERENCES "public"."face_verifications"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voice_calls" ADD CONSTRAINT "voice_calls_caller_id_fkey" FOREIGN KEY ("caller_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voice_calls" ADD CONSTRAINT "voice_calls_receiver_id_fkey" FOREIGN KEY ("receiver_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_subscriptions" ADD CONSTRAINT "user_subscriptions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "blind_date_blocked_messages" ADD CONSTRAINT "blind_date_blocked_messages_blind_date_id_fkey" FOREIGN KEY ("blind_date_id") REFERENCES "public"."blind_date_matches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "blind_date_blocked_messages" ADD CONSTRAINT "blind_date_blocked_messages_sender_id_fkey" FOREIGN KEY ("sender_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "matchmaking_proposals" ADD CONSTRAINT "matchmaking_proposals_a_fkey" FOREIGN KEY ("a") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "matchmaking_proposals" ADD CONSTRAINT "matchmaking_proposals_b_fkey" FOREIGN KEY ("b") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_segments" ADD CONSTRAINT "user_segments_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "help_requests" ADD CONSTRAINT "help_requests_chat_room_id_fkey" FOREIGN KEY ("chat_room_id") REFERENCES "public"."chats"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "help_requests" ADD CONSTRAINT "help_requests_matched_giver_id_fkey" FOREIGN KEY ("matched_giver_id") REFERENCES "public"."profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "help_requests" ADD CONSTRAINT "help_requests_receiver_user_id_fkey" FOREIGN KEY ("receiver_user_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_members" ADD CONSTRAINT "chat_members_chat_id_fkey" FOREIGN KEY ("chat_id") REFERENCES "public"."chats"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_activity_feed_timestamp" ON "activity_feed" USING btree ("timestamp" timestamptz_ops);--> statement-breakpoint
CREATE INDEX "idx_activity_feed_type" ON "activity_feed" USING btree ("type" text_ops);--> statement-breakpoint
CREATE INDEX "idx_activity_feed_user_id" ON "activity_feed" USING btree ("user_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_audit_logs_action" ON "admin_audit_logs" USING btree ("action" text_ops);--> statement-breakpoint
CREATE INDEX "idx_audit_logs_admin_id" ON "admin_audit_logs" USING btree ("admin_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_audit_logs_created_at" ON "admin_audit_logs" USING btree ("created_at" timestamptz_ops);--> statement-breakpoint
CREATE INDEX "idx_audit_logs_target_type" ON "admin_audit_logs" USING btree ("target_type" text_ops);--> statement-breakpoint
CREATE INDEX "idx_analytics_events_created_at" ON "analytics_events" USING btree ("created_at" timestamptz_ops);--> statement-breakpoint
CREATE INDEX "idx_analytics_events_event_name" ON "analytics_events" USING btree ("event_name" text_ops);--> statement-breakpoint
CREATE INDEX "idx_analytics_events_properties" ON "analytics_events" USING gin ("properties" jsonb_ops);--> statement-breakpoint
CREATE INDEX "idx_analytics_events_session_id" ON "analytics_events" USING btree ("session_id" text_ops);--> statement-breakpoint
CREATE INDEX "idx_analytics_events_timestamp" ON "analytics_events" USING btree ("timestamp" timestamptz_ops);--> statement-breakpoint
CREATE INDEX "idx_analytics_events_user_id" ON "analytics_events" USING btree ("user_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_admin_roles_active" ON "admin_roles" USING btree ("is_active" bool_ops);--> statement-breakpoint
CREATE INDEX "idx_admin_roles_role" ON "admin_roles" USING btree ("role" text_ops);--> statement-breakpoint
CREATE INDEX "idx_admin_roles_user_id" ON "admin_roles" USING btree ("user_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_ai_conversations_created_at" ON "ai_conversations" USING btree ("created_at" timestamptz_ops);--> statement-breakpoint
CREATE INDEX "idx_ai_conversations_detected_language" ON "ai_conversations" USING btree ("detected_language" text_ops);--> statement-breakpoint
CREATE INDEX "idx_ai_conversations_escalation_level" ON "ai_conversations" USING btree ("escalation_level" text_ops);--> statement-breakpoint
CREATE INDEX "idx_ai_conversations_intent" ON "ai_conversations" USING btree ("intent" text_ops);--> statement-breakpoint
CREATE INDEX "idx_ai_conversations_satisfaction_rating" ON "ai_conversations" USING btree ("satisfaction_rating" int4_ops);--> statement-breakpoint
CREATE INDEX "idx_ai_conversations_session_id" ON "ai_conversations" USING btree ("session_id" text_ops);--> statement-breakpoint
CREATE INDEX "idx_ai_conversations_status" ON "ai_conversations" USING btree ("status" text_ops);--> statement-breakpoint
CREATE INDEX "idx_ai_conversations_user_id" ON "ai_conversations" USING btree ("user_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_friendships_created_at" ON "friendships" USING btree ("created_at" timestamptz_ops);--> statement-breakpoint
CREATE INDEX "idx_friendships_sender" ON "friendships" USING btree ("sender_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_friendships_status" ON "friendships" USING btree ("status" text_ops);--> statement-breakpoint
CREATE INDEX "idx_friendships_status_active" ON "friendships" USING btree ("status" text_ops) WHERE ((status)::text = 'active'::text);--> statement-breakpoint
CREATE INDEX "idx_friendships_user1_status" ON "friendships" USING btree ("user1_id" uuid_ops,"status" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_friendships_user2_status" ON "friendships" USING btree ("user2_id" text_ops,"status" text_ops);--> statement-breakpoint
CREATE INDEX "idx_friendships_users_status" ON "friendships" USING btree ("user1_id" uuid_ops,"user2_id" text_ops,"status" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_app_version_config_platform" ON "app_version_config" USING btree ("platform" text_ops);--> statement-breakpoint
CREATE INDEX "idx_giver_attempts_created" ON "giver_request_attempts" USING btree ("created_at" timestamptz_ops);--> statement-breakpoint
CREATE INDEX "idx_giver_attempts_giver" ON "giver_request_attempts" USING btree ("giver_user_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_giver_attempts_help_request" ON "giver_request_attempts" USING btree ("help_request_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_giver_attempts_request" ON "giver_request_attempts" USING btree ("help_request_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_giver_attempts_request_status" ON "giver_request_attempts" USING btree ("help_request_id" uuid_ops,"status" text_ops);--> statement-breakpoint
CREATE INDEX "idx_giver_attempts_status" ON "giver_request_attempts" USING btree ("status" text_ops);--> statement-breakpoint
CREATE INDEX "idx_profiles_about_search" ON "profiles" USING gin (to_tsvector('english'::regconfig, about) tsvector_ops) WHERE ((about IS NOT NULL) AND (length(about) > 0));--> statement-breakpoint
CREATE INDEX "idx_profiles_age" ON "profiles" USING btree ("age" int4_ops) WHERE (age IS NOT NULL);--> statement-breakpoint
CREATE INDEX "idx_profiles_age_preference" ON "profiles" USING btree ("age_preference" text_ops);--> statement-breakpoint
CREATE INDEX "idx_profiles_circle_points" ON "profiles" USING btree ("circle_points" int4_ops);--> statement-breakpoint
CREATE INDEX "idx_profiles_created_at" ON "profiles" USING btree ("created_at" timestamptz_ops);--> statement-breakpoint
CREATE INDEX "idx_profiles_deleted_at" ON "profiles" USING btree ("deleted_at" timestamptz_ops);--> statement-breakpoint
CREATE INDEX "idx_profiles_email" ON "profiles" USING btree ("email" text_ops);--> statement-breakpoint
CREATE INDEX "idx_profiles_email_ilike" ON "profiles" USING btree ("email" text_pattern_ops);--> statement-breakpoint
CREATE INDEX "idx_profiles_explore_filter" ON "profiles" USING btree ("id" timestamptz_ops,"first_name" timestamptz_ops,"last_name" timestamptz_ops,"updated_at" timestamptz_ops) WHERE ((first_name IS NOT NULL) AND (last_name IS NOT NULL));--> statement-breakpoint
CREATE INDEX "idx_profiles_first_name" ON "profiles" USING btree ("first_name" text_ops);--> statement-breakpoint
CREATE INDEX "idx_profiles_first_name_ilike" ON "profiles" USING btree ("first_name" text_pattern_ops);--> statement-breakpoint
CREATE INDEX "idx_profiles_friendship_location_priority" ON "profiles" USING btree ("friendship_location_priority" bool_ops);--> statement-breakpoint
CREATE INDEX "idx_profiles_fulltext_search" ON "profiles" USING gin (to_tsvector('english'::regconfig, ((((((COALESCE(first_name, '' tsvector_ops);--> statement-breakpoint
CREATE INDEX "idx_profiles_gender" ON "profiles" USING btree ("gender" text_ops) WHERE (gender IS NOT NULL);--> statement-breakpoint
CREATE INDEX "idx_profiles_instagram_username" ON "profiles" USING btree ("instagram_username" text_ops) WHERE (instagram_username IS NOT NULL);--> statement-breakpoint
CREATE INDEX "idx_profiles_interests_gin" ON "profiles" USING gin ("interests" array_ops);--> statement-breakpoint
CREATE INDEX "idx_profiles_invisible_mode" ON "profiles" USING btree ("invisible_mode" bool_ops) WHERE (invisible_mode = false);--> statement-breakpoint
CREATE INDEX "idx_profiles_is_deleted" ON "profiles" USING btree ("is_deleted" bool_ops);--> statement-breakpoint
CREATE INDEX "idx_profiles_is_suspended" ON "profiles" USING btree ("is_suspended" bool_ops);--> statement-breakpoint
CREATE INDEX "idx_profiles_last_active" ON "profiles" USING btree ("last_active" timestamp_ops);--> statement-breakpoint
CREATE INDEX "idx_profiles_last_name" ON "profiles" USING btree ("last_name" text_ops);--> statement-breakpoint
CREATE INDEX "idx_profiles_last_name_ilike" ON "profiles" USING btree ("last_name" text_pattern_ops);--> statement-breakpoint
CREATE INDEX "idx_profiles_last_seen" ON "profiles" USING btree ("last_seen" timestamptz_ops);--> statement-breakpoint
CREATE INDEX "idx_profiles_location" ON "profiles" USING btree ("latitude" numeric_ops,"longitude" numeric_ops);--> statement-breakpoint
CREATE INDEX "idx_profiles_location_preference" ON "profiles" USING btree ("location_preference" text_ops);--> statement-breakpoint
CREATE INDEX "idx_profiles_location_updated" ON "profiles" USING btree ("location_updated_at" timestamptz_ops);--> statement-breakpoint
CREATE INDEX "idx_profiles_needs_gin" ON "profiles" USING gin ("needs" array_ops);--> statement-breakpoint
CREATE INDEX "idx_profiles_recent_users" ON "profiles" USING btree ("created_at" text_ops,"first_name" text_ops,"last_name" text_ops) WHERE ((first_name IS NOT NULL) AND (last_name IS NOT NULL));--> statement-breakpoint
CREATE INDEX "idx_profiles_relationship_distance_flexible" ON "profiles" USING btree ("relationship_distance_flexible" bool_ops);--> statement-breakpoint
CREATE INDEX "idx_profiles_updated_at" ON "profiles" USING btree ("updated_at" timestamptz_ops);--> statement-breakpoint
CREATE INDEX "idx_profiles_username" ON "profiles" USING btree ("username" text_ops);--> statement-breakpoint
CREATE INDEX "idx_profiles_username_ilike" ON "profiles" USING btree ("username" text_pattern_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "idx_profiles_username_unique_ci" ON "profiles" USING btree (lower(username) text_ops);--> statement-breakpoint
CREATE INDEX "idx_profiles_verification_status" ON "profiles" USING btree ("verification_status" enum_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "ux_profiles_email_lower" ON "profiles" USING btree (lower(email) text_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "ux_profiles_username_lower" ON "profiles" USING btree (lower(username) text_ops);--> statement-breakpoint
CREATE INDEX "idx_announcements_active_window" ON "announcements" USING btree ("is_active" timestamptz_ops,"starts_at" timestamptz_ops,"ends_at" timestamptz_ops);--> statement-breakpoint
CREATE INDEX "idx_announcements_priority" ON "announcements" USING btree ("priority" int4_ops,"published_at" int4_ops,"created_at" int4_ops);--> statement-breakpoint
CREATE INDEX "idx_app_versions_created_at" ON "app_versions" USING btree ("created_at" timestamptz_ops);--> statement-breakpoint
CREATE INDEX "idx_app_versions_device_id" ON "app_versions" USING btree ("device_id" text_ops);--> statement-breakpoint
CREATE INDEX "idx_app_versions_platform" ON "app_versions" USING btree ("platform" text_ops);--> statement-breakpoint
CREATE INDEX "idx_app_versions_user_id" ON "app_versions" USING btree ("user_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_app_versions_version" ON "app_versions" USING btree ("version" text_ops);--> statement-breakpoint
CREATE INDEX "idx_app_versions_version_platform" ON "app_versions" USING btree ("version" text_ops,"platform" text_ops);--> statement-breakpoint
CREATE INDEX "idx_crash_reports_app_version" ON "crash_reports" USING btree ("app_version" text_ops);--> statement-breakpoint
CREATE INDEX "idx_crash_reports_breadcrumbs" ON "crash_reports" USING gin ("breadcrumbs" jsonb_ops);--> statement-breakpoint
CREATE INDEX "idx_crash_reports_crash_id" ON "crash_reports" USING btree ("crash_id" text_ops);--> statement-breakpoint
CREATE INDEX "idx_crash_reports_created_at" ON "crash_reports" USING btree ("created_at" timestamptz_ops);--> statement-breakpoint
CREATE INDEX "idx_crash_reports_device_platform" ON "crash_reports" USING btree ("device_platform" text_ops);--> statement-breakpoint
CREATE INDEX "idx_crash_reports_is_fatal" ON "crash_reports" USING btree ("is_fatal" bool_ops);--> statement-breakpoint
CREATE INDEX "idx_crash_reports_resolved" ON "crash_reports" USING btree ("resolved" bool_ops);--> statement-breakpoint
CREATE INDEX "idx_crash_reports_session_id" ON "crash_reports" USING btree ("session_id" text_ops);--> statement-breakpoint
CREATE INDEX "idx_crash_reports_timestamp" ON "crash_reports" USING btree ("timestamp" timestamptz_ops);--> statement-breakpoint
CREATE INDEX "idx_crash_reports_type" ON "crash_reports" USING btree ("type" text_ops);--> statement-breakpoint
CREATE INDEX "idx_crash_reports_user_context" ON "crash_reports" USING gin ("user_context" jsonb_ops);--> statement-breakpoint
CREATE INDEX "idx_crash_reports_user_id" ON "crash_reports" USING btree ("user_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_blind_date_daily_queue_date" ON "blind_date_daily_queue" USING btree ("scheduled_date" date_ops,"status" date_ops);--> statement-breakpoint
CREATE INDEX "idx_blind_date_daily_queue_user" ON "blind_date_daily_queue" USING btree ("user_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_daily_match_limits_user_date" ON "daily_match_limits" USING btree ("user_id" date_ops,"date" date_ops);--> statement-breakpoint
CREATE INDEX "idx_blind_dating_settings_enabled" ON "blind_dating_settings" USING btree ("is_enabled" bool_ops) WHERE (is_enabled = true);--> statement-breakpoint
CREATE INDEX "idx_blind_dating_settings_user" ON "blind_dating_settings" USING btree ("user_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_chat_mute_settings_chat_id" ON "chat_mute_settings" USING btree ("chat_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_chat_mute_settings_user_chat" ON "chat_mute_settings" USING btree ("user_id" uuid_ops,"chat_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_chat_mute_settings_user_id" ON "chat_mute_settings" USING btree ("user_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_chat_user_settings_chat" ON "chat_user_settings" USING btree ("chat_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_chat_user_settings_user" ON "chat_user_settings" USING btree ("user_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_chat_user_settings_user_archived" ON "chat_user_settings" USING btree ("user_id" bool_ops,"archived" bool_ops);--> statement-breakpoint
CREATE INDEX "idx_chat_user_settings_user_pinned" ON "chat_user_settings" USING btree ("user_id" bool_ops,"pinned" bool_ops);--> statement-breakpoint
CREATE INDEX "idx_campaign_analytics_campaign_id" ON "campaign_analytics" USING btree ("campaign_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_email_otps_email" ON "email_otps" USING btree ("email" text_ops);--> statement-breakpoint
CREATE INDEX "idx_email_otps_expires_at" ON "email_otps" USING btree ("expires_at" timestamptz_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "idx_email_otps_unique_active" ON "email_otps" USING btree ("email" text_ops) WHERE (verified = false);--> statement-breakpoint
CREATE INDEX "idx_email_otps_verified" ON "email_otps" USING btree ("verified" bool_ops);--> statement-breakpoint
CREATE INDEX "idx_email_otps_verified_at" ON "email_otps" USING btree ("verified_at" timestamptz_ops);--> statement-breakpoint
CREATE INDEX "idx_escalation_logs_conversation_id" ON "escalation_logs" USING btree ("conversation_id" text_ops);--> statement-breakpoint
CREATE INDEX "idx_escalation_logs_created_at" ON "escalation_logs" USING btree ("created_at" timestamptz_ops);--> statement-breakpoint
CREATE INDEX "idx_escalation_logs_priority" ON "escalation_logs" USING btree ("priority" text_ops);--> statement-breakpoint
CREATE INDEX "idx_escalation_logs_user_id" ON "escalation_logs" USING btree ("user_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_cache_stats_cache_key" ON "explore_cache_stats" USING btree ("cache_key" text_ops);--> statement-breakpoint
CREATE INDEX "idx_cache_stats_expires" ON "explore_cache_stats" USING btree ("expires_at" timestamp_ops);--> statement-breakpoint
CREATE INDEX "idx_cache_stats_user_endpoint" ON "explore_cache_stats" USING btree ("user_id" text_ops,"endpoint" text_ops);--> statement-breakpoint
CREATE INDEX "idx_beta_testers_applied_at" ON "beta_testers" USING btree ("applied_at" timestamptz_ops);--> statement-breakpoint
CREATE INDEX "idx_beta_testers_device_type" ON "beta_testers" USING btree ("device_type" text_ops);--> statement-breakpoint
CREATE INDEX "idx_beta_testers_email" ON "beta_testers" USING btree ("email" text_ops);--> statement-breakpoint
CREATE INDEX "idx_beta_testers_status" ON "beta_testers" USING btree ("status" text_ops);--> statement-breakpoint
CREATE INDEX "idx_blocks_blocked" ON "blocks" USING btree ("blocked_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_blocks_blocker" ON "blocks" USING btree ("blocker_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_blocks_both_users" ON "blocks" USING btree ("blocker_id" uuid_ops,"blocked_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_blind_date_matches_chat" ON "blind_date_matches" USING btree ("chat_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_blind_date_matches_status" ON "blind_date_matches" USING btree ("status" text_ops);--> statement-breakpoint
CREATE INDEX "idx_blind_date_matches_users" ON "blind_date_matches" USING btree ("user_a" uuid_ops,"user_b" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_chat_deletions_chat_id" ON "chat_deletions" USING btree ("chat_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_chat_deletions_deleted_at" ON "chat_deletions" USING btree ("deleted_at" timestamptz_ops);--> statement-breakpoint
CREATE INDEX "idx_chat_deletions_user_id" ON "chat_deletions" USING btree ("user_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_email_templates_category" ON "email_templates" USING btree ("category" text_ops);--> statement-breakpoint
CREATE INDEX "idx_email_templates_created_by" ON "email_templates" USING btree ("created_by" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_feature_usage_feature_name" ON "feature_usage" USING btree ("feature_name" text_ops);--> statement-breakpoint
CREATE INDEX "idx_feature_usage_last_used_at" ON "feature_usage" USING btree ("last_used_at" timestamptz_ops);--> statement-breakpoint
CREATE INDEX "idx_feature_usage_user_id" ON "feature_usage" USING btree ("user_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_giver_profiles_available" ON "giver_profiles" USING btree ("is_available" bool_ops) WHERE (is_available = true);--> statement-breakpoint
CREATE INDEX "idx_giver_profiles_categories" ON "giver_profiles" USING gin ("categories" array_ops);--> statement-breakpoint
CREATE INDEX "idx_giver_profiles_embedding" ON "giver_profiles" USING ivfflat ("profile_embedding" vector_cosine_ops) WITH (lists=100);--> statement-breakpoint
CREATE INDEX "idx_giver_profiles_skills" ON "giver_profiles" USING gin ("skills" array_ops);--> statement-breakpoint
CREATE INDEX "idx_giver_profiles_user_id" ON "giver_profiles" USING btree ("user_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_follow_up_tasks_scheduled_for" ON "follow_up_tasks" USING btree ("scheduled_for" timestamptz_ops);--> statement-breakpoint
CREATE INDEX "idx_follow_up_tasks_status" ON "follow_up_tasks" USING btree ("status" text_ops);--> statement-breakpoint
CREATE INDEX "idx_follow_up_tasks_user_id" ON "follow_up_tasks" USING btree ("user_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_friend_location_notifications_from_user" ON "friend_location_notifications" USING btree ("from_user_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_friend_location_notifications_sent_at" ON "friend_location_notifications" USING btree ("sent_at" timestamptz_ops);--> statement-breakpoint
CREATE INDEX "idx_friend_location_notifications_to_user" ON "friend_location_notifications" USING btree ("to_user_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_friend_location_notifications_user_pair" ON "friend_location_notifications" USING btree ("from_user_id" uuid_ops,"to_user_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_campaigns_created_by" ON "marketing_campaigns" USING btree ("created_by" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_campaigns_scheduled_at" ON "marketing_campaigns" USING btree ("scheduled_at" timestamptz_ops);--> statement-breakpoint
CREATE INDEX "idx_campaigns_status" ON "marketing_campaigns" USING btree ("status" text_ops);--> statement-breakpoint
CREATE INDEX "idx_campaigns_type" ON "marketing_campaigns" USING btree ("type" text_ops);--> statement-breakpoint
CREATE INDEX "idx_feedback_giver" ON "help_session_feedback" USING btree ("giver_user_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_feedback_receiver" ON "help_session_feedback" USING btree ("receiver_user_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_feature_flags_enabled" ON "feature_flags" USING btree ("enabled" bool_ops);--> statement-breakpoint
CREATE INDEX "idx_feature_flags_name" ON "feature_flags" USING btree ("name" text_ops);--> statement-breakpoint
CREATE INDEX "idx_matchmaking_history_created" ON "matchmaking_history" USING btree ("created_at" timestamptz_ops);--> statement-breakpoint
CREATE INDEX "idx_matchmaking_history_users" ON "matchmaking_history" USING btree ("user_a" uuid_ops,"user_b" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_explore_interactions_action_type" ON "explore_interactions" USING btree ("action_type" text_ops);--> statement-breakpoint
CREATE INDEX "idx_explore_interactions_created_at" ON "explore_interactions" USING btree ("created_at" timestamptz_ops);--> statement-breakpoint
CREATE INDEX "idx_explore_interactions_target_user_id" ON "explore_interactions" USING btree ("target_user_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_explore_interactions_user_id" ON "explore_interactions" USING btree ("user_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_explore_interactions_user_target" ON "explore_interactions" USING btree ("user_id" uuid_ops,"target_user_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_face_verifications_status" ON "face_verifications" USING btree ("status" enum_ops);--> statement-breakpoint
CREATE INDEX "idx_face_verifications_submitted_at" ON "face_verifications" USING btree ("submitted_at" timestamptz_ops);--> statement-breakpoint
CREATE INDEX "idx_face_verifications_user_id" ON "face_verifications" USING btree ("user_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_automation_rules_enabled" ON "marketing_automation_rules" USING btree ("enabled" bool_ops);--> statement-breakpoint
CREATE INDEX "idx_automation_rules_trigger_type" ON "marketing_automation_rules" USING btree ("trigger_type" text_ops);--> statement-breakpoint
CREATE INDEX "idx_referral_transactions_number" ON "referral_transactions" USING btree ("referral_number" text_ops);--> statement-breakpoint
CREATE INDEX "idx_referral_transactions_referred" ON "referral_transactions" USING btree ("referred_user_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_referral_transactions_referrer" ON "referral_transactions" USING btree ("referrer_user_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_referral_transactions_status" ON "referral_transactions" USING btree ("status" text_ops);--> statement-breakpoint
CREATE INDEX "idx_promotional_subscriptions_granted_at" ON "promotional_subscriptions" USING btree ("granted_at" timestamptz_ops);--> statement-breakpoint
CREATE INDEX "idx_promotional_subscriptions_promo_type" ON "promotional_subscriptions" USING btree ("promo_type" text_ops);--> statement-breakpoint
CREATE INDEX "idx_promotional_subscriptions_user_id" ON "promotional_subscriptions" USING btree ("user_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_payment_orders_created_at" ON "payment_orders" USING btree ("created_at" timestamptz_ops);--> statement-breakpoint
CREATE INDEX "idx_payment_orders_status" ON "payment_orders" USING btree ("status" text_ops);--> statement-breakpoint
CREATE INDEX "idx_payment_orders_user_id" ON "payment_orders" USING btree ("user_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_proactive_alerts_severity" ON "proactive_alerts" USING btree ("severity" text_ops);--> statement-breakpoint
CREATE INDEX "idx_proactive_alerts_status" ON "proactive_alerts" USING btree ("status" text_ops);--> statement-breakpoint
CREATE INDEX "idx_proactive_alerts_user_id" ON "proactive_alerts" USING btree ("user_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_message_receipts_created_at" ON "message_receipts" USING btree ("created_at" timestamptz_ops);--> statement-breakpoint
CREATE INDEX "idx_message_receipts_message_id" ON "message_receipts" USING btree ("message_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_message_receipts_status" ON "message_receipts" USING btree ("status" enum_ops);--> statement-breakpoint
CREATE INDEX "idx_message_receipts_user" ON "message_receipts" USING btree ("user_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_message_receipts_user_id" ON "message_receipts" USING btree ("user_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_message_receipts_user_message_status" ON "message_receipts" USING btree ("user_id" enum_ops,"message_id" uuid_ops,"status" uuid_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "ux_message_receipts_unique" ON "message_receipts" USING btree ("message_id" uuid_ops,"user_id" uuid_ops,"status" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_satisfaction_ratings_conversation_id" ON "satisfaction_ratings" USING btree ("conversation_id" text_ops);--> statement-breakpoint
CREATE INDEX "idx_satisfaction_ratings_created_at" ON "satisfaction_ratings" USING btree ("created_at" timestamptz_ops);--> statement-breakpoint
CREATE INDEX "idx_satisfaction_ratings_rating" ON "satisfaction_ratings" USING btree ("rating" int4_ops);--> statement-breakpoint
CREATE INDEX "idx_satisfaction_ratings_user_id" ON "satisfaction_ratings" USING btree ("user_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_user_referrals_code" ON "user_referrals" USING btree ("referral_code" text_ops);--> statement-breakpoint
CREATE INDEX "idx_user_referrals_user_id" ON "user_referrals" USING btree ("user_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_user_activity_events_created_at" ON "user_activity_events" USING btree ("created_at" timestamptz_ops);--> statement-breakpoint
CREATE INDEX "idx_user_activity_events_event_name" ON "user_activity_events" USING btree ("event_name" text_ops);--> statement-breakpoint
CREATE INDEX "idx_user_activity_events_properties" ON "user_activity_events" USING gin ("properties" jsonb_ops);--> statement-breakpoint
CREATE INDEX "idx_user_activity_events_session_id" ON "user_activity_events" USING btree ("session_id" text_ops);--> statement-breakpoint
CREATE INDEX "idx_user_activity_events_user_created" ON "user_activity_events" USING btree ("user_id" uuid_ops,"created_at" timestamptz_ops);--> statement-breakpoint
CREATE INDEX "idx_user_activity_events_user_event_date" ON "user_activity_events" USING btree ("user_id" timestamptz_ops,"event_name" timestamptz_ops,"created_at" timestamptz_ops);--> statement-breakpoint
CREATE INDEX "idx_user_activity_events_user_id" ON "user_activity_events" USING btree ("user_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_messages_chat_created" ON "messages" USING btree ("chat_id" timestamptz_ops,"created_at" timestamptz_ops);--> statement-breakpoint
CREATE INDEX "idx_messages_chat_id_created_at" ON "messages" USING btree ("chat_id" uuid_ops,"created_at" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_messages_is_deleted" ON "messages" USING btree ("is_deleted" bool_ops);--> statement-breakpoint
CREATE INDEX "idx_messages_media_url" ON "messages" USING btree ("media_url" text_ops) WHERE (media_url IS NOT NULL);--> statement-breakpoint
CREATE INDEX "idx_messages_reply_to_id" ON "messages" USING btree ("reply_to_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_messages_updated_at" ON "messages" USING btree ("updated_at" timestamptz_ops);--> statement-breakpoint
CREATE INDEX "idx_notifications_recipient_created" ON "notifications" USING btree ("recipient_id" timestamptz_ops,"created_at" timestamptz_ops);--> statement-breakpoint
CREATE INDEX "idx_notifications_recipient_read" ON "notifications" USING btree ("recipient_id" uuid_ops,"read" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_message_views_message_id" ON "message_views" USING btree ("message_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_message_views_viewer_id" ON "message_views" USING btree ("viewer_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_nearby_notifications_from_user" ON "nearby_notifications" USING btree ("from_user_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_nearby_notifications_sent_at" ON "nearby_notifications" USING btree ("sent_at" timestamptz_ops);--> statement-breakpoint
CREATE INDEX "idx_nearby_notifications_to_user" ON "nearby_notifications" USING btree ("to_user_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_nearby_notifications_user_pair" ON "nearby_notifications" USING btree ("from_user_id" uuid_ops,"to_user_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_notification_templates_category" ON "notification_templates" USING btree ("category" text_ops);--> statement-breakpoint
CREATE INDEX "idx_notification_templates_created_by" ON "notification_templates" USING btree ("created_by" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_push_tokens_enabled" ON "push_tokens" USING btree ("enabled" bool_ops);--> statement-breakpoint
CREATE INDEX "idx_push_tokens_token" ON "push_tokens" USING btree ("token" text_ops);--> statement-breakpoint
CREATE INDEX "idx_push_tokens_user_id" ON "push_tokens" USING btree ("user_id" uuid_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "idx_push_tokens_user_token" ON "push_tokens" USING btree ("user_id" uuid_ops,"token" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_subscriptions_expires_at" ON "subscriptions" USING btree ("expires_at" timestamptz_ops);--> statement-breakpoint
CREATE INDEX "idx_subscriptions_status" ON "subscriptions" USING btree ("status" text_ops);--> statement-breakpoint
CREATE INDEX "idx_subscriptions_user_id" ON "subscriptions" USING btree ("user_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_user_photos_created_at" ON "user_photos" USING btree ("created_at" timestamptz_ops);--> statement-breakpoint
CREATE INDEX "idx_user_photos_user_id" ON "user_photos" USING btree ("user_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_user_consent_timestamp" ON "user_consent" USING btree ("consent_timestamp" timestamptz_ops);--> statement-breakpoint
CREATE INDEX "idx_user_consent_user_id" ON "user_consent" USING btree ("user_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_user_activities_created_at" ON "user_activities" USING btree ("created_at" timestamp_ops);--> statement-breakpoint
CREATE INDEX "idx_user_activities_type" ON "user_activities" USING btree ("activity_type" text_ops);--> statement-breakpoint
CREATE INDEX "idx_user_activities_user_id" ON "user_activities" USING btree ("user_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_campaign_interactions_campaign" ON "user_campaign_interactions" USING btree ("campaign_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_campaign_interactions_user" ON "user_campaign_interactions" USING btree ("user_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_interactions_action" ON "user_campaign_interactions" USING btree ("action" text_ops);--> statement-breakpoint
CREATE INDEX "idx_interactions_campaign_id" ON "user_campaign_interactions" USING btree ("campaign_id" uuid_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "idx_interactions_unique" ON "user_campaign_interactions" USING btree ("campaign_id" uuid_ops,"user_id" text_ops,"action" text_ops);--> statement-breakpoint
CREATE INDEX "idx_interactions_user_id" ON "user_campaign_interactions" USING btree ("user_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_marketing_prefs_email_enabled" ON "user_marketing_preferences" USING btree ("email_enabled" bool_ops);--> statement-breakpoint
CREATE INDEX "idx_marketing_prefs_push_enabled" ON "user_marketing_preferences" USING btree ("push_enabled" bool_ops);--> statement-breakpoint
CREATE INDEX "idx_marketing_prefs_user" ON "user_marketing_preferences" USING btree ("user_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_marketing_prefs_user_id" ON "user_marketing_preferences" USING btree ("user_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_reports_created_at" ON "user_reports" USING btree ("created_at" timestamptz_ops);--> statement-breakpoint
CREATE INDEX "idx_reports_reported_user_id" ON "user_reports" USING btree ("reported_user_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_reports_reporter_id" ON "user_reports" USING btree ("reporter_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_reports_status" ON "user_reports" USING btree ("status" text_ops);--> statement-breakpoint
CREATE INDEX "idx_reports_type" ON "user_reports" USING btree ("report_type" text_ops);--> statement-breakpoint
CREATE INDEX "idx_user_reports_chat_id" ON "user_reports" USING btree ("chat_id" uuid_ops) WHERE (chat_id IS NOT NULL);--> statement-breakpoint
CREATE INDEX "idx_user_reports_message_id" ON "user_reports" USING btree ("message_id" uuid_ops) WHERE (message_id IS NOT NULL);--> statement-breakpoint
CREATE INDEX "idx_user_matches_matched_at" ON "user_matches" USING btree ("matched_at" timestamp_ops);--> statement-breakpoint
CREATE INDEX "idx_user_matches_user1" ON "user_matches" USING btree ("user1_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_user_matches_user2" ON "user_matches" USING btree ("user2_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_subscription_transactions_created_at" ON "subscription_transactions" USING btree ("created_at" timestamptz_ops);--> statement-breakpoint
CREATE INDEX "idx_subscription_transactions_order_id" ON "subscription_transactions" USING btree ("order_id" text_ops);--> statement-breakpoint
CREATE INDEX "idx_subscription_transactions_user_id" ON "subscription_transactions" USING btree ("user_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_system_settings_category" ON "system_settings" USING btree ("category" text_ops);--> statement-breakpoint
CREATE INDEX "idx_payment_requests_status" ON "referral_payment_requests" USING btree ("status" text_ops);--> statement-breakpoint
CREATE INDEX "idx_payment_requests_user" ON "referral_payment_requests" USING btree ("user_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_refunds_processed_by" ON "refunds" USING btree ("processed_by" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_refunds_requested_at" ON "refunds" USING btree ("requested_at" timestamptz_ops);--> statement-breakpoint
CREATE INDEX "idx_refunds_status" ON "refunds" USING btree ("status" text_ops);--> statement-breakpoint
CREATE INDEX "idx_refunds_subscription_id" ON "refunds" USING btree ("subscription_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_refunds_user_id" ON "refunds" USING btree ("user_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_profile_visits_last_visit" ON "user_profile_visits" USING btree ("last_visit_at" timestamp_ops);--> statement-breakpoint
CREATE INDEX "idx_profile_visits_visited" ON "user_profile_visits" USING btree ("visited_user_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_profile_visits_visitor" ON "user_profile_visits" USING btree ("visitor_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_voice_call_participants_call_id" ON "voice_call_participants" USING btree ("call_id" text_ops);--> statement-breakpoint
CREATE INDEX "idx_voice_call_participants_user_id" ON "voice_call_participants" USING btree ("user_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_user_sessions_app_version" ON "user_sessions" USING btree ("app_version" text_ops);--> statement-breakpoint
CREATE INDEX "idx_user_sessions_platform" ON "user_sessions" USING btree ("platform" text_ops);--> statement-breakpoint
CREATE INDEX "idx_user_sessions_session_id" ON "user_sessions" USING btree ("session_id" text_ops);--> statement-breakpoint
CREATE INDEX "idx_user_sessions_started_at" ON "user_sessions" USING btree ("started_at" timestamptz_ops);--> statement-breakpoint
CREATE INDEX "idx_user_sessions_user_id" ON "user_sessions" USING btree ("user_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_verification_attempts_created_at" ON "verification_attempts" USING btree ("created_at" timestamptz_ops);--> statement-breakpoint
CREATE INDEX "idx_verification_attempts_user_id" ON "verification_attempts" USING btree ("user_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_voice_calls_call_id" ON "voice_calls" USING btree ("call_id" text_ops);--> statement-breakpoint
CREATE INDEX "idx_voice_calls_caller_id" ON "voice_calls" USING btree ("caller_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_voice_calls_receiver_id" ON "voice_calls" USING btree ("receiver_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_voice_calls_started_at" ON "voice_calls" USING btree ("started_at" timestamptz_ops);--> statement-breakpoint
CREATE INDEX "idx_voice_calls_status" ON "voice_calls" USING btree ("status" text_ops);--> statement-breakpoint
CREATE INDEX "idx_voice_calls_user_history" ON "voice_calls" USING btree ("caller_id" uuid_ops,"receiver_id" timestamptz_ops,"started_at" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_user_subscriptions_expires_at" ON "user_subscriptions" USING btree ("expires_at" timestamptz_ops);--> statement-breakpoint
CREATE INDEX "idx_user_subscriptions_status" ON "user_subscriptions" USING btree ("status" text_ops);--> statement-breakpoint
CREATE INDEX "idx_user_subscriptions_user_id" ON "user_subscriptions" USING btree ("user_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_blind_date_blocked_messages" ON "blind_date_blocked_messages" USING btree ("blind_date_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_matchmaking_proposals_matched_at" ON "matchmaking_proposals" USING btree ("matched_at" timestamp_ops);--> statement-breakpoint
CREATE INDEX "idx_matchmaking_proposals_status" ON "matchmaking_proposals" USING btree ("status" text_ops);--> statement-breakpoint
CREATE INDEX "idx_matchmaking_proposals_user_a" ON "matchmaking_proposals" USING btree ("a" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_matchmaking_proposals_user_b" ON "matchmaking_proposals" USING btree ("b" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_segments_created_by" ON "user_segments" USING btree ("created_by" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_user_segments_created_by" ON "user_segments" USING btree ("created_by" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_user_segments_last_calculated" ON "user_segments" USING btree ("last_calculated_at" timestamptz_ops);--> statement-breakpoint
CREATE INDEX "idx_help_requests_active" ON "help_requests" USING btree ("status" text_ops,"expires_at" text_ops) WHERE ((status)::text = 'searching'::text);--> statement-breakpoint
CREATE INDEX "idx_help_requests_attempts" ON "help_requests" USING btree ("attempts_count" int4_ops);--> statement-breakpoint
CREATE INDEX "idx_help_requests_embedding" ON "help_requests" USING ivfflat ("prompt_embedding" vector_cosine_ops) WITH (lists=100);--> statement-breakpoint
CREATE INDEX "idx_help_requests_receiver" ON "help_requests" USING btree ("receiver_user_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_help_requests_status" ON "help_requests" USING btree ("status" text_ops);--> statement-breakpoint
CREATE INDEX "idx_chat_members_user" ON "chat_members" USING btree ("user_id" uuid_ops);--> statement-breakpoint
CREATE VIEW "public"."accepted_friendships_view" AS (SELECT id, user1_id, user2_id, sender_id, created_at, updated_at FROM friendships WHERE status::text = 'accepted'::text);--> statement-breakpoint
CREATE VIEW "public"."ai_conversation_analytics" AS (SELECT date_trunc('day'::text, created_at) AS date, status, intent, count(*) AS conversation_count, avg(refund_explanation_count) AS avg_refund_explanations, count( CASE WHEN status::text = 'escalated'::text THEN 1 ELSE NULL::integer END) AS escalations, count( CASE WHEN status::text = 'resolved'::text THEN 1 ELSE NULL::integer END) AS resolutions, count( CASE WHEN user_id IS NULL THEN 1 ELSE NULL::integer END) AS anonymous_conversations, count( CASE WHEN user_id IS NOT NULL THEN 1 ELSE NULL::integer END) AS authenticated_conversations, sum(estimated_cost) AS total_estimated_cost, avg(estimated_cost) AS avg_cost_per_conversation, sum(token_count) AS total_tokens, avg(token_count) AS avg_tokens_per_conversation FROM ai_conversations GROUP BY (date_trunc('day'::text, created_at)), status, intent ORDER BY (date_trunc('day'::text, created_at)) DESC, status, intent);--> statement-breakpoint
CREATE VIEW "public"."active_help_requests_summary" AS (SELECT hr.id, hr.receiver_user_id, p.username AS receiver_username, hr.prompt, hr.status, hr.attempts_count, hr.created_at, hr.expires_at, EXTRACT(epoch FROM hr.expires_at - now()) / 60::numeric AS minutes_remaining FROM help_requests hr JOIN profiles p ON p.id = hr.receiver_user_id WHERE hr.status::text = 'searching'::text AND hr.expires_at > now() ORDER BY hr.created_at);--> statement-breakpoint
CREATE VIEW "public"."app_version_distribution" AS (SELECT version, platform, count(DISTINCT user_id) AS user_count, count(*) AS install_count, max(created_at) AS latest_install FROM app_versions GROUP BY version, platform ORDER BY (max(created_at)) DESC);--> statement-breakpoint
CREATE VIEW "public"."beacon_retry_analytics" AS (SELECT hr.id AS request_id, hr.receiver_user_id, hr.prompt, hr.status AS request_status, hr.attempts_count, hr.created_at AS request_created_at, count(gra.id) AS total_attempts, count( CASE WHEN gra.status::text = 'accepted'::text THEN 1 ELSE NULL::integer END) AS accepted_count, count( CASE WHEN gra.status::text = 'declined'::text THEN 1 ELSE NULL::integer END) AS declined_count, count( CASE WHEN gra.status::text = 'timeout'::text THEN 1 ELSE NULL::integer END) AS timeout_count, count( CASE WHEN gra.status::text = 'pending'::text THEN 1 ELSE NULL::integer END) AS pending_count, min(gra.notified_at) AS first_attempt_at, max(gra.responded_at) AS last_response_at, EXTRACT(epoch FROM max(gra.responded_at) - min(gra.notified_at)) / 3600::numeric AS total_hours_to_resolve FROM help_requests hr LEFT JOIN giver_request_attempts gra ON hr.id = gra.help_request_id WHERE hr.created_at > (now() - '30 days'::interval) GROUP BY hr.id, hr.receiver_user_id, hr.prompt, hr.status, hr.attempts_count, hr.created_at);--> statement-breakpoint
CREATE VIEW "public"."call_analytics" AS (SELECT date(started_at) AS call_date, count(*) AS total_calls, count( CASE WHEN status = 'connected'::text THEN 1 ELSE NULL::integer END) AS successful_calls, count( CASE WHEN status = 'declined'::text THEN 1 ELSE NULL::integer END) AS declined_calls, count( CASE WHEN status = 'missed'::text THEN 1 ELSE NULL::integer END) AS missed_calls, avg(duration_seconds) AS avg_duration_seconds, sum(duration_seconds) AS total_duration_seconds FROM voice_calls WHERE started_at >= (CURRENT_DATE - '30 days'::interval) GROUP BY (date(started_at)) ORDER BY (date(started_at)) DESC);--> statement-breakpoint
CREATE VIEW "public"."conversation_analytics_view" AS (SELECT date(created_at) AS date, count(*) AS total_conversations, count(*) FILTER (WHERE status::text = 'resolved'::text) AS resolved_conversations, count(*) FILTER (WHERE status::text = 'escalated'::text) AS escalated_conversations, avg(satisfaction_rating) AS average_satisfaction, avg(EXTRACT(epoch FROM updated_at - created_at) / 60::numeric) AS average_response_time_minutes, sum(estimated_cost) AS total_cost, CASE WHEN count(*) > 0 THEN round((count(*) FILTER (WHERE status::text = 'resolved'::text)::double precision / count(*)::double precision * 100::double precision + (COALESCE(avg(satisfaction_rating), 0::numeric) * 20::numeric)::double precision + GREATEST(0::numeric, 100::numeric - avg(EXTRACT(epoch FROM updated_at - created_at) / 60::numeric))::double precision) / 3::double precision) ELSE 0::double precision END AS ai_efficiency_score FROM ai_conversations WHERE created_at >= (CURRENT_DATE - '30 days'::interval) GROUP BY (date(created_at)) ORDER BY (date(created_at)) DESC);--> statement-breakpoint
CREATE VIEW "public"."crash_summary" AS (SELECT date(created_at) AS date, count(*) AS total_crashes, count( CASE WHEN is_fatal THEN 1 ELSE NULL::integer END) AS fatal_crashes, count(DISTINCT user_id) AS affected_users, app_version, device_platform FROM crash_reports GROUP BY (date(created_at)), app_version, device_platform ORDER BY (date(created_at)) DESC);--> statement-breakpoint
CREATE VIEW "public"."daily_active_users" AS (SELECT date(created_at) AS date, count(DISTINCT user_id) AS active_users, count(*) AS total_events FROM analytics_events WHERE user_id IS NOT NULL GROUP BY (date(created_at)) ORDER BY (date(created_at)) DESC);--> statement-breakpoint
CREATE VIEW "public"."feature_adoption" AS (SELECT feature_name, count(DISTINCT user_id) AS unique_users, sum(usage_count) AS total_usage, avg(usage_count) AS avg_usage_per_user, sum(total_time_seconds) AS total_time_seconds FROM feature_usage GROUP BY feature_name ORDER BY (count(DISTINCT user_id)) DESC);--> statement-breakpoint
CREATE VIEW "public"."friend_requests_view" AS (SELECT id, sender_id, CASE WHEN sender_id = user1_id THEN user2_id ELSE user1_id END AS receiver_id, status, created_at, updated_at FROM friendships WHERE status::text = 'pending'::text);--> statement-breakpoint
CREATE VIEW "public"."giver_leaderboard" AS (SELECT gp.user_id, p.username, p.first_name, p.last_name, gp.total_helps_given, gp.average_rating, gp.is_available, gp.categories, gp.skills FROM giver_profiles gp JOIN profiles p ON p.id = gp.user_id WHERE gp.total_helps_given > 0 ORDER BY gp.total_helps_given DESC, gp.average_rating DESC LIMIT 100);--> statement-breakpoint
CREATE VIEW "public"."real_time_metrics_view" AS (SELECT ( SELECT count(*) AS count FROM ai_conversations WHERE ai_conversations.status::text = 'active'::text AND ai_conversations.updated_at >= (now() - '00:30:00'::interval)) AS active_conversations, ( SELECT count(*) AS count FROM ai_conversations WHERE ai_conversations.status::text = 'active'::text) AS queue_length, ( SELECT count(*) AS count FROM ai_conversations WHERE ai_conversations.status::text = 'resolved'::text AND date(ai_conversations.updated_at) = CURRENT_DATE) AS issues_resolved_today, ( SELECT count(*) AS count FROM ai_conversations WHERE ai_conversations.status::text = 'escalated'::text AND date(ai_conversations.created_at) = CURRENT_DATE) AS escalations_today, ( SELECT avg(satisfaction_ratings.rating) AS avg FROM satisfaction_ratings WHERE satisfaction_ratings.created_at >= (now() - '24:00:00'::interval)) AS current_satisfaction_score, ( SELECT avg(agent_capabilities.current_load::double precision / agent_capabilities.max_load::double precision * 100::double precision) AS avg FROM agent_capabilities WHERE agent_capabilities.availability::text = 'available'::text) AS agent_utilization);--> statement-breakpoint
CREATE MATERIALIZED VIEW "public"."popular_features" AS (SELECT properties ->> 'feature'::text AS feature_name, count(*) AS usage_count, count(DISTINCT user_id) AS unique_users, date(created_at) AS date FROM user_activity_events WHERE event_name = 'feature_usage'::text AND (properties ->> 'feature'::text) IS NOT NULL GROUP BY (properties ->> 'feature'::text), (date(created_at)) ORDER BY (count(*)) DESC);--> statement-breakpoint
CREATE VIEW "public"."referral_dashboard" AS (SELECT ur.user_id, p.username, p.email, ur.referral_code, ur.total_referrals, ur.total_earnings, ur.pending_earnings, ur.paid_earnings, ur.upi_id, ur.upi_verified, count( CASE WHEN rt.status::text = 'pending'::text THEN 1 ELSE NULL::integer END) AS pending_count, count( CASE WHEN rt.status::text = 'approved'::text THEN 1 ELSE NULL::integer END) AS approved_count, count( CASE WHEN rt.status::text = 'paid'::text THEN 1 ELSE NULL::integer END) AS paid_count, count( CASE WHEN rt.status::text = 'rejected'::text THEN 1 ELSE NULL::integer END) AS rejected_count FROM user_referrals ur JOIN profiles p ON ur.user_id = p.id LEFT JOIN referral_transactions rt ON ur.user_id = rt.referrer_user_id GROUP BY ur.user_id, p.username, p.email, ur.referral_code, ur.total_referrals, ur.total_earnings, ur.pending_earnings, ur.paid_earnings, ur.upi_id, ur.upi_verified);--> statement-breakpoint
CREATE VIEW "public"."v_active_announcements" AS (SELECT id, title, message, image_url, link_url, buttons, placements, audience, countries, min_app_version, priority, starts_at, ends_at, is_active, send_push_on_publish, created_by, created_at, updated_at, published_at FROM announcements WHERE is_active = true AND (starts_at IS NULL OR now() >= starts_at) AND (ends_at IS NULL OR now() <= ends_at));--> statement-breakpoint
CREATE MATERIALIZED VIEW "public"."mv_top_users" AS (SELECT id, first_name, last_name, username, email, profile_photo_url, age, gender, interests, needs, created_at, updated_at, CASE WHEN first_name IS NOT NULL THEN 1 ELSE 0 END + CASE WHEN last_name IS NOT NULL THEN 1 ELSE 0 END + CASE WHEN profile_photo_url IS NOT NULL THEN 1 ELSE 0 END + CASE WHEN age IS NOT NULL THEN 1 ELSE 0 END + CASE WHEN gender IS NOT NULL THEN 1 ELSE 0 END + CASE WHEN interests IS NOT NULL AND array_length(interests, 1) > 0 THEN 2 ELSE 0 END + CASE WHEN needs IS NOT NULL AND array_length(needs, 1) > 0 THEN 2 ELSE 0 END AS completeness_score FROM profiles WHERE first_name IS NOT NULL AND last_name IS NOT NULL ORDER BY ( CASE WHEN first_name IS NOT NULL THEN 1 ELSE 0 END + CASE WHEN last_name IS NOT NULL THEN 1 ELSE 0 END + CASE WHEN profile_photo_url IS NOT NULL THEN 1 ELSE 0 END + CASE WHEN age IS NOT NULL THEN 1 ELSE 0 END + CASE WHEN gender IS NOT NULL THEN 1 ELSE 0 END + CASE WHEN interests IS NOT NULL AND array_length(interests, 1) > 0 THEN 2 ELSE 0 END + CASE WHEN needs IS NOT NULL AND array_length(needs, 1) > 0 THEN 2 ELSE 0 END) DESC, updated_at DESC);--> statement-breakpoint
CREATE POLICY "activity_feed_update_for_owner" ON "activity_feed" AS PERMISSIVE FOR UPDATE TO "authenticated" USING ((( SELECT auth.uid() AS uid) = user_id)) WITH CHECK ((( SELECT auth.uid() AS uid) = user_id));--> statement-breakpoint
CREATE POLICY "activity_feed_select_for_owner" ON "activity_feed" AS PERMISSIVE FOR SELECT TO "authenticated";--> statement-breakpoint
CREATE POLICY "activity_feed_public_select" ON "activity_feed" AS PERMISSIVE FOR SELECT TO "authenticated";--> statement-breakpoint
CREATE POLICY "activity_feed_insert_for_owner" ON "activity_feed" AS PERMISSIVE FOR INSERT TO "authenticated";--> statement-breakpoint
CREATE POLICY "activity_feed_delete_for_owner" ON "activity_feed" AS PERMISSIVE FOR DELETE TO "authenticated";--> statement-breakpoint
CREATE POLICY "admin_audit_logs_select_policy" ON "admin_audit_logs" AS PERMISSIVE FOR SELECT TO public USING ((EXISTS ( SELECT 1
   FROM admin_roles ar
  WHERE ((ar.user_id = auth.uid()) AND (ar.is_active = true)))));--> statement-breakpoint
CREATE POLICY "admin_audit_logs_insert_policy" ON "admin_audit_logs" AS PERMISSIVE FOR INSERT TO public;--> statement-breakpoint
CREATE POLICY "Users can view their own analytics events" ON "analytics_events" AS PERMISSIVE FOR SELECT TO public USING ((auth.uid() = user_id));--> statement-breakpoint
CREATE POLICY "Service role can manage all analytics events" ON "analytics_events" AS PERMISSIVE FOR ALL TO public;--> statement-breakpoint
CREATE POLICY "admin_roles_policy" ON "admin_roles" AS PERMISSIVE FOR ALL TO public USING ((EXISTS ( SELECT 1
   FROM admin_roles ar
  WHERE ((ar.user_id = auth.uid()) AND (ar.role = 'super_admin'::text) AND (ar.is_active = true)))));--> statement-breakpoint
CREATE POLICY "ai_conversations_user_policy" ON "ai_conversations" AS PERMISSIVE FOR ALL TO public USING (((auth.uid() = user_id) OR (auth.uid() IN ( SELECT admin_roles.user_id
   FROM admin_roles
  WHERE (admin_roles.is_active = true)))));--> statement-breakpoint
CREATE POLICY "ai_conversations_anonymous_policy" ON "ai_conversations" AS PERMISSIVE FOR ALL TO public;--> statement-breakpoint
CREATE POLICY "Only admins can update app version config" ON "app_version_config" AS PERMISSIVE FOR ALL TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.is_admin = true))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.is_admin = true)))));--> statement-breakpoint
CREATE POLICY "Allow public read access to app version config" ON "app_version_config" AS PERMISSIVE FOR SELECT TO public;--> statement-breakpoint
CREATE POLICY "giver_attempts_view_own" ON "giver_request_attempts" AS PERMISSIVE FOR SELECT TO public USING (((auth.uid() = giver_user_id) OR (auth.uid() IN ( SELECT help_requests.receiver_user_id
   FROM help_requests
  WHERE (help_requests.id = giver_request_attempts.help_request_id)))));--> statement-breakpoint
CREATE POLICY "giver_attempts_update" ON "giver_request_attempts" AS PERMISSIVE FOR UPDATE TO public;--> statement-breakpoint
CREATE POLICY "giver_attempts_insert" ON "giver_request_attempts" AS PERMISSIVE FOR INSERT TO public;--> statement-breakpoint
CREATE POLICY "System can insert giver request attempts" ON "giver_request_attempts" AS PERMISSIVE FOR INSERT TO public;--> statement-breakpoint
CREATE POLICY "Givers can view requests sent to them" ON "giver_request_attempts" AS PERMISSIVE FOR SELECT TO public;--> statement-breakpoint
CREATE POLICY "Givers can update their own attempts" ON "giver_request_attempts" AS PERMISSIVE FOR UPDATE TO public;--> statement-breakpoint
CREATE POLICY "Users can view others location" ON "profiles" AS PERMISSIVE FOR SELECT TO public USING (true);--> statement-breakpoint
CREATE POLICY "Users can update own location" ON "profiles" AS PERMISSIVE FOR UPDATE TO public;--> statement-breakpoint
CREATE POLICY "Users can view their own app versions" ON "app_versions" AS PERMISSIVE FOR SELECT TO public USING ((auth.uid() = user_id));--> statement-breakpoint
CREATE POLICY "Service role can manage all app versions" ON "app_versions" AS PERMISSIVE FOR ALL TO public;--> statement-breakpoint
CREATE POLICY "Users can view their own crash reports" ON "crash_reports" AS PERMISSIVE FOR SELECT TO public USING ((auth.uid() = user_id));--> statement-breakpoint
CREATE POLICY "Service role can manage all crash reports" ON "crash_reports" AS PERMISSIVE FOR ALL TO public;--> statement-breakpoint
CREATE POLICY "Users can view own mute settings" ON "chat_mute_settings" AS PERMISSIVE FOR SELECT TO public USING ((auth.uid() = user_id));--> statement-breakpoint
CREATE POLICY "Users can update own mute settings" ON "chat_mute_settings" AS PERMISSIVE FOR UPDATE TO public;--> statement-breakpoint
CREATE POLICY "Users can insert own mute settings" ON "chat_mute_settings" AS PERMISSIVE FOR INSERT TO public;--> statement-breakpoint
CREATE POLICY "Users can delete own mute settings" ON "chat_mute_settings" AS PERMISSIVE FOR DELETE TO public;--> statement-breakpoint
CREATE POLICY "chat_user_settings_update" ON "chat_user_settings" AS PERMISSIVE FOR UPDATE TO public USING ((user_id = auth.uid())) WITH CHECK ((user_id = auth.uid()));--> statement-breakpoint
CREATE POLICY "chat_user_settings_select" ON "chat_user_settings" AS PERMISSIVE FOR SELECT TO public;--> statement-breakpoint
CREATE POLICY "chat_user_settings_insert" ON "chat_user_settings" AS PERMISSIVE FOR INSERT TO public;--> statement-breakpoint
CREATE POLICY "chat_user_settings_delete" ON "chat_user_settings" AS PERMISSIVE FOR DELETE TO public;--> statement-breakpoint
CREATE POLICY "email_otps_user_policy" ON "email_otps" AS PERMISSIVE FOR ALL TO public USING ((email = (auth.jwt() ->> 'email'::text)));--> statement-breakpoint
CREATE POLICY "email_otps_service_policy" ON "email_otps" AS PERMISSIVE FOR ALL TO public;--> statement-breakpoint
CREATE POLICY "beta_testers_update_policy" ON "beta_testers" AS PERMISSIVE FOR UPDATE TO public USING (((auth.role() = 'authenticated'::text) AND (EXISTS ( SELECT 1
   FROM profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.role = 'admin'::text))))));--> statement-breakpoint
CREATE POLICY "beta_testers_select_policy" ON "beta_testers" AS PERMISSIVE FOR SELECT TO public;--> statement-breakpoint
CREATE POLICY "beta_testers_insert_policy" ON "beta_testers" AS PERMISSIVE FOR INSERT TO public;--> statement-breakpoint
CREATE POLICY "Users can view their own blocks" ON "blocks" AS PERMISSIVE FOR SELECT TO public USING (((auth.uid())::text = (blocker_id)::text));--> statement-breakpoint
CREATE POLICY "Users can delete their own blocks" ON "blocks" AS PERMISSIVE FOR DELETE TO public;--> statement-breakpoint
CREATE POLICY "Users can create blocks" ON "blocks" AS PERMISSIVE FOR INSERT TO public;--> statement-breakpoint
CREATE POLICY "Users can view their own feature usage" ON "feature_usage" AS PERMISSIVE FOR SELECT TO public USING ((auth.uid() = user_id));--> statement-breakpoint
CREATE POLICY "Service role can manage all feature usage" ON "feature_usage" AS PERMISSIVE FOR ALL TO public;--> statement-breakpoint
CREATE POLICY "Users can view all giver profiles" ON "giver_profiles" AS PERMISSIVE FOR SELECT TO public USING (true);--> statement-breakpoint
CREATE POLICY "Users can update their own giver profile" ON "giver_profiles" AS PERMISSIVE FOR UPDATE TO public;--> statement-breakpoint
CREATE POLICY "Users can insert their own giver profile" ON "giver_profiles" AS PERMISSIVE FOR INSERT TO public;--> statement-breakpoint
CREATE POLICY "Users can delete their own giver profile" ON "giver_profiles" AS PERMISSIVE FOR DELETE TO public;--> statement-breakpoint
CREATE POLICY "Participants can view feedback for their sessions" ON "help_session_feedback" AS PERMISSIVE FOR SELECT TO public USING (((auth.uid() = receiver_user_id) OR (auth.uid() = giver_user_id)));--> statement-breakpoint
CREATE POLICY "Participants can update their own feedback" ON "help_session_feedback" AS PERMISSIVE FOR UPDATE TO public;--> statement-breakpoint
CREATE POLICY "Participants can insert feedback" ON "help_session_feedback" AS PERMISSIVE FOR INSERT TO public;--> statement-breakpoint
CREATE POLICY "Users can view message reactions" ON "message_reactions" AS PERMISSIVE FOR SELECT TO public USING ((EXISTS ( SELECT 1
   FROM (messages m
     JOIN chat_members cm ON ((m.chat_id = cm.chat_id)))
  WHERE ((m.id = message_reactions.message_id) AND (cm.user_id = auth.uid())))));--> statement-breakpoint
CREATE POLICY "Users can delete their own reactions" ON "message_reactions" AS PERMISSIVE FOR DELETE TO public;--> statement-breakpoint
CREATE POLICY "Users can add message reactions" ON "message_reactions" AS PERMISSIVE FOR INSERT TO public;--> statement-breakpoint
CREATE POLICY "feature_flags_policy" ON "feature_flags" AS PERMISSIVE FOR ALL TO public USING ((EXISTS ( SELECT 1
   FROM admin_roles ar
  WHERE ((ar.user_id = auth.uid()) AND (ar.role = 'super_admin'::text) AND (ar.is_active = true)))));--> statement-breakpoint
CREATE POLICY "explore_interactions_select_own" ON "explore_interactions" AS PERMISSIVE FOR SELECT TO public USING ((auth.uid() = user_id));--> statement-breakpoint
CREATE POLICY "explore_interactions_insert_own" ON "explore_interactions" AS PERMISSIVE FOR INSERT TO public;--> statement-breakpoint
CREATE POLICY "explore_interactions_delete_own" ON "explore_interactions" AS PERMISSIVE FOR DELETE TO public;--> statement-breakpoint
CREATE POLICY "Users can view message receipts" ON "message_receipts" AS PERMISSIVE FOR SELECT TO public USING (((user_id = auth.uid()) OR (message_id IN ( SELECT messages.id
   FROM messages
  WHERE (messages.sender_id = auth.uid())))));--> statement-breakpoint
CREATE POLICY "Users can update their own receipts" ON "message_receipts" AS PERMISSIVE FOR UPDATE TO public;--> statement-breakpoint
CREATE POLICY "Users can create message receipts" ON "message_receipts" AS PERMISSIVE FOR INSERT TO public;--> statement-breakpoint
CREATE POLICY "user_activity_events_select_policy" ON "user_activity_events" AS PERMISSIVE FOR SELECT TO public USING ((auth.uid() = user_id));--> statement-breakpoint
CREATE POLICY "user_activity_events_insert_policy" ON "user_activity_events" AS PERMISSIVE FOR INSERT TO public;--> statement-breakpoint
CREATE POLICY "user_activity_events_admin_policy" ON "user_activity_events" AS PERMISSIVE FOR ALL TO public;--> statement-breakpoint
CREATE POLICY "Users can update their own messages" ON "messages" AS PERMISSIVE FOR UPDATE TO public USING ((sender_id = auth.uid())) WITH CHECK ((sender_id = auth.uid()));--> statement-breakpoint
CREATE POLICY "Users can view their own notifications" ON "notifications" AS PERMISSIVE FOR SELECT TO public USING ((recipient_id = auth.uid()));--> statement-breakpoint
CREATE POLICY "Users can update their own notifications" ON "notifications" AS PERMISSIVE FOR UPDATE TO public;--> statement-breakpoint
CREATE POLICY "Users can delete their own notifications" ON "notifications" AS PERMISSIVE FOR DELETE TO public;--> statement-breakpoint
CREATE POLICY "System can create notifications" ON "notifications" AS PERMISSIVE FOR INSERT TO public;--> statement-breakpoint
CREATE POLICY "Users can view their own photos" ON "user_photos" AS PERMISSIVE FOR SELECT TO public USING ((user_id = auth.uid()));--> statement-breakpoint
CREATE POLICY "Users can view other users photos" ON "user_photos" AS PERMISSIVE FOR SELECT TO public;--> statement-breakpoint
CREATE POLICY "Users can update their own photos" ON "user_photos" AS PERMISSIVE FOR UPDATE TO public;--> statement-breakpoint
CREATE POLICY "Users can insert their own photos" ON "user_photos" AS PERMISSIVE FOR INSERT TO public;--> statement-breakpoint
CREATE POLICY "Users can delete their own photos" ON "user_photos" AS PERMISSIVE FOR DELETE TO public;--> statement-breakpoint
CREATE POLICY "Users can manage their own consent" ON "user_consent" AS PERMISSIVE FOR ALL TO public USING ((auth.uid() = user_id));--> statement-breakpoint
CREATE POLICY "Service role can view all consent records" ON "user_consent" AS PERMISSIVE FOR SELECT TO public;--> statement-breakpoint
CREATE POLICY "user_reports_update_policy" ON "user_reports" AS PERMISSIVE FOR UPDATE TO public USING ((EXISTS ( SELECT 1
   FROM admin_roles ar
  WHERE ((ar.user_id = auth.uid()) AND (ar.is_active = true)))));--> statement-breakpoint
CREATE POLICY "user_reports_select_policy" ON "user_reports" AS PERMISSIVE FOR SELECT TO public;--> statement-breakpoint
CREATE POLICY "user_reports_insert_policy" ON "user_reports" AS PERMISSIVE FOR INSERT TO public;--> statement-breakpoint
CREATE POLICY "system_settings_policy" ON "system_settings" AS PERMISSIVE FOR ALL TO public USING ((EXISTS ( SELECT 1
   FROM admin_roles ar
  WHERE ((ar.user_id = auth.uid()) AND (ar.role = 'super_admin'::text) AND (ar.is_active = true)))));--> statement-breakpoint
CREATE POLICY "Users can view their own sessions" ON "user_sessions" AS PERMISSIVE FOR SELECT TO public USING ((auth.uid() = user_id));--> statement-breakpoint
CREATE POLICY "Service role can manage all sessions" ON "user_sessions" AS PERMISSIVE FOR ALL TO public;--> statement-breakpoint
CREATE POLICY "Users can view their own help requests" ON "help_requests" AS PERMISSIVE FOR SELECT TO public USING (((auth.uid() = receiver_user_id) OR (auth.uid() = matched_giver_id)));--> statement-breakpoint
CREATE POLICY "Users can update their own help requests" ON "help_requests" AS PERMISSIVE FOR UPDATE TO public;--> statement-breakpoint
CREATE POLICY "Users can create their own help requests" ON "help_requests" AS PERMISSIVE FOR INSERT TO public;
*/