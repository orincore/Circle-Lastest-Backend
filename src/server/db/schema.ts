import { pgTable, index, foreignKey, pgPolicy, text, jsonb, timestamp, uuid, bigserial, varchar, unique, check, boolean, integer, numeric, uniqueIndex, date, time, serial, vector, inet, primaryKey, pgView, bigint, doublePrecision, pgMaterializedView, pgEnum, pgSchema } from "drizzle-orm/pg-core"
import { sql } from "drizzle-orm"

export const messageReceiptStatus = pgEnum("message_receipt_status", ['delivered', 'read'])
export const verificationStatus = pgEnum("verification_status", ['pending', 'verified', 'rejected', 'expired'])

// Manually added after `drizzle-kit pull` (not generated): drizzle-kit only introspects the
// `public` schema, but `explore_interactions` below has foreign keys into Supabase's
// `auth.users` table. drizzle-kit itself expects this table to be named `usersInAuth` (see
// the import list in the generated `relations.ts`), but it never emitted the actual table
// definition into this file, leaving a dangling reference. The local Postgres restore
// (Task 4's restore-prerequisites fix) created a minimal `auth.users` stub (just `id uuid
// primary key`, 0 rows) so that
// FK constraint could be restored; this mirrors that stub under drizzle-kit's own intended
// name so both this file's foreign keys and relations.ts resolve instead of throwing
// `ReferenceError: users is not defined` / `usersInAuth is not defined` when Drizzle builds
// its relational query config.
export const authSchema = pgSchema("auth")
export const usersInAuth = authSchema.table("users", {
	id: uuid().primaryKey().notNull(),
})


export const activityFeed = pgTable("activity_feed", {
	id: text().primaryKey().notNull(),
	type: text().notNull(),
	data: jsonb().notNull(),
	timestamp: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	userId: uuid("user_id"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow(),
}, (table) => [
	index("idx_activity_feed_timestamp").using("btree", table.timestamp.desc().nullsFirst().op("timestamptz_ops")),
	index("idx_activity_feed_type").using("btree", table.type.asc().nullsLast().op("text_ops")),
	index("idx_activity_feed_user_id").using("btree", table.userId.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.userId],
			foreignColumns: [profiles.id],
			name: "activity_feed_user_id_fkey"
		}).onDelete("cascade"),
	pgPolicy("activity_feed_update_for_owner", { as: "permissive", for: "update", to: ["authenticated"], using: sql`(( SELECT auth.uid() AS uid) = user_id)`, withCheck: sql`(( SELECT auth.uid() AS uid) = user_id)`  }),
	pgPolicy("activity_feed_select_for_owner", { as: "permissive", for: "select", to: ["authenticated"] }),
	pgPolicy("activity_feed_public_select", { as: "permissive", for: "select", to: ["authenticated"] }),
	pgPolicy("activity_feed_insert_for_owner", { as: "permissive", for: "insert", to: ["authenticated"] }),
	pgPolicy("activity_feed_delete_for_owner", { as: "permissive", for: "delete", to: ["authenticated"] }),
]);

export const adminAuditLogs = pgTable("admin_audit_logs", {
	id: uuid().default(sql`extensions.uuid_generate_v4()`).primaryKey().notNull(),
	adminId: uuid("admin_id"),
	action: text().notNull(),
	targetType: text("target_type"),
	targetId: uuid("target_id"),
	details: jsonb(),
	ipAddress: text("ip_address"),
	userAgent: text("user_agent"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow(),
}, (table) => [
	index("idx_audit_logs_action").using("btree", table.action.asc().nullsLast().op("text_ops")),
	index("idx_audit_logs_admin_id").using("btree", table.adminId.asc().nullsLast().op("uuid_ops")),
	index("idx_audit_logs_created_at").using("btree", table.createdAt.desc().nullsFirst().op("timestamptz_ops")),
	index("idx_audit_logs_target_type").using("btree", table.targetType.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.adminId],
			foreignColumns: [profiles.id],
			name: "admin_audit_logs_admin_id_fkey"
		}),
	pgPolicy("admin_audit_logs_select_policy", { as: "permissive", for: "select", to: ["public"], using: sql`(EXISTS ( SELECT 1
   FROM admin_roles ar
  WHERE ((ar.user_id = auth.uid()) AND (ar.is_active = true))))` }),
	pgPolicy("admin_audit_logs_insert_policy", { as: "permissive", for: "insert", to: ["public"] }),
]);

export const analyticsEvents = pgTable("analytics_events", {
	id: bigserial({ mode: "bigint" }).primaryKey().notNull(),
	eventName: varchar("event_name", { length: 100 }).notNull(),
	userId: uuid("user_id"),
	sessionId: varchar("session_id", { length: 100 }),
	timestamp: timestamp({ withTimezone: true, mode: 'string' }).notNull(),
	properties: jsonb().default({}),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow(),
}, (table) => [
	index("idx_analytics_events_created_at").using("btree", table.createdAt.asc().nullsLast().op("timestamptz_ops")),
	index("idx_analytics_events_event_name").using("btree", table.eventName.asc().nullsLast().op("text_ops")),
	index("idx_analytics_events_properties").using("gin", table.properties.asc().nullsLast().op("jsonb_ops")),
	index("idx_analytics_events_session_id").using("btree", table.sessionId.asc().nullsLast().op("text_ops")),
	index("idx_analytics_events_timestamp").using("btree", table.timestamp.asc().nullsLast().op("timestamptz_ops")),
	index("idx_analytics_events_user_id").using("btree", table.userId.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.userId],
			foreignColumns: [profiles.id],
			name: "analytics_events_user_id_fkey"
		}).onDelete("set null"),
	pgPolicy("Users can view their own analytics events", { as: "permissive", for: "select", to: ["public"], using: sql`(auth.uid() = user_id)` }),
	pgPolicy("Service role can manage all analytics events", { as: "permissive", for: "all", to: ["public"] }),
]);

export const adminRoles = pgTable("admin_roles", {
	id: uuid().default(sql`extensions.uuid_generate_v4()`).primaryKey().notNull(),
	userId: uuid("user_id"),
	role: text().notNull(),
	grantedBy: uuid("granted_by"),
	grantedAt: timestamp("granted_at", { withTimezone: true, mode: 'string' }).defaultNow(),
	revokedAt: timestamp("revoked_at", { withTimezone: true, mode: 'string' }),
	isActive: boolean("is_active").default(true),
}, (table) => [
	index("idx_admin_roles_active").using("btree", table.isActive.asc().nullsLast().op("bool_ops")),
	index("idx_admin_roles_role").using("btree", table.role.asc().nullsLast().op("text_ops")),
	index("idx_admin_roles_user_id").using("btree", table.userId.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.grantedBy],
			foreignColumns: [profiles.id],
			name: "admin_roles_granted_by_fkey"
		}),
	foreignKey({
			columns: [table.userId],
			foreignColumns: [profiles.id],
			name: "admin_roles_user_id_fkey"
		}).onDelete("cascade"),
	unique("admin_roles_user_id_key").on(table.userId),
	pgPolicy("admin_roles_policy", { as: "permissive", for: "all", to: ["public"], using: sql`(EXISTS ( SELECT 1
   FROM admin_roles ar
  WHERE ((ar.user_id = auth.uid()) AND (ar.role = 'super_admin'::text) AND (ar.is_active = true))))` }),
	check("admin_roles_role_check", sql`role = ANY (ARRAY['super_admin'::text, 'moderator'::text, 'support'::text])`),
]);

export const aiConversations = pgTable("ai_conversations", {
	id: varchar({ length: 255 }).primaryKey().notNull(),
	userId: uuid("user_id"),
	sessionId: varchar("session_id", { length: 255 }).notNull(),
	messages: jsonb().default([]),
	status: varchar({ length: 50 }).default('active'),
	intent: varchar({ length: 100 }).default('general'),
	refundExplanationCount: integer("refund_explanation_count").default(0),
	estimatedCost: numeric("estimated_cost", { precision: 10, scale:  6 }).default('0.000000'),
	tokenCount: integer("token_count").default(0),
	userContext: jsonb("user_context"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow(),
	personality: jsonb(),
	conversationState: jsonb("conversation_state"),
	sentimentAnalysis: jsonb("sentiment_analysis"),
	detectedLanguage: varchar("detected_language", { length: 10 }),
	escalationLevel: varchar("escalation_level", { length: 20 }),
	satisfactionRating: integer("satisfaction_rating"),
	proactiveAlerts: jsonb("proactive_alerts"),
}, (table) => [
	index("idx_ai_conversations_created_at").using("btree", table.createdAt.asc().nullsLast().op("timestamptz_ops")),
	index("idx_ai_conversations_detected_language").using("btree", table.detectedLanguage.asc().nullsLast().op("text_ops")),
	index("idx_ai_conversations_escalation_level").using("btree", table.escalationLevel.asc().nullsLast().op("text_ops")),
	index("idx_ai_conversations_intent").using("btree", table.intent.asc().nullsLast().op("text_ops")),
	index("idx_ai_conversations_satisfaction_rating").using("btree", table.satisfactionRating.asc().nullsLast().op("int4_ops")),
	index("idx_ai_conversations_session_id").using("btree", table.sessionId.asc().nullsLast().op("text_ops")),
	index("idx_ai_conversations_status").using("btree", table.status.asc().nullsLast().op("text_ops")),
	index("idx_ai_conversations_user_id").using("btree", table.userId.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.userId],
			foreignColumns: [profiles.id],
			name: "ai_conversations_user_id_fkey"
		}).onDelete("cascade"),
	pgPolicy("ai_conversations_user_policy", { as: "permissive", for: "all", to: ["public"], using: sql`((auth.uid() = user_id) OR (auth.uid() IN ( SELECT admin_roles.user_id
   FROM admin_roles
  WHERE (admin_roles.is_active = true))))` }),
	pgPolicy("ai_conversations_anonymous_policy", { as: "permissive", for: "all", to: ["public"] }),
	check("ai_conversations_satisfaction_rating_check", sql`(satisfaction_rating >= 1) AND (satisfaction_rating <= 5)`),
	check("ai_conversations_status_check", sql`(status)::text = ANY (ARRAY[('active'::character varying)::text, ('escalated'::character varying)::text, ('resolved'::character varying)::text, ('abandoned'::character varying)::text])`),
]);

export const friendships = pgTable("friendships", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	user1Id: uuid("user1_id").notNull(),
	user2Id: uuid("user2_id").notNull(),
	status: varchar({ length: 20 }).default('active').notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow(),
	senderId: uuid("sender_id"),
}, (table) => [
	index("idx_friendships_created_at").using("btree", table.createdAt.desc().nullsFirst().op("timestamptz_ops")),
	index("idx_friendships_sender").using("btree", table.senderId.asc().nullsLast().op("uuid_ops")),
	index("idx_friendships_status").using("btree", table.status.asc().nullsLast().op("text_ops")),
	index("idx_friendships_status_active").using("btree", table.status.asc().nullsLast().op("text_ops")).where(sql`((status)::text = 'active'::text)`),
	index("idx_friendships_user1_status").using("btree", table.user1Id.asc().nullsLast().op("uuid_ops"), table.status.asc().nullsLast().op("uuid_ops")),
	index("idx_friendships_user2_status").using("btree", table.user2Id.asc().nullsLast().op("text_ops"), table.status.asc().nullsLast().op("text_ops")),
	index("idx_friendships_users_status").using("btree", table.user1Id.asc().nullsLast().op("uuid_ops"), table.user2Id.asc().nullsLast().op("text_ops"), table.status.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.user1Id],
			foreignColumns: [profiles.id],
			name: "fk_friendships_user1"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.user2Id],
			foreignColumns: [profiles.id],
			name: "fk_friendships_user2"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.senderId],
			foreignColumns: [profiles.id],
			name: "friendships_sender_id_fkey"
		}),
	unique("unique_friendship").on(table.user1Id, table.user2Id),
	check("check_friendships_status", sql`(status)::text = ANY (ARRAY[('pending'::character varying)::text, ('accepted'::character varying)::text, ('active'::character varying)::text, ('inactive'::character varying)::text, ('blocked'::character varying)::text])`),
]);

export const appVersionConfig = pgTable("app_version_config", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	platform: varchar({ length: 20 }).notNull(),
	minVersion: varchar("min_version", { length: 20 }).default('1.0.0').notNull(),
	latestVersion: varchar("latest_version", { length: 20 }).default('1.0.0').notNull(),
	forceUpdate: boolean("force_update").default(false).notNull(),
	updateMessage: text("update_message").default('A new version of Circle is available. Please update to continue.'),
	optionalUpdateMessage: text("optional_update_message").default('A new version is available with new features!'),
	storeUrl: text("store_url"),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow(),
	updatedBy: uuid("updated_by"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow(),
}, (table) => [
	index("idx_app_version_config_platform").using("btree", table.platform.asc().nullsLast().op("text_ops")),
	unique("app_version_config_platform_key").on(table.platform),
	pgPolicy("Only admins can update app version config", { as: "permissive", for: "all", to: ["authenticated"], using: sql`(EXISTS ( SELECT 1
   FROM profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.is_admin = true))))`, withCheck: sql`(EXISTS ( SELECT 1
   FROM profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.is_admin = true))))`  }),
	pgPolicy("Allow public read access to app version config", { as: "permissive", for: "select", to: ["public"] }),
	check("app_version_config_platform_check", sql`(platform)::text = ANY (ARRAY[('android'::character varying)::text, ('ios'::character varying)::text])`),
]);

export const giverRequestAttempts = pgTable("giver_request_attempts", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	helpRequestId: uuid("help_request_id").notNull(),
	giverUserId: uuid("giver_user_id").notNull(),
	status: varchar({ length: 20 }).default('pending'),
	sentAt: timestamp("sent_at", { withTimezone: true, mode: 'string' }).defaultNow(),
	respondedAt: timestamp("responded_at", { withTimezone: true, mode: 'string' }),
	responseTimeSeconds: integer("response_time_seconds"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow(),
	notifiedAt: timestamp("notified_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("idx_giver_attempts_created").using("btree", table.createdAt.desc().nullsFirst().op("timestamptz_ops")),
	index("idx_giver_attempts_giver").using("btree", table.giverUserId.asc().nullsLast().op("uuid_ops")),
	index("idx_giver_attempts_help_request").using("btree", table.helpRequestId.asc().nullsLast().op("uuid_ops")),
	index("idx_giver_attempts_request").using("btree", table.helpRequestId.asc().nullsLast().op("uuid_ops")),
	index("idx_giver_attempts_request_status").using("btree", table.helpRequestId.asc().nullsLast().op("uuid_ops"), table.status.asc().nullsLast().op("text_ops")),
	index("idx_giver_attempts_status").using("btree", table.status.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.giverUserId],
			foreignColumns: [profiles.id],
			name: "giver_request_attempts_giver_user_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.helpRequestId],
			foreignColumns: [helpRequests.id],
			name: "giver_request_attempts_help_request_id_fkey"
		}).onDelete("cascade"),
	unique("unique_request_attempt").on(table.helpRequestId, table.giverUserId),
	pgPolicy("giver_attempts_view_own", { as: "permissive", for: "select", to: ["public"], using: sql`((auth.uid() = giver_user_id) OR (auth.uid() IN ( SELECT help_requests.receiver_user_id
   FROM help_requests
  WHERE (help_requests.id = giver_request_attempts.help_request_id))))` }),
	pgPolicy("giver_attempts_update", { as: "permissive", for: "update", to: ["public"] }),
	pgPolicy("giver_attempts_insert", { as: "permissive", for: "insert", to: ["public"] }),
	pgPolicy("System can insert giver request attempts", { as: "permissive", for: "insert", to: ["public"] }),
	pgPolicy("Givers can view requests sent to them", { as: "permissive", for: "select", to: ["public"] }),
	pgPolicy("Givers can update their own attempts", { as: "permissive", for: "update", to: ["public"] }),
	check("giver_request_attempts_status_check", sql`(status)::text = ANY (ARRAY[('pending'::character varying)::text, ('accepted'::character varying)::text, ('declined'::character varying)::text, ('expired'::character varying)::text])`),
]);

export const profiles = pgTable("profiles", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	email: text().notNull(),
	username: text().notNull(),
	firstName: text("first_name").notNull(),
	lastName: text("last_name").notNull(),
	age: integer().notNull(),
	gender: text().notNull(),
	phoneNumber: text("phone_number"),
	profilePhotoUrl: text("profile_photo_url"),
	passwordHash: text("password_hash").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow(),
	interests: text().array().default([""]).notNull(),
	needs: text().array().default([""]).notNull(),
	latitude: numeric({ precision: 10, scale:  8 }),
	longitude: numeric({ precision: 11, scale:  8 }),
	locationAddress: text("location_address"),
	locationCity: text("location_city"),
	locationCountry: text("location_country"),
	locationUpdatedAt: timestamp("location_updated_at", { withTimezone: true, mode: 'string' }),
	locationPreference: varchar("location_preference", { length: 50 }).default('nearby'),
	agePreference: varchar("age_preference", { length: 50 }).default('flexible'),
	friendshipLocationPriority: boolean("friendship_location_priority").default(true),
	relationshipDistanceFlexible: boolean("relationship_distance_flexible").default(true),
	preferencesUpdatedAt: timestamp("preferences_updated_at", { withTimezone: true, mode: 'string' }).defaultNow(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }),
	about: text().notNull(),
	circlePoints: integer("circle_points").default(100),
	totalMatches: integer("total_matches").default(0),
	messagesSent: integer("messages_sent").default(0),
	messagesReceived: integer("messages_received").default(0),
	profileVisitsReceived: integer("profile_visits_received").default(0),
	totalFriends: integer("total_friends").default(0),
	lastActive: timestamp("last_active", { mode: 'string' }).default(sql`CURRENT_TIMESTAMP`),
	statsUpdatedAt: timestamp("stats_updated_at", { mode: 'string' }).default(sql`CURRENT_TIMESTAMP`),
	totalCallsMade: integer("total_calls_made").default(0),
	totalCallsReceived: integer("total_calls_received").default(0),
	totalCallDurationSeconds: integer("total_call_duration_seconds").default(0),
	instagramUsername: text("instagram_username"),
	invisibleMode: boolean("invisible_mode").default(false).notNull(),
	lastSeen: timestamp("last_seen", { withTimezone: true, mode: 'string' }).defaultNow(),
	isSuspended: boolean("is_suspended").default(false),
	suspensionReason: text("suspension_reason"),
	suspensionEndsAt: timestamp("suspension_ends_at", { withTimezone: true, mode: 'string' }),
	suspendedAt: timestamp("suspended_at", { withTimezone: true, mode: 'string' }),
	suspendedBy: uuid("suspended_by"),
	deletedAt: timestamp("deleted_at", { withTimezone: true, mode: 'string' }),
	deletedBy: uuid("deleted_by"),
	deletionReason: text("deletion_reason"),
	deletionFeedback: text("deletion_feedback"),
	emailVerified: boolean("email_verified").default(false),
	emailVerifiedAt: timestamp("email_verified_at", { withTimezone: true, mode: 'string' }),
	subscriptionPlan: varchar("subscription_plan", { length: 20 }).default('free'),
	premiumExpiresAt: timestamp("premium_expires_at", { withTimezone: true, mode: 'string' }),
	isDeleted: boolean("is_deleted").default(false),
	verificationStatus: verificationStatus("verification_status").default('pending'),
	verifiedAt: timestamp("verified_at", { withTimezone: true, mode: 'string' }),
	verificationRequired: boolean("verification_required").default(true),
	isPremium: boolean("is_premium").default(false),
	subscriptionExpiresAt: timestamp("subscription_expires_at", { withTimezone: true, mode: 'string' }),
	role: text(),
	isAdmin: boolean("is_admin"),
}, (table) => [
	index("idx_profiles_about_search").using("gin", sql`to_tsvector('english'::regconfig, about)`).where(sql`((about IS NOT NULL) AND (length(about) > 0))`),
	index("idx_profiles_age").using("btree", table.age.asc().nullsLast().op("int4_ops")).where(sql`(age IS NOT NULL)`),
	index("idx_profiles_age_preference").using("btree", table.agePreference.asc().nullsLast().op("text_ops")),
	index("idx_profiles_circle_points").using("btree", table.circlePoints.asc().nullsLast().op("int4_ops")),
	index("idx_profiles_created_at").using("btree", table.createdAt.desc().nullsFirst().op("timestamptz_ops")),
	index("idx_profiles_deleted_at").using("btree", table.deletedAt.asc().nullsLast().op("timestamptz_ops")),
	index("idx_profiles_email").using("btree", table.email.asc().nullsLast().op("text_ops")),
	index("idx_profiles_email_ilike").using("btree", table.email.asc().nullsLast().op("text_pattern_ops")),
	index("idx_profiles_explore_filter").using("btree", table.id.asc().nullsLast().op("timestamptz_ops"), table.firstName.asc().nullsLast().op("timestamptz_ops"), table.lastName.asc().nullsLast().op("timestamptz_ops"), table.updatedAt.asc().nullsLast().op("timestamptz_ops")).where(sql`((first_name IS NOT NULL) AND (last_name IS NOT NULL))`),
	index("idx_profiles_first_name").using("btree", table.firstName.asc().nullsLast().op("text_ops")),
	index("idx_profiles_first_name_ilike").using("btree", table.firstName.asc().nullsLast().op("text_pattern_ops")),
	index("idx_profiles_friendship_location_priority").using("btree", table.friendshipLocationPriority.asc().nullsLast().op("bool_ops")),
	index("idx_profiles_fulltext_search").using("gin", sql`to_tsvector('english'::regconfig, ((((((COALESCE(first_name, ''`),
	index("idx_profiles_gender").using("btree", table.gender.asc().nullsLast().op("text_ops")).where(sql`(gender IS NOT NULL)`),
	index("idx_profiles_instagram_username").using("btree", table.instagramUsername.asc().nullsLast().op("text_ops")).where(sql`(instagram_username IS NOT NULL)`),
	index("idx_profiles_interests_gin").using("gin", table.interests.asc().nullsLast().op("array_ops")),
	index("idx_profiles_invisible_mode").using("btree", table.invisibleMode.asc().nullsLast().op("bool_ops")).where(sql`(invisible_mode = false)`),
	index("idx_profiles_is_deleted").using("btree", table.isDeleted.asc().nullsLast().op("bool_ops")),
	index("idx_profiles_is_suspended").using("btree", table.isSuspended.asc().nullsLast().op("bool_ops")),
	index("idx_profiles_last_active").using("btree", table.lastActive.asc().nullsLast().op("timestamp_ops")),
	index("idx_profiles_last_name").using("btree", table.lastName.asc().nullsLast().op("text_ops")),
	index("idx_profiles_last_name_ilike").using("btree", table.lastName.asc().nullsLast().op("text_pattern_ops")),
	index("idx_profiles_last_seen").using("btree", table.lastSeen.asc().nullsLast().op("timestamptz_ops")),
	index("idx_profiles_location").using("btree", table.latitude.asc().nullsLast().op("numeric_ops"), table.longitude.asc().nullsLast().op("numeric_ops")),
	index("idx_profiles_location_preference").using("btree", table.locationPreference.asc().nullsLast().op("text_ops")),
	index("idx_profiles_location_updated").using("btree", table.locationUpdatedAt.asc().nullsLast().op("timestamptz_ops")),
	index("idx_profiles_needs_gin").using("gin", table.needs.asc().nullsLast().op("array_ops")),
	index("idx_profiles_recent_users").using("btree", table.createdAt.desc().nullsFirst().op("text_ops"), table.firstName.asc().nullsLast().op("text_ops"), table.lastName.asc().nullsLast().op("text_ops")).where(sql`((first_name IS NOT NULL) AND (last_name IS NOT NULL))`),
	index("idx_profiles_relationship_distance_flexible").using("btree", table.relationshipDistanceFlexible.asc().nullsLast().op("bool_ops")),
	index("idx_profiles_updated_at").using("btree", table.updatedAt.desc().nullsFirst().op("timestamptz_ops")),
	index("idx_profiles_username").using("btree", table.username.asc().nullsLast().op("text_ops")),
	index("idx_profiles_username_ilike").using("btree", table.username.asc().nullsLast().op("text_pattern_ops")),
	uniqueIndex("idx_profiles_username_unique_ci").using("btree", sql`lower(username)`),
	index("idx_profiles_verification_status").using("btree", table.verificationStatus.asc().nullsLast().op("enum_ops")),
	uniqueIndex("ux_profiles_email_lower").using("btree", sql`lower(email)`),
	uniqueIndex("ux_profiles_username_lower").using("btree", sql`lower(username)`),
	foreignKey({
			columns: [table.deletedBy],
			foreignColumns: [table.id],
			name: "profiles_deleted_by_fkey"
		}),
	foreignKey({
			columns: [table.suspendedBy],
			foreignColumns: [table.id],
			name: "profiles_suspended_by_fkey"
		}),
	pgPolicy("Users can view others location", { as: "permissive", for: "select", to: ["public"], using: sql`true` }),
	pgPolicy("Users can update own location", { as: "permissive", for: "update", to: ["public"] }),
	check("check_about_length", sql`(about IS NULL) OR (length(about) <= 500)`),
	check("profiles_age_check", sql`(age >= 13) AND (age <= 120)`),
	check("profiles_subscription_plan_check", sql`(subscription_plan)::text = ANY (ARRAY[('free'::character varying)::text, ('premium'::character varying)::text, ('premium_plus'::character varying)::text])`),
]);

export const announcements = pgTable("announcements", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	title: text(),
	message: text().notNull(),
	imageUrl: text("image_url"),
	linkUrl: text("link_url"),
	buttons: jsonb(),
	placements: text().array(),
	audience: text().default('all'),
	countries: text().array(),
	minAppVersion: text("min_app_version"),
	priority: integer().default(0),
	startsAt: timestamp("starts_at", { withTimezone: true, mode: 'string' }),
	endsAt: timestamp("ends_at", { withTimezone: true, mode: 'string' }),
	isActive: boolean("is_active").default(true),
	sendPushOnPublish: boolean("send_push_on_publish").default(false),
	createdBy: uuid("created_by"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow(),
	publishedAt: timestamp("published_at", { withTimezone: true, mode: 'string' }),
}, (table) => [
	index("idx_announcements_active_window").using("btree", table.isActive.asc().nullsLast().op("timestamptz_ops"), table.startsAt.asc().nullsLast().op("timestamptz_ops"), table.endsAt.asc().nullsLast().op("timestamptz_ops")),
	index("idx_announcements_priority").using("btree", table.priority.desc().nullsFirst().op("int4_ops"), table.publishedAt.desc().nullsLast().op("int4_ops"), table.createdAt.desc().nullsFirst().op("int4_ops")),
]);

export const appVersions = pgTable("app_versions", {
	id: bigserial({ mode: "bigint" }).primaryKey().notNull(),
	userId: uuid("user_id"),
	version: varchar({ length: 20 }).notNull(),
	buildNumber: varchar("build_number", { length: 20 }).notNull(),
	platform: varchar({ length: 20 }).notNull(),
	expoVersion: varchar("expo_version", { length: 20 }),
	deviceId: varchar("device_id", { length: 100 }),
	deviceName: varchar("device_name", { length: 200 }),
	deviceModel: varchar("device_model", { length: 100 }),
	osVersion: varchar("os_version", { length: 50 }),
	timestamp: timestamp({ withTimezone: true, mode: 'string' }).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow(),
}, (table) => [
	index("idx_app_versions_created_at").using("btree", table.createdAt.asc().nullsLast().op("timestamptz_ops")),
	index("idx_app_versions_device_id").using("btree", table.deviceId.asc().nullsLast().op("text_ops")),
	index("idx_app_versions_platform").using("btree", table.platform.asc().nullsLast().op("text_ops")),
	index("idx_app_versions_user_id").using("btree", table.userId.asc().nullsLast().op("uuid_ops")),
	index("idx_app_versions_version").using("btree", table.version.asc().nullsLast().op("text_ops")),
	index("idx_app_versions_version_platform").using("btree", table.version.asc().nullsLast().op("text_ops"), table.platform.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.userId],
			foreignColumns: [profiles.id],
			name: "app_versions_user_id_fkey"
		}).onDelete("set null"),
	pgPolicy("Users can view their own app versions", { as: "permissive", for: "select", to: ["public"], using: sql`(auth.uid() = user_id)` }),
	pgPolicy("Service role can manage all app versions", { as: "permissive", for: "all", to: ["public"] }),
	check("app_versions_platform_check", sql`(platform)::text = ANY (ARRAY[('ios'::character varying)::text, ('android'::character varying)::text, ('web'::character varying)::text])`),
]);

export const agentCapabilities = pgTable("agent_capabilities", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	agentId: varchar("agent_id", { length: 100 }).notNull(),
	name: varchar({ length: 200 }).notNull(),
	languages: text().array().default(["RAY['en'::tex"]),
	specialties: text().array().default(["RAY['general_support'::tex"]),
	currentLoad: integer("current_load").default(0),
	maxLoad: integer("max_load").default(5),
	availability: varchar({ length: 20 }).default('offline'),
	rating: numeric({ precision: 3, scale:  2 }).default('0.0'),
	responseTime: integer("response_time").default(5),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow(),
}, (table) => [
	unique("agent_capabilities_agent_id_key").on(table.agentId),
	check("agent_capabilities_availability_check", sql`(availability)::text = ANY (ARRAY[('available'::character varying)::text, ('busy'::character varying)::text, ('offline'::character varying)::text])`),
]);

export const crashReports = pgTable("crash_reports", {
	id: bigserial({ mode: "bigint" }).primaryKey().notNull(),
	crashId: varchar("crash_id", { length: 100 }).notNull(),
	userId: uuid("user_id"),
	sessionId: varchar("session_id", { length: 100 }),
	timestamp: timestamp({ withTimezone: true, mode: 'string' }).notNull(),
	type: varchar({ length: 50 }).notNull(),
	isFatal: boolean("is_fatal").default(false),
	errorName: varchar("error_name", { length: 200 }).notNull(),
	errorMessage: text("error_message").notNull(),
	errorStack: text("error_stack"),
	devicePlatform: varchar("device_platform", { length: 20 }).notNull(),
	deviceVersion: varchar("device_version", { length: 50 }),
	deviceModel: varchar("device_model", { length: 100 }),
	deviceName: varchar("device_name", { length: 200 }),
	appVersion: varchar("app_version", { length: 20 }).notNull(),
	buildNumber: varchar("build_number", { length: 20 }).notNull(),
	expoVersion: varchar("expo_version", { length: 20 }),
	isDevice: boolean("is_device").default(true),
	breadcrumbs: jsonb().default([]),
	userContext: jsonb("user_context").default({}),
	resolved: boolean().default(false),
	resolvedAt: timestamp("resolved_at", { withTimezone: true, mode: 'string' }),
	resolvedBy: uuid("resolved_by"),
	notes: text(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow(),
}, (table) => [
	index("idx_crash_reports_app_version").using("btree", table.appVersion.asc().nullsLast().op("text_ops")),
	index("idx_crash_reports_breadcrumbs").using("gin", table.breadcrumbs.asc().nullsLast().op("jsonb_ops")),
	index("idx_crash_reports_crash_id").using("btree", table.crashId.asc().nullsLast().op("text_ops")),
	index("idx_crash_reports_created_at").using("btree", table.createdAt.asc().nullsLast().op("timestamptz_ops")),
	index("idx_crash_reports_device_platform").using("btree", table.devicePlatform.asc().nullsLast().op("text_ops")),
	index("idx_crash_reports_is_fatal").using("btree", table.isFatal.asc().nullsLast().op("bool_ops")),
	index("idx_crash_reports_resolved").using("btree", table.resolved.asc().nullsLast().op("bool_ops")),
	index("idx_crash_reports_session_id").using("btree", table.sessionId.asc().nullsLast().op("text_ops")),
	index("idx_crash_reports_timestamp").using("btree", table.timestamp.asc().nullsLast().op("timestamptz_ops")),
	index("idx_crash_reports_type").using("btree", table.type.asc().nullsLast().op("text_ops")),
	index("idx_crash_reports_user_context").using("gin", table.userContext.asc().nullsLast().op("jsonb_ops")),
	index("idx_crash_reports_user_id").using("btree", table.userId.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.resolvedBy],
			foreignColumns: [profiles.id],
			name: "crash_reports_resolved_by_fkey"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.userId],
			foreignColumns: [profiles.id],
			name: "crash_reports_user_id_fkey"
		}).onDelete("set null"),
	unique("crash_reports_crash_id_key").on(table.crashId),
	pgPolicy("Users can view their own crash reports", { as: "permissive", for: "select", to: ["public"], using: sql`(auth.uid() = user_id)` }),
	pgPolicy("Service role can manage all crash reports", { as: "permissive", for: "all", to: ["public"] }),
]);

export const blindDateDailyQueue = pgTable("blind_date_daily_queue", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	userId: uuid("user_id").notNull(),
	scheduledDate: date("scheduled_date").notNull(),
	matchedUserId: uuid("matched_user_id"),
	matchId: uuid("match_id"),
	status: varchar({ length: 20 }).default('pending'),
	processedAt: timestamp("processed_at", { withTimezone: true, mode: 'string' }),
	errorMessage: text("error_message"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow(),
}, (table) => [
	index("idx_blind_date_daily_queue_date").using("btree", table.scheduledDate.asc().nullsLast().op("date_ops"), table.status.asc().nullsLast().op("date_ops")),
	index("idx_blind_date_daily_queue_user").using("btree", table.userId.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.matchId],
			foreignColumns: [blindDateMatches.id],
			name: "blind_date_daily_queue_match_id_fkey"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.matchedUserId],
			foreignColumns: [profiles.id],
			name: "blind_date_daily_queue_matched_user_id_fkey"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.userId],
			foreignColumns: [profiles.id],
			name: "blind_date_daily_queue_user_id_fkey"
		}).onDelete("cascade"),
	unique("blind_date_daily_queue_user_id_scheduled_date_key").on(table.userId, table.scheduledDate),
	check("blind_date_daily_queue_status_check", sql`(status)::text = ANY (ARRAY[('pending'::character varying)::text, ('matched'::character varying)::text, ('no_match'::character varying)::text, ('skipped'::character varying)::text, ('error'::character varying)::text])`),
]);

export const dailyMatchLimits = pgTable("daily_match_limits", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	userId: uuid("user_id").notNull(),
	date: date().default(sql`CURRENT_DATE`).notNull(),
	matchesMade: integer("matches_made").default(0).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("idx_daily_match_limits_user_date").using("btree", table.userId.asc().nullsLast().op("date_ops"), table.date.asc().nullsLast().op("date_ops")),
	foreignKey({
			columns: [table.userId],
			foreignColumns: [profiles.id],
			name: "daily_match_limits_user_id_fkey"
		}).onDelete("cascade"),
	unique("daily_match_limits_user_id_date_key").on(table.userId, table.date),
]);

export const chats = pgTable("chats", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	lastMessageAt: timestamp("last_message_at", { withTimezone: true, mode: 'string' }),
	messagePermission: varchar("message_permission", { length: 20 }).default('friends_only'),
	isMessageRequest: boolean("is_message_request").default(false),
}, (table) => [
	check("chats_message_permission_check", sql`(message_permission)::text = ANY (ARRAY[('everyone'::character varying)::text, ('friends_only'::character varying)::text, ('blocked'::character varying)::text])`),
]);

export const blindDatingSettings = pgTable("blind_dating_settings", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	userId: uuid("user_id").notNull(),
	isEnabled: boolean("is_enabled").default(false),
	dailyMatchTime: time("daily_match_time").default('09:00:00'),
	maxActiveMatches: integer("max_active_matches").default(3),
	preferredRevealThreshold: integer("preferred_reveal_threshold").default(30),
	autoMatch: boolean("auto_match").default(true),
	notificationsEnabled: boolean("notifications_enabled").default(true),
	lastMatchAt: timestamp("last_match_at", { withTimezone: true, mode: 'string' }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow(),
}, (table) => [
	index("idx_blind_dating_settings_enabled").using("btree", table.isEnabled.asc().nullsLast().op("bool_ops")).where(sql`(is_enabled = true)`),
	index("idx_blind_dating_settings_user").using("btree", table.userId.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.userId],
			foreignColumns: [profiles.id],
			name: "blind_dating_settings_user_id_fkey"
		}).onDelete("cascade"),
	unique("blind_dating_settings_user_id_key").on(table.userId),
]);

export const chatMuteSettings = pgTable("chat_mute_settings", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	userId: uuid("user_id").notNull(),
	chatId: uuid("chat_id").notNull(),
	isMuted: boolean("is_muted").default(false),
	mutedUntil: timestamp("muted_until", { withTimezone: true, mode: 'string' }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow(),
}, (table) => [
	index("idx_chat_mute_settings_chat_id").using("btree", table.chatId.asc().nullsLast().op("uuid_ops")),
	index("idx_chat_mute_settings_user_chat").using("btree", table.userId.asc().nullsLast().op("uuid_ops"), table.chatId.asc().nullsLast().op("uuid_ops")),
	index("idx_chat_mute_settings_user_id").using("btree", table.userId.asc().nullsLast().op("uuid_ops")),
	unique("chat_mute_settings_user_id_chat_id_key").on(table.userId, table.chatId),
	pgPolicy("Users can view own mute settings", { as: "permissive", for: "select", to: ["public"], using: sql`(auth.uid() = user_id)` }),
	pgPolicy("Users can update own mute settings", { as: "permissive", for: "update", to: ["public"] }),
	pgPolicy("Users can insert own mute settings", { as: "permissive", for: "insert", to: ["public"] }),
	pgPolicy("Users can delete own mute settings", { as: "permissive", for: "delete", to: ["public"] }),
]);

export const chatUserSettings = pgTable("chat_user_settings", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	userId: uuid("user_id").notNull(),
	chatId: uuid("chat_id").notNull(),
	archived: boolean().default(false).notNull(),
	pinned: boolean().default(false).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("idx_chat_user_settings_chat").using("btree", table.chatId.asc().nullsLast().op("uuid_ops")),
	index("idx_chat_user_settings_user").using("btree", table.userId.asc().nullsLast().op("uuid_ops")),
	index("idx_chat_user_settings_user_archived").using("btree", table.userId.asc().nullsLast().op("bool_ops"), table.archived.asc().nullsLast().op("bool_ops")),
	index("idx_chat_user_settings_user_pinned").using("btree", table.userId.asc().nullsLast().op("bool_ops"), table.pinned.asc().nullsLast().op("bool_ops")),
	foreignKey({
			columns: [table.chatId],
			foreignColumns: [chats.id],
			name: "chat_user_settings_chat_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.userId],
			foreignColumns: [profiles.id],
			name: "chat_user_settings_user_id_fkey"
		}).onDelete("cascade"),
	unique("chat_user_settings_user_id_chat_id_key").on(table.userId, table.chatId),
	pgPolicy("chat_user_settings_update", { as: "permissive", for: "update", to: ["public"], using: sql`(user_id = auth.uid())`, withCheck: sql`(user_id = auth.uid())`  }),
	pgPolicy("chat_user_settings_select", { as: "permissive", for: "select", to: ["public"] }),
	pgPolicy("chat_user_settings_insert", { as: "permissive", for: "insert", to: ["public"] }),
	pgPolicy("chat_user_settings_delete", { as: "permissive", for: "delete", to: ["public"] }),
]);

export const campaignAnalytics = pgTable("campaign_analytics", {
	id: uuid().default(sql`extensions.uuid_generate_v4()`).primaryKey().notNull(),
	campaignId: uuid("campaign_id"),
	totalSent: integer("total_sent").default(0),
	delivered: integer().default(0),
	opened: integer().default(0),
	clicked: integer().default(0),
	converted: integer().default(0),
	unsubscribed: integer().default(0),
	bounced: integer().default(0),
	failed: integer().default(0),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow(),
}, (table) => [
	index("idx_campaign_analytics_campaign_id").using("btree", table.campaignId.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.campaignId],
			foreignColumns: [marketingCampaigns.id],
			name: "campaign_analytics_campaign_id_fkey"
		}).onDelete("cascade"),
	unique("campaign_analytics_campaign_id_key").on(table.campaignId),
]);

export const conversationAnalytics = pgTable("conversation_analytics", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	date: date().notNull(),
	totalConversations: integer("total_conversations").default(0),
	resolvedConversations: integer("resolved_conversations").default(0),
	escalatedConversations: integer("escalated_conversations").default(0),
	averageSatisfaction: numeric("average_satisfaction", { precision: 3, scale:  2 }).default('0.0'),
	averageResponseTime: integer("average_response_time").default(0),
	totalCost: numeric("total_cost", { precision: 10, scale:  2 }).default('0.0'),
	aiEfficiencyScore: integer("ai_efficiency_score").default(0),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow(),
}, (table) => [
	unique("conversation_analytics_date_key").on(table.date),
]);

export const emailOtps = pgTable("email_otps", {
	id: uuid().default(sql`extensions.uuid_generate_v4()`).primaryKey().notNull(),
	email: text().notNull(),
	otp: text().notNull(),
	expiresAt: timestamp("expires_at", { withTimezone: true, mode: 'string' }).notNull(),
	attempts: integer().default(0),
	verified: boolean().default(false),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow(),
	verifiedAt: timestamp("verified_at", { withTimezone: true, mode: 'string' }),
}, (table) => [
	index("idx_email_otps_email").using("btree", table.email.asc().nullsLast().op("text_ops")),
	index("idx_email_otps_expires_at").using("btree", table.expiresAt.asc().nullsLast().op("timestamptz_ops")),
	uniqueIndex("idx_email_otps_unique_active").using("btree", table.email.asc().nullsLast().op("text_ops")).where(sql`(verified = false)`),
	index("idx_email_otps_verified").using("btree", table.verified.asc().nullsLast().op("bool_ops")),
	index("idx_email_otps_verified_at").using("btree", table.verifiedAt.asc().nullsLast().op("timestamptz_ops")),
	pgPolicy("email_otps_user_policy", { as: "permissive", for: "all", to: ["public"], using: sql`(email = (auth.jwt() ->> 'email'::text))` }),
	pgPolicy("email_otps_service_policy", { as: "permissive", for: "all", to: ["public"] }),
]);

export const escalationLogs = pgTable("escalation_logs", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	conversationId: varchar("conversation_id"),
	userId: uuid("user_id"),
	escalationReason: text("escalation_reason").notNull(),
	priority: varchar({ length: 20 }).notNull(),
	sentimentScore: numeric("sentiment_score", { precision: 3, scale:  2 }),
	assignedAgent: varchar("assigned_agent", { length: 100 }),
	resolvedAt: timestamp("resolved_at", { withTimezone: true, mode: 'string' }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow(),
}, (table) => [
	index("idx_escalation_logs_conversation_id").using("btree", table.conversationId.asc().nullsLast().op("text_ops")),
	index("idx_escalation_logs_created_at").using("btree", table.createdAt.asc().nullsLast().op("timestamptz_ops")),
	index("idx_escalation_logs_priority").using("btree", table.priority.asc().nullsLast().op("text_ops")),
	index("idx_escalation_logs_user_id").using("btree", table.userId.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.conversationId],
			foreignColumns: [aiConversations.id],
			name: "escalation_logs_conversation_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.userId],
			foreignColumns: [profiles.id],
			name: "escalation_logs_user_id_fkey"
		}).onDelete("cascade"),
	check("escalation_logs_priority_check", sql`(priority)::text = ANY (ARRAY[('low'::character varying)::text, ('medium'::character varying)::text, ('high'::character varying)::text, ('critical'::character varying)::text])`),
]);

export const exploreCacheStats = pgTable("explore_cache_stats", {
	id: serial().primaryKey().notNull(),
	cacheKey: varchar("cache_key", { length: 255 }).notNull(),
	userId: uuid("user_id").notNull(),
	endpoint: varchar({ length: 100 }).notNull(),
	hitCount: integer("hit_count").default(0),
	lastHit: timestamp("last_hit", { mode: 'string' }).default(sql`CURRENT_TIMESTAMP`),
	createdAt: timestamp("created_at", { mode: 'string' }).default(sql`CURRENT_TIMESTAMP`),
	expiresAt: timestamp("expires_at", { mode: 'string' }).notNull(),
}, (table) => [
	index("idx_cache_stats_cache_key").using("btree", table.cacheKey.asc().nullsLast().op("text_ops")),
	index("idx_cache_stats_expires").using("btree", table.expiresAt.asc().nullsLast().op("timestamp_ops")),
	index("idx_cache_stats_user_endpoint").using("btree", table.userId.asc().nullsLast().op("text_ops"), table.endpoint.asc().nullsLast().op("text_ops")),
]);

export const betaTesters = pgTable("beta_testers", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	fullName: text("full_name").notNull(),
	email: text().notNull(),
	phone: text().notNull(),
	age: integer().notNull(),
	gender: text().notNull(),
	location: text().notNull(),
	deviceType: text("device_type").notNull(),
	deviceModel: text("device_model").notNull(),
	androidVersion: text("android_version"),
	iosVersion: text("ios_version"),
	occupation: text().notNull(),
	testingExperience: text("testing_experience").notNull(),
	availability: text().notNull(),
	motivation: text().notNull(),
	socialMediaHandle: text("social_media_handle"),
	referralSource: text("referral_source"),
	status: text().default('pending').notNull(),
	rejectionReason: text("rejection_reason"),
	playConsoleAdded: boolean("play_console_added").default(false),
	appliedAt: timestamp("applied_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	approvedAt: timestamp("approved_at", { withTimezone: true, mode: 'string' }),
	rejectedAt: timestamp("rejected_at", { withTimezone: true, mode: 'string' }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("idx_beta_testers_applied_at").using("btree", table.appliedAt.desc().nullsFirst().op("timestamptz_ops")),
	index("idx_beta_testers_device_type").using("btree", table.deviceType.asc().nullsLast().op("text_ops")),
	index("idx_beta_testers_email").using("btree", table.email.asc().nullsLast().op("text_ops")),
	index("idx_beta_testers_status").using("btree", table.status.asc().nullsLast().op("text_ops")),
	unique("beta_testers_email_key").on(table.email),
	pgPolicy("beta_testers_update_policy", { as: "permissive", for: "update", to: ["public"], using: sql`((auth.role() = 'authenticated'::text) AND (EXISTS ( SELECT 1
   FROM profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.role = 'admin'::text)))))` }),
	pgPolicy("beta_testers_select_policy", { as: "permissive", for: "select", to: ["public"] }),
	pgPolicy("beta_testers_insert_policy", { as: "permissive", for: "insert", to: ["public"] }),
	check("beta_testers_age_check", sql`(age >= 18) AND (age <= 100)`),
	check("beta_testers_device_type_check", sql`device_type = ANY (ARRAY['android'::text, 'ios'::text])`),
	check("beta_testers_gender_check", sql`gender = ANY (ARRAY['male'::text, 'female'::text, 'other'::text])`),
	check("beta_testers_status_check", sql`status = ANY (ARRAY['pending'::text, 'approved'::text, 'rejected'::text])`),
]);

export const blocks = pgTable("blocks", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	blockerId: uuid("blocker_id").notNull(),
	blockedId: uuid("blocked_id").notNull(),
	reason: text(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow(),
}, (table) => [
	index("idx_blocks_blocked").using("btree", table.blockedId.asc().nullsLast().op("uuid_ops")),
	index("idx_blocks_blocker").using("btree", table.blockerId.asc().nullsLast().op("uuid_ops")),
	index("idx_blocks_both_users").using("btree", table.blockerId.asc().nullsLast().op("uuid_ops"), table.blockedId.asc().nullsLast().op("uuid_ops")),
	unique("blocks_blocker_id_blocked_id_key").on(table.blockerId, table.blockedId),
	pgPolicy("Users can view their own blocks", { as: "permissive", for: "select", to: ["public"], using: sql`((auth.uid())::text = (blocker_id)::text)` }),
	pgPolicy("Users can delete their own blocks", { as: "permissive", for: "delete", to: ["public"] }),
	pgPolicy("Users can create blocks", { as: "permissive", for: "insert", to: ["public"] }),
	check("blocks_check", sql`blocker_id <> blocked_id`),
]);

export const blindDateMatches = pgTable("blind_date_matches", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	userA: uuid("user_a").notNull(),
	userB: uuid("user_b").notNull(),
	chatId: uuid("chat_id"),
	compatibilityScore: numeric("compatibility_score", { precision: 5, scale:  2 }),
	status: varchar({ length: 20 }).default('active'),
	messageCount: integer("message_count").default(0),
	revealThreshold: integer("reveal_threshold").default(30),
	userARevealed: boolean("user_a_revealed").default(false),
	userBRevealed: boolean("user_b_revealed").default(false),
	revealedAt: timestamp("revealed_at", { withTimezone: true, mode: 'string' }),
	revealRequestedBy: uuid("reveal_requested_by"),
	revealRequestedAt: timestamp("reveal_requested_at", { withTimezone: true, mode: 'string' }),
	matchedAt: timestamp("matched_at", { withTimezone: true, mode: 'string' }).defaultNow(),
	endedAt: timestamp("ended_at", { withTimezone: true, mode: 'string' }),
	endedBy: uuid("ended_by"),
	endReason: varchar("end_reason", { length: 50 }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow(),
	reminderSentAt: timestamp("reminder_sent_at", { withTimezone: true, mode: 'string' }),
}, (table) => [
	index("idx_blind_date_matches_chat").using("btree", table.chatId.asc().nullsLast().op("uuid_ops")),
	index("idx_blind_date_matches_status").using("btree", table.status.asc().nullsLast().op("text_ops")),
	index("idx_blind_date_matches_users").using("btree", table.userA.asc().nullsLast().op("uuid_ops"), table.userB.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.chatId],
			foreignColumns: [chats.id],
			name: "blind_date_matches_chat_id_fkey"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.endedBy],
			foreignColumns: [profiles.id],
			name: "blind_date_matches_ended_by_fkey"
		}),
	foreignKey({
			columns: [table.revealRequestedBy],
			foreignColumns: [profiles.id],
			name: "blind_date_matches_reveal_requested_by_fkey"
		}),
	foreignKey({
			columns: [table.userA],
			foreignColumns: [profiles.id],
			name: "blind_date_matches_user_a_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.userB],
			foreignColumns: [profiles.id],
			name: "blind_date_matches_user_b_fkey"
		}).onDelete("cascade"),
	unique("blind_date_matches_user_a_user_b_status_key").on(table.userA, table.userB, table.status),
	check("blind_date_matches_status_check", sql`(status)::text = ANY (ARRAY[('active'::character varying)::text, ('revealed'::character varying)::text, ('ended'::character varying)::text, ('expired'::character varying)::text, ('blocked'::character varying)::text])`),
	check("unique_blind_date_pair", sql`user_a < user_b`),
]);

export const chatDeletions = pgTable("chat_deletions", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	chatId: uuid("chat_id").notNull(),
	userId: uuid("user_id").notNull(),
	deletedAt: timestamp("deleted_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("idx_chat_deletions_chat_id").using("btree", table.chatId.asc().nullsLast().op("uuid_ops")),
	index("idx_chat_deletions_deleted_at").using("btree", table.deletedAt.asc().nullsLast().op("timestamptz_ops")),
	index("idx_chat_deletions_user_id").using("btree", table.userId.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.chatId],
			foreignColumns: [chats.id],
			name: "chat_deletions_chat_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.userId],
			foreignColumns: [profiles.id],
			name: "chat_deletions_user_id_fkey"
		}).onDelete("cascade"),
	unique("chat_deletions_chat_id_user_id_key").on(table.chatId, table.userId),
]);

export const emailTemplates = pgTable("email_templates", {
	id: uuid().default(sql`extensions.uuid_generate_v4()`).primaryKey().notNull(),
	name: text().notNull(),
	subject: text().notNull(),
	htmlContent: text("html_content").notNull(),
	textContent: text("text_content"),
	category: text(),
	variables: jsonb(),
	previewText: text("preview_text"),
	createdBy: uuid("created_by"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow(),
}, (table) => [
	index("idx_email_templates_category").using("btree", table.category.asc().nullsLast().op("text_ops")),
	index("idx_email_templates_created_by").using("btree", table.createdBy.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.createdBy],
			foreignColumns: [profiles.id],
			name: "email_templates_created_by_fkey"
		}),
	check("email_templates_category_check", sql`category = ANY (ARRAY['welcome'::text, 'engagement'::text, 're-engagement'::text, 'promotional'::text, 'transactional'::text])`),
]);

export const featureUsage = pgTable("feature_usage", {
	id: bigserial({ mode: "bigint" }).primaryKey().notNull(),
	userId: uuid("user_id"),
	featureName: varchar("feature_name", { length: 100 }).notNull(),
	firstUsedAt: timestamp("first_used_at", { withTimezone: true, mode: 'string' }).notNull(),
	lastUsedAt: timestamp("last_used_at", { withTimezone: true, mode: 'string' }).notNull(),
	usageCount: integer("usage_count").default(1),
	totalTimeSeconds: integer("total_time_seconds").default(0),
	featureData: jsonb("feature_data").default({}),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow(),
}, (table) => [
	index("idx_feature_usage_feature_name").using("btree", table.featureName.asc().nullsLast().op("text_ops")),
	index("idx_feature_usage_last_used_at").using("btree", table.lastUsedAt.asc().nullsLast().op("timestamptz_ops")),
	index("idx_feature_usage_user_id").using("btree", table.userId.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.userId],
			foreignColumns: [profiles.id],
			name: "feature_usage_user_id_fkey"
		}).onDelete("cascade"),
	unique("feature_usage_user_id_feature_name_key").on(table.userId, table.featureName),
	pgPolicy("Users can view their own feature usage", { as: "permissive", for: "select", to: ["public"], using: sql`(auth.uid() = user_id)` }),
	pgPolicy("Service role can manage all feature usage", { as: "permissive", for: "all", to: ["public"] }),
]);

export const giverProfiles = pgTable("giver_profiles", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	userId: uuid("user_id").notNull(),
	isAvailable: boolean("is_available").default(true),
	skills: text().array(),
	interests: text().array(),
	bio: text(),
	categories: text().array(),
	profileEmbedding: vector("profile_embedding", { dimensions: 1536 }),
	totalHelpsGiven: integer("total_helps_given").default(0),
	averageRating: numeric("average_rating", { precision: 3, scale:  2 }).default('0.00'),
	lastActiveAt: timestamp("last_active_at", { withTimezone: true, mode: 'string' }).defaultNow(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow(),
}, (table) => [
	index("idx_giver_profiles_available").using("btree", table.isAvailable.asc().nullsLast().op("bool_ops")).where(sql`(is_available = true)`),
	index("idx_giver_profiles_categories").using("gin", table.categories.asc().nullsLast().op("array_ops")),
	index("idx_giver_profiles_embedding").using("ivfflat", table.profileEmbedding.asc().nullsLast().op("vector_cosine_ops")).with({lists: "100"}),
	index("idx_giver_profiles_skills").using("gin", table.skills.asc().nullsLast().op("array_ops")),
	index("idx_giver_profiles_user_id").using("btree", table.userId.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.userId],
			foreignColumns: [profiles.id],
			name: "giver_profiles_user_id_fkey"
		}).onDelete("cascade"),
	unique("unique_giver_profile").on(table.userId),
	pgPolicy("Users can view all giver profiles", { as: "permissive", for: "select", to: ["public"], using: sql`true` }),
	pgPolicy("Users can update their own giver profile", { as: "permissive", for: "update", to: ["public"] }),
	pgPolicy("Users can insert their own giver profile", { as: "permissive", for: "insert", to: ["public"] }),
	pgPolicy("Users can delete their own giver profile", { as: "permissive", for: "delete", to: ["public"] }),
]);

export const followUpTasks = pgTable("follow_up_tasks", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	conversationId: varchar("conversation_id"),
	userId: uuid("user_id"),
	urgency: varchar({ length: 20 }).notNull(),
	reason: text().notNull(),
	actionItems: jsonb("action_items"),
	scheduledFor: timestamp("scheduled_for", { withTimezone: true, mode: 'string' }).notNull(),
	completedAt: timestamp("completed_at", { withTimezone: true, mode: 'string' }),
	assignedTo: varchar("assigned_to", { length: 100 }),
	status: varchar({ length: 20 }).default('pending'),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow(),
}, (table) => [
	index("idx_follow_up_tasks_scheduled_for").using("btree", table.scheduledFor.asc().nullsLast().op("timestamptz_ops")),
	index("idx_follow_up_tasks_status").using("btree", table.status.asc().nullsLast().op("text_ops")),
	index("idx_follow_up_tasks_user_id").using("btree", table.userId.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.conversationId],
			foreignColumns: [aiConversations.id],
			name: "follow_up_tasks_conversation_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.userId],
			foreignColumns: [profiles.id],
			name: "follow_up_tasks_user_id_fkey"
		}).onDelete("cascade"),
	check("follow_up_tasks_status_check", sql`(status)::text = ANY (ARRAY[('pending'::character varying)::text, ('in_progress'::character varying)::text, ('completed'::character varying)::text, ('cancelled'::character varying)::text])`),
	check("follow_up_tasks_urgency_check", sql`(urgency)::text = ANY (ARRAY[('low'::character varying)::text, ('medium'::character varying)::text, ('high'::character varying)::text])`),
]);

export const feedbackAnalysis = pgTable("feedback_analysis", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	conversationId: varchar("conversation_id"),
	sentiment: varchar({ length: 20 }).notNull(),
	themes: jsonb(),
	actionItems: jsonb("action_items"),
	urgency: varchar({ length: 20 }).notNull(),
	followUpRequired: boolean("follow_up_required").default(false),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow(),
}, (table) => [
	foreignKey({
			columns: [table.conversationId],
			foreignColumns: [aiConversations.id],
			name: "feedback_analysis_conversation_id_fkey"
		}).onDelete("cascade"),
	check("feedback_analysis_sentiment_check", sql`(sentiment)::text = ANY (ARRAY[('positive'::character varying)::text, ('negative'::character varying)::text, ('neutral'::character varying)::text])`),
	check("feedback_analysis_urgency_check", sql`(urgency)::text = ANY (ARRAY[('low'::character varying)::text, ('medium'::character varying)::text, ('high'::character varying)::text])`),
]);

export const friendLocationNotifications = pgTable("friend_location_notifications", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	fromUserId: uuid("from_user_id").notNull(),
	toUserId: uuid("to_user_id").notNull(),
	sentAt: timestamp("sent_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("idx_friend_location_notifications_from_user").using("btree", table.fromUserId.asc().nullsLast().op("uuid_ops")),
	index("idx_friend_location_notifications_sent_at").using("btree", table.sentAt.asc().nullsLast().op("timestamptz_ops")),
	index("idx_friend_location_notifications_to_user").using("btree", table.toUserId.asc().nullsLast().op("uuid_ops")),
	index("idx_friend_location_notifications_user_pair").using("btree", table.fromUserId.asc().nullsLast().op("uuid_ops"), table.toUserId.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.fromUserId],
			foreignColumns: [profiles.id],
			name: "friend_location_notifications_from_user_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.toUserId],
			foreignColumns: [profiles.id],
			name: "friend_location_notifications_to_user_id_fkey"
		}).onDelete("cascade"),
]);

export const marketingCampaigns = pgTable("marketing_campaigns", {
	id: uuid().default(sql`extensions.uuid_generate_v4()`).primaryKey().notNull(),
	name: text().notNull(),
	type: text().notNull(),
	status: text().default('draft'),
	subject: text(),
	content: text().notNull(),
	templateId: uuid("template_id"),
	segmentCriteria: jsonb("segment_criteria"),
	scheduledAt: timestamp("scheduled_at", { withTimezone: true, mode: 'string' }),
	sentAt: timestamp("sent_at", { withTimezone: true, mode: 'string' }),
	createdBy: uuid("created_by"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow(),
	pushTitle: text("push_title"),
	pushBody: text("push_body"),
}, (table) => [
	index("idx_campaigns_created_by").using("btree", table.createdBy.asc().nullsLast().op("uuid_ops")),
	index("idx_campaigns_scheduled_at").using("btree", table.scheduledAt.asc().nullsLast().op("timestamptz_ops")),
	index("idx_campaigns_status").using("btree", table.status.asc().nullsLast().op("text_ops")),
	index("idx_campaigns_type").using("btree", table.type.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.createdBy],
			foreignColumns: [profiles.id],
			name: "marketing_campaigns_created_by_fkey"
		}),
	check("marketing_campaigns_status_check", sql`status = ANY (ARRAY['draft'::text, 'scheduled'::text, 'sending'::text, 'sent'::text, 'paused'::text, 'cancelled'::text])`),
	check("marketing_campaigns_type_check", sql`type = ANY (ARRAY['push_notification'::text, 'email'::text, 'in_app'::text])`),
]);

export const helpSessionFeedback = pgTable("help_session_feedback", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	helpRequestId: uuid("help_request_id").notNull(),
	chatRoomId: uuid("chat_room_id"),
	receiverUserId: uuid("receiver_user_id").notNull(),
	giverUserId: uuid("giver_user_id").notNull(),
	receiverRating: integer("receiver_rating"),
	giverRating: integer("giver_rating"),
	receiverFeedback: text("receiver_feedback"),
	giverFeedback: text("giver_feedback"),
	wasHelpful: boolean("was_helpful"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow(),
}, (table) => [
	index("idx_feedback_giver").using("btree", table.giverUserId.asc().nullsLast().op("uuid_ops")),
	index("idx_feedback_receiver").using("btree", table.receiverUserId.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.chatRoomId],
			foreignColumns: [chats.id],
			name: "help_session_feedback_chat_room_id_fkey"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.giverUserId],
			foreignColumns: [profiles.id],
			name: "help_session_feedback_giver_user_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.helpRequestId],
			foreignColumns: [helpRequests.id],
			name: "help_session_feedback_help_request_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.receiverUserId],
			foreignColumns: [profiles.id],
			name: "help_session_feedback_receiver_user_id_fkey"
		}).onDelete("cascade"),
	unique("unique_session_feedback").on(table.helpRequestId),
	pgPolicy("Participants can view feedback for their sessions", { as: "permissive", for: "select", to: ["public"], using: sql`((auth.uid() = receiver_user_id) OR (auth.uid() = giver_user_id))` }),
	pgPolicy("Participants can update their own feedback", { as: "permissive", for: "update", to: ["public"] }),
	pgPolicy("Participants can insert feedback", { as: "permissive", for: "insert", to: ["public"] }),
	check("help_session_feedback_giver_rating_check", sql`(giver_rating >= 1) AND (giver_rating <= 5)`),
	check("help_session_feedback_receiver_rating_check", sql`(receiver_rating >= 1) AND (receiver_rating <= 5)`),
]);

export const messageReactions = pgTable("message_reactions", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	messageId: uuid("message_id").notNull(),
	userId: uuid("user_id").notNull(),
	emoji: text().notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow(),
}, (table) => [
	foreignKey({
			columns: [table.messageId],
			foreignColumns: [messages.id],
			name: "message_reactions_message_id_fkey"
		}).onDelete("cascade"),
	unique("message_reactions_message_id_user_id_emoji_key").on(table.messageId, table.userId, table.emoji),
	pgPolicy("Users can view message reactions", { as: "permissive", for: "select", to: ["public"], using: sql`(EXISTS ( SELECT 1
   FROM (messages m
     JOIN chat_members cm ON ((m.chat_id = cm.chat_id)))
  WHERE ((m.id = message_reactions.message_id) AND (cm.user_id = auth.uid()))))` }),
	pgPolicy("Users can delete their own reactions", { as: "permissive", for: "delete", to: ["public"] }),
	pgPolicy("Users can add message reactions", { as: "permissive", for: "insert", to: ["public"] }),
]);

export const featureFlags = pgTable("feature_flags", {
	id: uuid().default(sql`extensions.uuid_generate_v4()`).primaryKey().notNull(),
	name: text().notNull(),
	enabled: boolean().default(false),
	description: text(),
	rolloutPercentage: integer("rollout_percentage").default(100),
	targetUsers: jsonb("target_users"),
	createdBy: uuid("created_by"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow(),
}, (table) => [
	index("idx_feature_flags_enabled").using("btree", table.enabled.asc().nullsLast().op("bool_ops")),
	index("idx_feature_flags_name").using("btree", table.name.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.createdBy],
			foreignColumns: [profiles.id],
			name: "feature_flags_created_by_fkey"
		}),
	unique("feature_flags_name_key").on(table.name),
	pgPolicy("feature_flags_policy", { as: "permissive", for: "all", to: ["public"], using: sql`(EXISTS ( SELECT 1
   FROM admin_roles ar
  WHERE ((ar.user_id = auth.uid()) AND (ar.role = 'super_admin'::text) AND (ar.is_active = true))))` }),
	check("feature_flags_rollout_percentage_check", sql`(rollout_percentage >= 0) AND (rollout_percentage <= 100)`),
]);

export const matchmakingHistory = pgTable("matchmaking_history", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	proposalId: text("proposal_id").notNull(),
	userA: uuid("user_a").notNull(),
	userB: uuid("user_b").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	acceptedA: boolean("accepted_a").default(false).notNull(),
	acceptedB: boolean("accepted_b").default(false).notNull(),
	matchedAt: timestamp("matched_at", { withTimezone: true, mode: 'string' }),
	cancelledAt: timestamp("cancelled_at", { withTimezone: true, mode: 'string' }),
	cancelReason: text("cancel_reason"),
}, (table) => [
	index("idx_matchmaking_history_created").using("btree", table.createdAt.asc().nullsLast().op("timestamptz_ops")),
	index("idx_matchmaking_history_users").using("btree", table.userA.asc().nullsLast().op("uuid_ops"), table.userB.asc().nullsLast().op("uuid_ops")),
]);

export const exploreInteractions = pgTable("explore_interactions", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	userId: uuid("user_id").notNull(),
	targetUserId: uuid("target_user_id").notNull(),
	actionType: text("action_type").notNull(),
	interactionSource: text("interaction_source").default('explore'),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow(),
}, (table) => [
	index("idx_explore_interactions_action_type").using("btree", table.actionType.asc().nullsLast().op("text_ops")),
	index("idx_explore_interactions_created_at").using("btree", table.createdAt.desc().nullsFirst().op("timestamptz_ops")),
	index("idx_explore_interactions_target_user_id").using("btree", table.targetUserId.asc().nullsLast().op("uuid_ops")),
	index("idx_explore_interactions_user_id").using("btree", table.userId.asc().nullsLast().op("uuid_ops")),
	index("idx_explore_interactions_user_target").using("btree", table.userId.asc().nullsLast().op("uuid_ops"), table.targetUserId.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.targetUserId],
			foreignColumns: [usersInAuth.id],
			name: "explore_interactions_target_user_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.userId],
			foreignColumns: [usersInAuth.id],
			name: "explore_interactions_user_id_fkey"
		}).onDelete("cascade"),
	unique("unique_recent_interaction").on(table.userId, table.targetUserId, table.actionType, table.createdAt),
	pgPolicy("explore_interactions_select_own", { as: "permissive", for: "select", to: ["public"], using: sql`(auth.uid() = user_id)` }),
	pgPolicy("explore_interactions_insert_own", { as: "permissive", for: "insert", to: ["public"] }),
	pgPolicy("explore_interactions_delete_own", { as: "permissive", for: "delete", to: ["public"] }),
	check("explore_interactions_action_type_check", sql`action_type = ANY (ARRAY['view'::text, 'like'::text, 'super_like'::text, 'pass'::text])`),
	check("explore_interactions_interaction_source_check", sql`interaction_source = ANY (ARRAY['explore'::text, 'search'::text, 'profile_view'::text])`),
]);

export const faceVerifications = pgTable("face_verifications", {
	id: uuid().default(sql`extensions.uuid_generate_v4()`).primaryKey().notNull(),
	userId: uuid("user_id").notNull(),
	status: verificationStatus().default('pending').notNull(),
	videoS3Key: text("video_s3_key"),
	verificationData: jsonb("verification_data"),
	confidence: numeric({ precision: 3, scale:  2 }),
	movementsDetected: text("movements_detected").array(),
	submittedAt: timestamp("submitted_at", { withTimezone: true, mode: 'string' }).defaultNow(),
	verifiedAt: timestamp("verified_at", { withTimezone: true, mode: 'string' }),
	expiresAt: timestamp("expires_at", { withTimezone: true, mode: 'string' }).default(sql`(now() + '24:00:00'::interval)`),
	reviewedBy: uuid("reviewed_by"),
	reviewNotes: text("review_notes"),
	reviewedAt: timestamp("reviewed_at", { withTimezone: true, mode: 'string' }),
	ipAddress: inet("ip_address"),
	userAgent: text("user_agent"),
	deviceInfo: jsonb("device_info"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow(),
}, (table) => [
	index("idx_face_verifications_status").using("btree", table.status.asc().nullsLast().op("enum_ops")),
	index("idx_face_verifications_submitted_at").using("btree", table.submittedAt.desc().nullsFirst().op("timestamptz_ops")),
	index("idx_face_verifications_user_id").using("btree", table.userId.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.reviewedBy],
			foreignColumns: [profiles.id],
			name: "face_verifications_reviewed_by_fkey"
		}),
	foreignKey({
			columns: [table.userId],
			foreignColumns: [profiles.id],
			name: "face_verifications_user_id_fkey"
		}).onDelete("cascade"),
]);

export const marketingAutomationRules = pgTable("marketing_automation_rules", {
	id: uuid().default(sql`extensions.uuid_generate_v4()`).primaryKey().notNull(),
	name: text().notNull(),
	triggerType: text("trigger_type").notNull(),
	triggerConditions: jsonb("trigger_conditions"),
	actionType: text("action_type").notNull(),
	actionConfig: jsonb("action_config"),
	enabled: boolean().default(true),
	delayMinutes: integer("delay_minutes").default(0),
	createdBy: uuid("created_by"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow(),
}, (table) => [
	index("idx_automation_rules_enabled").using("btree", table.enabled.asc().nullsLast().op("bool_ops")),
	index("idx_automation_rules_trigger_type").using("btree", table.triggerType.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.createdBy],
			foreignColumns: [profiles.id],
			name: "marketing_automation_rules_created_by_fkey"
		}),
	check("marketing_automation_rules_action_type_check", sql`action_type = ANY (ARRAY['send_email'::text, 'send_push'::text, 'add_to_segment'::text, 'create_notification'::text])`),
]);

export const referralTransactions = pgTable("referral_transactions", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	referralNumber: varchar("referral_number", { length: 20 }).notNull(),
	referrerUserId: uuid("referrer_user_id").notNull(),
	referredUserId: uuid("referred_user_id").notNull(),
	referralCode: varchar("referral_code", { length: 12 }).notNull(),
	rewardAmount: numeric("reward_amount", { precision: 10, scale:  2 }).default('10.00'),
	status: varchar({ length: 20 }).default('pending'),
	rejectionReason: text("rejection_reason"),
	verifiedBy: uuid("verified_by"),
	verifiedAt: timestamp("verified_at", { withTimezone: true, mode: 'string' }),
	paymentDate: timestamp("payment_date", { withTimezone: true, mode: 'string' }),
	paymentReference: varchar("payment_reference", { length: 100 }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow(),
}, (table) => [
	index("idx_referral_transactions_number").using("btree", table.referralNumber.asc().nullsLast().op("text_ops")),
	index("idx_referral_transactions_referred").using("btree", table.referredUserId.asc().nullsLast().op("uuid_ops")),
	index("idx_referral_transactions_referrer").using("btree", table.referrerUserId.asc().nullsLast().op("uuid_ops")),
	index("idx_referral_transactions_status").using("btree", table.status.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.referredUserId],
			foreignColumns: [profiles.id],
			name: "referral_transactions_referred_user_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.referrerUserId],
			foreignColumns: [profiles.id],
			name: "referral_transactions_referrer_user_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.verifiedBy],
			foreignColumns: [profiles.id],
			name: "referral_transactions_verified_by_fkey"
		}),
	unique("referral_transactions_referral_number_key").on(table.referralNumber),
	unique("unique_referral").on(table.referrerUserId, table.referredUserId),
	check("referral_transactions_status_check", sql`(status)::text = ANY (ARRAY[('pending'::character varying)::text, ('approved'::character varying)::text, ('rejected'::character varying)::text, ('paid'::character varying)::text])`),
]);

export const promotionalSubscriptions = pgTable("promotional_subscriptions", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	userId: uuid("user_id").notNull(),
	promoType: varchar("promo_type", { length: 50 }).notNull(),
	grantedAt: timestamp("granted_at", { withTimezone: true, mode: 'string' }).defaultNow(),
	subscriptionId: uuid("subscription_id"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow(),
}, (table) => [
	index("idx_promotional_subscriptions_granted_at").using("btree", table.grantedAt.asc().nullsLast().op("timestamptz_ops")),
	index("idx_promotional_subscriptions_promo_type").using("btree", table.promoType.asc().nullsLast().op("text_ops")),
	index("idx_promotional_subscriptions_user_id").using("btree", table.userId.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.subscriptionId],
			foreignColumns: [userSubscriptions.id],
			name: "promotional_subscriptions_subscription_id_fkey"
		}),
	foreignKey({
			columns: [table.userId],
			foreignColumns: [profiles.id],
			name: "promotional_subscriptions_user_id_fkey"
		}).onDelete("cascade"),
	unique("promotional_subscriptions_user_id_promo_type_key").on(table.userId, table.promoType),
]);

export const paymentOrders = pgTable("payment_orders", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	orderId: varchar("order_id", { length: 100 }).notNull(),
	userId: uuid("user_id").notNull(),
	planId: varchar("plan_id", { length: 50 }).notNull(),
	amount: numeric({ precision: 10, scale:  2 }).notNull(),
	currency: varchar({ length: 3 }).default('INR'),
	status: varchar({ length: 20 }).default('created'),
	gateway: varchar({ length: 20 }).default('cashfree'),
	gatewayOrderId: varchar("gateway_order_id", { length: 100 }),
	gatewayPaymentId: varchar("gateway_payment_id", { length: 100 }),
	paymentMethod: varchar("payment_method", { length: 50 }),
	failureReason: text("failure_reason"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow(),
}, (table) => [
	index("idx_payment_orders_created_at").using("btree", table.createdAt.desc().nullsFirst().op("timestamptz_ops")),
	index("idx_payment_orders_status").using("btree", table.status.asc().nullsLast().op("text_ops")),
	index("idx_payment_orders_user_id").using("btree", table.userId.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.userId],
			foreignColumns: [profiles.id],
			name: "payment_orders_user_id_fkey"
		}).onDelete("cascade"),
	unique("payment_orders_order_id_key").on(table.orderId),
]);

export const proactiveAlerts = pgTable("proactive_alerts", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	userId: uuid("user_id"),
	alertType: varchar("alert_type", { length: 50 }).notNull(),
	severity: varchar({ length: 20 }).notNull(),
	message: text().notNull(),
	suggestedAction: text("suggested_action"),
	preventiveMessage: text("preventive_message"),
	timeframe: varchar({ length: 20 }),
	status: varchar({ length: 20 }).default('active'),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow(),
}, (table) => [
	index("idx_proactive_alerts_severity").using("btree", table.severity.asc().nullsLast().op("text_ops")),
	index("idx_proactive_alerts_status").using("btree", table.status.asc().nullsLast().op("text_ops")),
	index("idx_proactive_alerts_user_id").using("btree", table.userId.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.userId],
			foreignColumns: [profiles.id],
			name: "proactive_alerts_user_id_fkey"
		}).onDelete("cascade"),
	check("proactive_alerts_severity_check", sql`(severity)::text = ANY (ARRAY[('low'::character varying)::text, ('medium'::character varying)::text, ('high'::character varying)::text, ('critical'::character varying)::text])`),
	check("proactive_alerts_status_check", sql`(status)::text = ANY (ARRAY[('active'::character varying)::text, ('addressed'::character varying)::text, ('dismissed'::character varying)::text])`),
	check("proactive_alerts_timeframe_check", sql`(timeframe)::text = ANY (ARRAY[('immediate'::character varying)::text, ('within_24h'::character varying)::text, ('within_week'::character varying)::text])`),
]);

export const messageReceipts = pgTable("message_receipts", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	messageId: uuid("message_id").notNull(),
	userId: uuid("user_id").notNull(),
	status: messageReceiptStatus().notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("idx_message_receipts_created_at").using("btree", table.createdAt.asc().nullsLast().op("timestamptz_ops")),
	index("idx_message_receipts_message_id").using("btree", table.messageId.asc().nullsLast().op("uuid_ops")),
	index("idx_message_receipts_status").using("btree", table.status.asc().nullsLast().op("enum_ops")),
	index("idx_message_receipts_user").using("btree", table.userId.asc().nullsLast().op("uuid_ops")),
	index("idx_message_receipts_user_id").using("btree", table.userId.asc().nullsLast().op("uuid_ops")),
	index("idx_message_receipts_user_message_status").using("btree", table.userId.asc().nullsLast().op("enum_ops"), table.messageId.asc().nullsLast().op("uuid_ops"), table.status.asc().nullsLast().op("uuid_ops")),
	uniqueIndex("ux_message_receipts_unique").using("btree", table.messageId.asc().nullsLast().op("uuid_ops"), table.userId.asc().nullsLast().op("uuid_ops"), table.status.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.messageId],
			foreignColumns: [messages.id],
			name: "message_receipts_message_id_fkey"
		}).onDelete("cascade"),
	pgPolicy("Users can view message receipts", { as: "permissive", for: "select", to: ["public"], using: sql`((user_id = auth.uid()) OR (message_id IN ( SELECT messages.id
   FROM messages
  WHERE (messages.sender_id = auth.uid()))))` }),
	pgPolicy("Users can update their own receipts", { as: "permissive", for: "update", to: ["public"] }),
	pgPolicy("Users can create message receipts", { as: "permissive", for: "insert", to: ["public"] }),
]);

export const referralCodeAttempts = pgTable("referral_code_attempts", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	referralCode: varchar("referral_code", { length: 12 }).notNull(),
	attemptedByUserId: uuid("attempted_by_user_id"),
	ipAddress: varchar("ip_address", { length: 45 }),
	userAgent: text("user_agent"),
	success: boolean().default(false),
	failureReason: text("failure_reason"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow(),
}, (table) => [
	foreignKey({
			columns: [table.attemptedByUserId],
			foreignColumns: [profiles.id],
			name: "referral_code_attempts_attempted_by_user_id_fkey"
		}).onDelete("set null"),
]);

export const satisfactionRatings = pgTable("satisfaction_ratings", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	conversationId: varchar("conversation_id"),
	userId: uuid("user_id"),
	rating: integer().notNull(),
	feedback: text(),
	category: varchar({ length: 50 }).default('overall').notNull(),
	agentType: varchar("agent_type", { length: 10 }).default('ai').notNull(),
	agentId: varchar("agent_id", { length: 100 }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow(),
}, (table) => [
	index("idx_satisfaction_ratings_conversation_id").using("btree", table.conversationId.asc().nullsLast().op("text_ops")),
	index("idx_satisfaction_ratings_created_at").using("btree", table.createdAt.asc().nullsLast().op("timestamptz_ops")),
	index("idx_satisfaction_ratings_rating").using("btree", table.rating.asc().nullsLast().op("int4_ops")),
	index("idx_satisfaction_ratings_user_id").using("btree", table.userId.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.conversationId],
			foreignColumns: [aiConversations.id],
			name: "satisfaction_ratings_conversation_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.userId],
			foreignColumns: [profiles.id],
			name: "satisfaction_ratings_user_id_fkey"
		}).onDelete("cascade"),
	check("satisfaction_ratings_agent_type_check", sql`(agent_type)::text = ANY (ARRAY[('ai'::character varying)::text, ('human'::character varying)::text])`),
	check("satisfaction_ratings_rating_check", sql`(rating >= 1) AND (rating <= 5)`),
]);

export const userReferrals = pgTable("user_referrals", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	userId: uuid("user_id").notNull(),
	referralCode: varchar("referral_code", { length: 12 }).notNull(),
	totalReferrals: integer("total_referrals").default(0),
	totalEarnings: numeric("total_earnings", { precision: 10, scale:  2 }).default('0.00'),
	pendingEarnings: numeric("pending_earnings", { precision: 10, scale:  2 }).default('0.00'),
	paidEarnings: numeric("paid_earnings", { precision: 10, scale:  2 }).default('0.00'),
	upiId: varchar("upi_id", { length: 100 }),
	upiVerified: boolean("upi_verified").default(false),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow(),
}, (table) => [
	index("idx_user_referrals_code").using("btree", table.referralCode.asc().nullsLast().op("text_ops")),
	index("idx_user_referrals_user_id").using("btree", table.userId.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.userId],
			foreignColumns: [profiles.id],
			name: "user_referrals_user_id_fkey"
		}).onDelete("cascade"),
	unique("unique_user_referral").on(table.userId),
	unique("user_referrals_referral_code_key").on(table.referralCode),
]);

export const userActivityEvents = pgTable("user_activity_events", {
	id: uuid().default(sql`extensions.uuid_generate_v4()`).primaryKey().notNull(),
	userId: uuid("user_id").notNull(),
	eventName: text("event_name").notNull(),
	sessionId: text("session_id"),
	properties: jsonb().default({}),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow(),
}, (table) => [
	index("idx_user_activity_events_created_at").using("btree", table.createdAt.desc().nullsFirst().op("timestamptz_ops")),
	index("idx_user_activity_events_event_name").using("btree", table.eventName.asc().nullsLast().op("text_ops")),
	index("idx_user_activity_events_properties").using("gin", table.properties.asc().nullsLast().op("jsonb_ops")),
	index("idx_user_activity_events_session_id").using("btree", table.sessionId.asc().nullsLast().op("text_ops")),
	index("idx_user_activity_events_user_created").using("btree", table.userId.asc().nullsLast().op("uuid_ops"), table.createdAt.desc().nullsFirst().op("timestamptz_ops")),
	index("idx_user_activity_events_user_event_date").using("btree", table.userId.asc().nullsLast().op("timestamptz_ops"), table.eventName.asc().nullsLast().op("timestamptz_ops"), table.createdAt.desc().nullsFirst().op("timestamptz_ops")),
	index("idx_user_activity_events_user_id").using("btree", table.userId.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.userId],
			foreignColumns: [profiles.id],
			name: "user_activity_events_user_id_fkey"
		}).onDelete("cascade"),
	pgPolicy("user_activity_events_select_policy", { as: "permissive", for: "select", to: ["public"], using: sql`(auth.uid() = user_id)` }),
	pgPolicy("user_activity_events_insert_policy", { as: "permissive", for: "insert", to: ["public"] }),
	pgPolicy("user_activity_events_admin_policy", { as: "permissive", for: "all", to: ["public"] }),
]);

export const messages = pgTable("messages", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	chatId: uuid("chat_id").notNull(),
	senderId: uuid("sender_id").notNull(),
	text: text().notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }),
	isEdited: boolean("is_edited").default(false),
	isDeleted: boolean("is_deleted").default(false),
	deletedAt: timestamp("deleted_at", { withTimezone: true, mode: 'string' }),
	deletedBy: uuid("deleted_by"),
	mediaUrl: text("media_url"),
	mediaType: text("media_type"),
	thumbnail: text(),
	replyToId: uuid("reply_to_id"),
	isViewOnce: boolean("is_view_once").default(false).notNull(),
	viewOnceViewedAt: timestamp("view_once_viewed_at", { withTimezone: true, mode: 'string' }),
}, (table) => [
	index("idx_messages_chat_created").using("btree", table.chatId.asc().nullsLast().op("timestamptz_ops"), table.createdAt.asc().nullsLast().op("timestamptz_ops")),
	index("idx_messages_chat_id_created_at").using("btree", table.chatId.asc().nullsLast().op("uuid_ops"), table.createdAt.desc().nullsFirst().op("uuid_ops")),
	index("idx_messages_is_deleted").using("btree", table.isDeleted.asc().nullsLast().op("bool_ops")),
	index("idx_messages_media_url").using("btree", table.mediaUrl.asc().nullsLast().op("text_ops")).where(sql`(media_url IS NOT NULL)`),
	index("idx_messages_reply_to_id").using("btree", table.replyToId.asc().nullsLast().op("uuid_ops")),
	index("idx_messages_updated_at").using("btree", table.updatedAt.asc().nullsLast().op("timestamptz_ops")),
	foreignKey({
			columns: [table.chatId],
			foreignColumns: [chats.id],
			name: "messages_chat_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.replyToId],
			foreignColumns: [table.id],
			name: "messages_reply_to_id_fkey"
		}).onDelete("set null"),
	pgPolicy("Users can update their own messages", { as: "permissive", for: "update", to: ["public"], using: sql`(sender_id = auth.uid())`, withCheck: sql`(sender_id = auth.uid())`  }),
	check("messages_media_type_check", sql`(media_type = ANY (ARRAY['image'::text, 'video'::text])) OR (media_type IS NULL)`),
]);

export const notifications = pgTable("notifications", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	recipientId: uuid("recipient_id").notNull(),
	senderId: uuid("sender_id"),
	type: varchar({ length: 50 }).notNull(),
	title: varchar({ length: 255 }).notNull(),
	message: text().notNull(),
	data: jsonb().default({}),
	read: boolean().default(false),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow(),
}, (table) => [
	index("idx_notifications_recipient_created").using("btree", table.recipientId.asc().nullsLast().op("timestamptz_ops"), table.createdAt.desc().nullsFirst().op("timestamptz_ops")),
	index("idx_notifications_recipient_read").using("btree", table.recipientId.asc().nullsLast().op("uuid_ops"), table.read.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.recipientId],
			foreignColumns: [profiles.id],
			name: "notifications_recipient_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.senderId],
			foreignColumns: [profiles.id],
			name: "notifications_sender_id_fkey"
		}).onDelete("cascade"),
	pgPolicy("Users can view their own notifications", { as: "permissive", for: "select", to: ["public"], using: sql`(recipient_id = auth.uid())` }),
	pgPolicy("Users can update their own notifications", { as: "permissive", for: "update", to: ["public"] }),
	pgPolicy("Users can delete their own notifications", { as: "permissive", for: "delete", to: ["public"] }),
	pgPolicy("System can create notifications", { as: "permissive", for: "insert", to: ["public"] }),
]);

export const messageViews = pgTable("message_views", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	messageId: uuid("message_id").notNull(),
	viewerId: uuid("viewer_id").notNull(),
	viewedAt: timestamp("viewed_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("idx_message_views_message_id").using("btree", table.messageId.asc().nullsLast().op("uuid_ops")),
	index("idx_message_views_viewer_id").using("btree", table.viewerId.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.messageId],
			foreignColumns: [messages.id],
			name: "message_views_message_id_fkey"
		}).onDelete("cascade"),
	unique("message_views_message_id_viewer_id_key").on(table.messageId, table.viewerId),
]);

export const nearbyNotifications = pgTable("nearby_notifications", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	fromUserId: uuid("from_user_id").notNull(),
	toUserId: uuid("to_user_id").notNull(),
	sentAt: timestamp("sent_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("idx_nearby_notifications_from_user").using("btree", table.fromUserId.asc().nullsLast().op("uuid_ops")),
	index("idx_nearby_notifications_sent_at").using("btree", table.sentAt.asc().nullsLast().op("timestamptz_ops")),
	index("idx_nearby_notifications_to_user").using("btree", table.toUserId.asc().nullsLast().op("uuid_ops")),
	index("idx_nearby_notifications_user_pair").using("btree", table.fromUserId.asc().nullsLast().op("uuid_ops"), table.toUserId.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.fromUserId],
			foreignColumns: [profiles.id],
			name: "nearby_notifications_from_user_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.toUserId],
			foreignColumns: [profiles.id],
			name: "nearby_notifications_to_user_id_fkey"
		}).onDelete("cascade"),
]);

export const notificationTemplates = pgTable("notification_templates", {
	id: uuid().default(sql`extensions.uuid_generate_v4()`).primaryKey().notNull(),
	name: text().notNull(),
	title: text().notNull(),
	body: text().notNull(),
	category: text(),
	icon: text(),
	imageUrl: text("image_url"),
	deepLink: text("deep_link"),
	variables: jsonb(),
	createdBy: uuid("created_by"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow(),
}, (table) => [
	index("idx_notification_templates_category").using("btree", table.category.asc().nullsLast().op("text_ops")),
	index("idx_notification_templates_created_by").using("btree", table.createdBy.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.createdBy],
			foreignColumns: [profiles.id],
			name: "notification_templates_created_by_fkey"
		}),
	check("notification_templates_category_check", sql`category = ANY (ARRAY['match'::text, 'message'::text, 'engagement'::text, 're-engagement'::text, 'system'::text])`),
]);

export const pushTokens = pgTable("push_tokens", {
	id: uuid().default(sql`extensions.uuid_generate_v4()`).primaryKey().notNull(),
	userId: uuid("user_id").notNull(),
	token: text().notNull(),
	deviceType: text("device_type"),
	deviceName: text("device_name"),
	enabled: boolean().default(true),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow(),
	lastUsedAt: timestamp("last_used_at", { withTimezone: true, mode: 'string' }).defaultNow(),
}, (table) => [
	index("idx_push_tokens_enabled").using("btree", table.enabled.asc().nullsLast().op("bool_ops")),
	index("idx_push_tokens_token").using("btree", table.token.asc().nullsLast().op("text_ops")),
	index("idx_push_tokens_user_id").using("btree", table.userId.asc().nullsLast().op("uuid_ops")),
	uniqueIndex("idx_push_tokens_user_token").using("btree", table.userId.asc().nullsLast().op("uuid_ops"), table.token.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.userId],
			foreignColumns: [profiles.id],
			name: "push_tokens_user_id_fkey"
		}).onDelete("cascade"),
	check("push_tokens_device_type_check", sql`device_type = ANY (ARRAY['ios'::text, 'android'::text, 'web'::text])`),
]);

export const satisfactionSurveys = pgTable("satisfaction_surveys", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	conversationId: varchar("conversation_id"),
	questions: jsonb().notNull(),
	overallScore: numeric("overall_score", { precision: 3, scale:  2 }),
	completedAt: timestamp("completed_at", { withTimezone: true, mode: 'string' }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow(),
}, (table) => [
	foreignKey({
			columns: [table.conversationId],
			foreignColumns: [aiConversations.id],
			name: "satisfaction_surveys_conversation_id_fkey"
		}).onDelete("cascade"),
]);

export const subscriptions = pgTable("subscriptions", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	userId: uuid("user_id").notNull(),
	planType: varchar("plan_type", { length: 20 }).default('free').notNull(),
	status: varchar({ length: 20 }).default('active').notNull(),
	startedAt: timestamp("started_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	expiresAt: timestamp("expires_at", { withTimezone: true, mode: 'string' }),
	paymentProvider: varchar("payment_provider", { length: 50 }),
	externalSubscriptionId: varchar("external_subscription_id", { length: 255 }),
	pricePaid: numeric("price_paid", { precision: 10, scale:  2 }),
	currency: varchar({ length: 3 }).default('USD'),
	autoRenew: boolean("auto_renew").default(true),
	cancelledAt: timestamp("cancelled_at", { withTimezone: true, mode: 'string' }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("idx_subscriptions_expires_at").using("btree", table.expiresAt.asc().nullsLast().op("timestamptz_ops")),
	index("idx_subscriptions_status").using("btree", table.status.asc().nullsLast().op("text_ops")),
	index("idx_subscriptions_user_id").using("btree", table.userId.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.userId],
			foreignColumns: [profiles.id],
			name: "subscriptions_user_id_fkey"
		}).onDelete("cascade"),
	unique("subscriptions_user_id_key").on(table.userId),
	check("subscriptions_plan_type_check", sql`(plan_type)::text = ANY (ARRAY[('free'::character varying)::text, ('premium'::character varying)::text, ('premium_plus'::character varying)::text])`),
	check("subscriptions_status_check", sql`(status)::text = ANY (ARRAY[('active'::character varying)::text, ('cancelled'::character varying)::text, ('expired'::character varying)::text, ('pending'::character varying)::text])`),
]);

export const surveyResponses = pgTable("survey_responses", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	surveyId: uuid("survey_id"),
	questionId: varchar("question_id", { length: 100 }).notNull(),
	answer: text().notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow(),
}, (table) => [
	foreignKey({
			columns: [table.surveyId],
			foreignColumns: [satisfactionSurveys.id],
			name: "survey_responses_survey_id_fkey"
		}).onDelete("cascade"),
]);

export const userPhotos = pgTable("user_photos", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	userId: uuid("user_id").notNull(),
	photoUrl: text("photo_url").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow(),
}, (table) => [
	index("idx_user_photos_created_at").using("btree", table.createdAt.desc().nullsFirst().op("timestamptz_ops")),
	index("idx_user_photos_user_id").using("btree", table.userId.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.userId],
			foreignColumns: [profiles.id],
			name: "user_photos_user_id_fkey"
		}).onDelete("cascade"),
	pgPolicy("Users can view their own photos", { as: "permissive", for: "select", to: ["public"], using: sql`(user_id = auth.uid())` }),
	pgPolicy("Users can view other users photos", { as: "permissive", for: "select", to: ["public"] }),
	pgPolicy("Users can update their own photos", { as: "permissive", for: "update", to: ["public"] }),
	pgPolicy("Users can insert their own photos", { as: "permissive", for: "insert", to: ["public"] }),
	pgPolicy("Users can delete their own photos", { as: "permissive", for: "delete", to: ["public"] }),
	check("valid_photo_url", sql`photo_url ~ '^https?://.*'::text`),
]);

export const userConsent = pgTable("user_consent", {
	id: bigserial({ mode: "bigint" }).primaryKey().notNull(),
	userId: uuid("user_id"),
	analyticsConsent: boolean("analytics_consent").default(false),
	crashReportingConsent: boolean("crash_reporting_consent").default(false),
	personalizationConsent: boolean("personalization_consent").default(false),
	marketingConsent: boolean("marketing_consent").default(false),
	consentVersion: varchar("consent_version", { length: 10 }).default('1.0'),
	consentTimestamp: timestamp("consent_timestamp", { withTimezone: true, mode: 'string' }).notNull(),
	ipAddress: inet("ip_address"),
	userAgent: text("user_agent"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow(),
}, (table) => [
	index("idx_user_consent_timestamp").using("btree", table.consentTimestamp.asc().nullsLast().op("timestamptz_ops")),
	index("idx_user_consent_user_id").using("btree", table.userId.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.userId],
			foreignColumns: [profiles.id],
			name: "user_consent_user_id_fkey"
		}).onDelete("cascade"),
	unique("user_consent_user_id_key").on(table.userId),
	pgPolicy("Users can manage their own consent", { as: "permissive", for: "all", to: ["public"], using: sql`(auth.uid() = user_id)` }),
	pgPolicy("Service role can view all consent records", { as: "permissive", for: "select", to: ["public"] }),
]);

export const userActivities = pgTable("user_activities", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	userId: uuid("user_id").notNull(),
	activityType: varchar("activity_type", { length: 50 }).notNull(),
	pointsChange: integer("points_change").notNull(),
	relatedUserId: uuid("related_user_id"),
	metadata: jsonb(),
	createdAt: timestamp("created_at", { mode: 'string' }).default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
	index("idx_user_activities_created_at").using("btree", table.createdAt.asc().nullsLast().op("timestamp_ops")),
	index("idx_user_activities_type").using("btree", table.activityType.asc().nullsLast().op("text_ops")),
	index("idx_user_activities_user_id").using("btree", table.userId.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.relatedUserId],
			foreignColumns: [profiles.id],
			name: "user_activities_related_user_id_fkey"
		}),
	foreignKey({
			columns: [table.userId],
			foreignColumns: [profiles.id],
			name: "user_activities_user_id_fkey"
		}).onDelete("cascade"),
]);

export const userCampaignInteractions = pgTable("user_campaign_interactions", {
	id: uuid().default(sql`extensions.uuid_generate_v4()`).primaryKey().notNull(),
	campaignId: uuid("campaign_id"),
	userId: uuid("user_id"),
	action: text().notNull(),
	metadata: jsonb(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow(),
}, (table) => [
	index("idx_campaign_interactions_campaign").using("btree", table.campaignId.asc().nullsLast().op("uuid_ops")),
	index("idx_campaign_interactions_user").using("btree", table.userId.asc().nullsLast().op("uuid_ops")),
	index("idx_interactions_action").using("btree", table.action.asc().nullsLast().op("text_ops")),
	index("idx_interactions_campaign_id").using("btree", table.campaignId.asc().nullsLast().op("uuid_ops")),
	uniqueIndex("idx_interactions_unique").using("btree", table.campaignId.asc().nullsLast().op("uuid_ops"), table.userId.asc().nullsLast().op("text_ops"), table.action.asc().nullsLast().op("text_ops")),
	index("idx_interactions_user_id").using("btree", table.userId.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.campaignId],
			foreignColumns: [marketingCampaigns.id],
			name: "user_campaign_interactions_campaign_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.userId],
			foreignColumns: [profiles.id],
			name: "user_campaign_interactions_user_id_fkey"
		}).onDelete("cascade"),
	check("user_campaign_interactions_action_check", sql`action = ANY (ARRAY['sent'::text, 'delivered'::text, 'opened'::text, 'clicked'::text, 'converted'::text, 'unsubscribed'::text, 'bounced'::text])`),
]);

export const userMarketingPreferences = pgTable("user_marketing_preferences", {
	id: uuid().default(sql`extensions.uuid_generate_v4()`).primaryKey().notNull(),
	userId: uuid("user_id"),
	emailEnabled: boolean("email_enabled").default(true),
	pushEnabled: boolean("push_enabled").default(true),
	smsEnabled: boolean("sms_enabled").default(false),
	frequencyPreference: text("frequency_preference").default('normal'),
	unsubscribedAt: timestamp("unsubscribed_at", { withTimezone: true, mode: 'string' }),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow(),
}, (table) => [
	index("idx_marketing_prefs_email_enabled").using("btree", table.emailEnabled.asc().nullsLast().op("bool_ops")),
	index("idx_marketing_prefs_push_enabled").using("btree", table.pushEnabled.asc().nullsLast().op("bool_ops")),
	index("idx_marketing_prefs_user").using("btree", table.userId.asc().nullsLast().op("uuid_ops")),
	index("idx_marketing_prefs_user_id").using("btree", table.userId.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.userId],
			foreignColumns: [profiles.id],
			name: "user_marketing_preferences_user_id_fkey"
		}).onDelete("cascade"),
	unique("user_marketing_preferences_user_id_key").on(table.userId),
	check("user_marketing_preferences_frequency_preference_check", sql`frequency_preference = ANY (ARRAY['high'::text, 'normal'::text, 'low'::text])`),
]);

export const userReports = pgTable("user_reports", {
	id: uuid().default(sql`extensions.uuid_generate_v4()`).primaryKey().notNull(),
	reporterId: uuid("reporter_id"),
	reportedUserId: uuid("reported_user_id"),
	reportType: text("report_type").notNull(),
	reason: text(),
	evidence: jsonb(),
	status: text().default('pending'),
	moderatorId: uuid("moderator_id"),
	moderatorNotes: text("moderator_notes"),
	actionTaken: text("action_taken"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow(),
	resolvedAt: timestamp("resolved_at", { withTimezone: true, mode: 'string' }),
	messageId: uuid("message_id"),
	chatId: uuid("chat_id"),
	additionalDetails: text("additional_details"),
}, (table) => [
	index("idx_reports_created_at").using("btree", table.createdAt.desc().nullsFirst().op("timestamptz_ops")),
	index("idx_reports_reported_user_id").using("btree", table.reportedUserId.asc().nullsLast().op("uuid_ops")),
	index("idx_reports_reporter_id").using("btree", table.reporterId.asc().nullsLast().op("uuid_ops")),
	index("idx_reports_status").using("btree", table.status.asc().nullsLast().op("text_ops")),
	index("idx_reports_type").using("btree", table.reportType.asc().nullsLast().op("text_ops")),
	index("idx_user_reports_chat_id").using("btree", table.chatId.asc().nullsLast().op("uuid_ops")).where(sql`(chat_id IS NOT NULL)`),
	index("idx_user_reports_message_id").using("btree", table.messageId.asc().nullsLast().op("uuid_ops")).where(sql`(message_id IS NOT NULL)`),
	foreignKey({
			columns: [table.chatId],
			foreignColumns: [chats.id],
			name: "user_reports_chat_id_fkey"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.messageId],
			foreignColumns: [messages.id],
			name: "user_reports_message_id_fkey"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.moderatorId],
			foreignColumns: [profiles.id],
			name: "user_reports_moderator_id_fkey"
		}),
	foreignKey({
			columns: [table.reportedUserId],
			foreignColumns: [profiles.id],
			name: "user_reports_reported_user_id_fkey"
		}),
	foreignKey({
			columns: [table.reporterId],
			foreignColumns: [profiles.id],
			name: "user_reports_reporter_id_fkey"
		}),
	pgPolicy("user_reports_update_policy", { as: "permissive", for: "update", to: ["public"], using: sql`(EXISTS ( SELECT 1
   FROM admin_roles ar
  WHERE ((ar.user_id = auth.uid()) AND (ar.is_active = true))))` }),
	pgPolicy("user_reports_select_policy", { as: "permissive", for: "select", to: ["public"] }),
	pgPolicy("user_reports_insert_policy", { as: "permissive", for: "insert", to: ["public"] }),
	check("user_reports_report_type_check", sql`report_type = ANY (ARRAY['harassment'::text, 'spam'::text, 'inappropriate_content'::text, 'fake_profile'::text, 'underage'::text, 'other'::text])`),
	check("user_reports_status_check", sql`status = ANY (ARRAY['pending'::text, 'reviewing'::text, 'resolved'::text, 'dismissed'::text])`),
]);

export const userMatches = pgTable("user_matches", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	user1Id: uuid("user1_id").notNull(),
	user2Id: uuid("user2_id").notNull(),
	matchType: varchar("match_type", { length: 50 }).default('regular'),
	matchedAt: timestamp("matched_at", { mode: 'string' }).default(sql`CURRENT_TIMESTAMP`),
	createdVia: varchar("created_via", { length: 50 }).default('matchmaking'),
}, (table) => [
	index("idx_user_matches_matched_at").using("btree", table.matchedAt.asc().nullsLast().op("timestamp_ops")),
	index("idx_user_matches_user1").using("btree", table.user1Id.asc().nullsLast().op("uuid_ops")),
	index("idx_user_matches_user2").using("btree", table.user2Id.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.user1Id],
			foreignColumns: [profiles.id],
			name: "user_matches_user1_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.user2Id],
			foreignColumns: [profiles.id],
			name: "user_matches_user2_id_fkey"
		}).onDelete("cascade"),
	unique("user_matches_user1_id_user2_id_key").on(table.user1Id, table.user2Id),
]);

export const subscriptionTransactions = pgTable("subscription_transactions", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	userId: uuid("user_id").notNull(),
	orderId: varchar("order_id", { length: 100 }),
	amount: numeric({ precision: 10, scale:  2 }).notNull(),
	currency: varchar({ length: 3 }).default('INR'),
	status: varchar({ length: 20 }).notNull(),
	paymentMethod: varchar("payment_method", { length: 50 }),
	gateway: varchar({ length: 20 }).default('cashfree'),
	gatewayTransactionId: varchar("gateway_transaction_id", { length: 100 }),
	description: text(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow(),
}, (table) => [
	index("idx_subscription_transactions_created_at").using("btree", table.createdAt.desc().nullsFirst().op("timestamptz_ops")),
	index("idx_subscription_transactions_order_id").using("btree", table.orderId.asc().nullsLast().op("text_ops")),
	index("idx_subscription_transactions_user_id").using("btree", table.userId.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.orderId],
			foreignColumns: [paymentOrders.orderId],
			name: "subscription_transactions_order_id_fkey"
		}),
	foreignKey({
			columns: [table.userId],
			foreignColumns: [profiles.id],
			name: "subscription_transactions_user_id_fkey"
		}).onDelete("cascade"),
]);

export const systemSettings = pgTable("system_settings", {
	key: text().default('default').primaryKey().notNull(),
	value: jsonb(),
	description: text(),
	category: text(),
	updatedBy: uuid("updated_by"),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow(),
	autoModeration: boolean("auto_moderation").default(true),
	profanityFilter: boolean("profanity_filter").default(true),
	imageModeration: boolean("image_moderation").default(true),
	requireEmailVerification: boolean("require_email_verification").default(true),
	maintenanceMode: boolean("maintenance_mode").default(false),
	registrationEnabled: boolean("registration_enabled").default(true),
	matchmakingEnabled: boolean("matchmaking_enabled").default(true),
	chatEnabled: boolean("chat_enabled").default(true),
	maxFileSize: integer("max_file_size").default(10),
	maxMessagesPerDay: integer("max_messages_per_day").default(1000),
	maxFriendsPerUser: integer("max_friends_per_user").default(500),
	sessionTimeout: integer("session_timeout").default(30),
	maxLoginAttempts: integer("max_login_attempts").default(5),
}, (table) => [
	index("idx_system_settings_category").using("btree", table.category.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.updatedBy],
			foreignColumns: [profiles.id],
			name: "system_settings_updated_by_fkey"
		}),
	unique("system_settings_key_unique").on(table.key),
	pgPolicy("system_settings_policy", { as: "permissive", for: "all", to: ["public"], using: sql`(EXISTS ( SELECT 1
   FROM admin_roles ar
  WHERE ((ar.user_id = auth.uid()) AND (ar.role = 'super_admin'::text) AND (ar.is_active = true))))` }),
]);

export const referralPaymentRequests = pgTable("referral_payment_requests", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	userId: uuid("user_id").notNull(),
	upiId: varchar("upi_id", { length: 100 }).notNull(),
	amount: numeric({ precision: 10, scale:  2 }).notNull(),
	status: varchar({ length: 20 }).default('pending'),
	requestDate: timestamp("request_date", { withTimezone: true, mode: 'string' }).defaultNow(),
	processedDate: timestamp("processed_date", { withTimezone: true, mode: 'string' }),
	processedBy: uuid("processed_by"),
	paymentReference: varchar("payment_reference", { length: 100 }),
	notes: text(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow(),
}, (table) => [
	index("idx_payment_requests_status").using("btree", table.status.asc().nullsLast().op("text_ops")),
	index("idx_payment_requests_user").using("btree", table.userId.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.processedBy],
			foreignColumns: [profiles.id],
			name: "referral_payment_requests_processed_by_fkey"
		}),
	foreignKey({
			columns: [table.userId],
			foreignColumns: [profiles.id],
			name: "referral_payment_requests_user_id_fkey"
		}).onDelete("cascade"),
	check("referral_payment_requests_status_check", sql`(status)::text = ANY (ARRAY[('pending'::character varying)::text, ('processing'::character varying)::text, ('completed'::character varying)::text, ('failed'::character varying)::text])`),
]);

export const refunds = pgTable("refunds", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	subscriptionId: uuid("subscription_id").notNull(),
	userId: uuid("user_id").notNull(),
	amount: numeric({ precision: 10, scale:  2 }).notNull(),
	currency: varchar({ length: 3 }).default('USD').notNull(),
	reason: text(),
	status: varchar({ length: 20 }).default('pending').notNull(),
	requestedAt: timestamp("requested_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	processedAt: timestamp("processed_at", { withTimezone: true, mode: 'string' }),
	processedBy: uuid("processed_by"),
	paymentProvider: varchar("payment_provider", { length: 50 }),
	externalRefundId: varchar("external_refund_id", { length: 255 }),
	refundMethod: varchar("refund_method", { length: 50 }).default('original_payment_method'),
	adminNotes: text("admin_notes"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("idx_refunds_processed_by").using("btree", table.processedBy.asc().nullsLast().op("uuid_ops")),
	index("idx_refunds_requested_at").using("btree", table.requestedAt.asc().nullsLast().op("timestamptz_ops")),
	index("idx_refunds_status").using("btree", table.status.asc().nullsLast().op("text_ops")),
	index("idx_refunds_subscription_id").using("btree", table.subscriptionId.asc().nullsLast().op("uuid_ops")),
	index("idx_refunds_user_id").using("btree", table.userId.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.processedBy],
			foreignColumns: [profiles.id],
			name: "refunds_processed_by_fkey"
		}),
	foreignKey({
			columns: [table.subscriptionId],
			foreignColumns: [subscriptions.id],
			name: "refunds_subscription_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.userId],
			foreignColumns: [profiles.id],
			name: "refunds_user_id_fkey"
		}).onDelete("cascade"),
	check("refunds_status_check", sql`(status)::text = ANY (ARRAY[('pending'::character varying)::text, ('approved'::character varying)::text, ('rejected'::character varying)::text, ('processed'::character varying)::text, ('failed'::character varying)::text])`),
]);

export const userProfileVisits = pgTable("user_profile_visits", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	visitorId: uuid("visitor_id").notNull(),
	visitedUserId: uuid("visited_user_id").notNull(),
	visitCount: integer("visit_count").default(1),
	firstVisitAt: timestamp("first_visit_at", { mode: 'string' }).default(sql`CURRENT_TIMESTAMP`),
	lastVisitAt: timestamp("last_visit_at", { mode: 'string' }).default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
	index("idx_profile_visits_last_visit").using("btree", table.lastVisitAt.asc().nullsLast().op("timestamp_ops")),
	index("idx_profile_visits_visited").using("btree", table.visitedUserId.asc().nullsLast().op("uuid_ops")),
	index("idx_profile_visits_visitor").using("btree", table.visitorId.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.visitedUserId],
			foreignColumns: [profiles.id],
			name: "user_profile_visits_visited_user_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.visitorId],
			foreignColumns: [profiles.id],
			name: "user_profile_visits_visitor_id_fkey"
		}).onDelete("cascade"),
	unique("user_profile_visits_visitor_id_visited_user_id_key").on(table.visitorId, table.visitedUserId),
]);

export const voiceCallParticipants = pgTable("voice_call_participants", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	callId: text("call_id").notNull(),
	userId: uuid("user_id").notNull(),
	joinedAt: timestamp("joined_at", { withTimezone: true, mode: 'string' }).defaultNow(),
	leftAt: timestamp("left_at", { withTimezone: true, mode: 'string' }),
	role: text().default('participant').notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow(),
}, (table) => [
	index("idx_voice_call_participants_call_id").using("btree", table.callId.asc().nullsLast().op("text_ops")),
	index("idx_voice_call_participants_user_id").using("btree", table.userId.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.callId],
			foreignColumns: [voiceCalls.callId],
			name: "voice_call_participants_call_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.userId],
			foreignColumns: [profiles.id],
			name: "voice_call_participants_user_id_fkey"
		}).onDelete("cascade"),
	check("voice_call_participants_role_check", sql`role = ANY (ARRAY['caller'::text, 'receiver'::text, 'participant'::text])`),
]);

export const userSessions = pgTable("user_sessions", {
	id: bigserial({ mode: "bigint" }).primaryKey().notNull(),
	sessionId: varchar("session_id", { length: 100 }).notNull(),
	userId: uuid("user_id"),
	startedAt: timestamp("started_at", { withTimezone: true, mode: 'string' }).notNull(),
	endedAt: timestamp("ended_at", { withTimezone: true, mode: 'string' }),
	durationSeconds: integer("duration_seconds"),
	platform: varchar({ length: 20 }).notNull(),
	appVersion: varchar("app_version", { length: 20 }).notNull(),
	deviceId: varchar("device_id", { length: 100 }),
	deviceName: varchar("device_name", { length: 200 }),
	screenViews: integer("screen_views").default(0),
	eventsCount: integer("events_count").default(0),
	crashesCount: integer("crashes_count").default(0),
	country: varchar({ length: 2 }),
	city: varchar({ length: 100 }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow(),
}, (table) => [
	index("idx_user_sessions_app_version").using("btree", table.appVersion.asc().nullsLast().op("text_ops")),
	index("idx_user_sessions_platform").using("btree", table.platform.asc().nullsLast().op("text_ops")),
	index("idx_user_sessions_session_id").using("btree", table.sessionId.asc().nullsLast().op("text_ops")),
	index("idx_user_sessions_started_at").using("btree", table.startedAt.asc().nullsLast().op("timestamptz_ops")),
	index("idx_user_sessions_user_id").using("btree", table.userId.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.userId],
			foreignColumns: [profiles.id],
			name: "user_sessions_user_id_fkey"
		}).onDelete("cascade"),
	unique("user_sessions_session_id_key").on(table.sessionId),
	pgPolicy("Users can view their own sessions", { as: "permissive", for: "select", to: ["public"], using: sql`(auth.uid() = user_id)` }),
	pgPolicy("Service role can manage all sessions", { as: "permissive", for: "all", to: ["public"] }),
]);

export const verificationAttempts = pgTable("verification_attempts", {
	id: uuid().default(sql`extensions.uuid_generate_v4()`).primaryKey().notNull(),
	userId: uuid("user_id").notNull(),
	verificationId: uuid("verification_id"),
	success: boolean().notNull(),
	failureReason: text("failure_reason"),
	ipAddress: inet("ip_address"),
	userAgent: text("user_agent"),
	deviceInfo: jsonb("device_info"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow(),
}, (table) => [
	index("idx_verification_attempts_created_at").using("btree", table.createdAt.desc().nullsFirst().op("timestamptz_ops")),
	index("idx_verification_attempts_user_id").using("btree", table.userId.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.userId],
			foreignColumns: [profiles.id],
			name: "verification_attempts_user_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.verificationId],
			foreignColumns: [faceVerifications.id],
			name: "verification_attempts_verification_id_fkey"
		}).onDelete("set null"),
]);

export const voiceCalls = pgTable("voice_calls", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	callId: text("call_id").notNull(),
	callerId: uuid("caller_id").notNull(),
	receiverId: uuid("receiver_id").notNull(),
	callType: text("call_type").default('webrtc').notNull(),
	status: text().default('initiated').notNull(),
	startedAt: timestamp("started_at", { withTimezone: true, mode: 'string' }).defaultNow(),
	connectedAt: timestamp("connected_at", { withTimezone: true, mode: 'string' }),
	endedAt: timestamp("ended_at", { withTimezone: true, mode: 'string' }),
	durationSeconds: integer("duration_seconds").default(0),
	endReason: text("end_reason"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow(),
}, (table) => [
	index("idx_voice_calls_call_id").using("btree", table.callId.asc().nullsLast().op("text_ops")),
	index("idx_voice_calls_caller_id").using("btree", table.callerId.asc().nullsLast().op("uuid_ops")),
	index("idx_voice_calls_receiver_id").using("btree", table.receiverId.asc().nullsLast().op("uuid_ops")),
	index("idx_voice_calls_started_at").using("btree", table.startedAt.desc().nullsFirst().op("timestamptz_ops")),
	index("idx_voice_calls_status").using("btree", table.status.asc().nullsLast().op("text_ops")),
	index("idx_voice_calls_user_history").using("btree", table.callerId.asc().nullsLast().op("uuid_ops"), table.receiverId.asc().nullsLast().op("timestamptz_ops"), table.startedAt.desc().nullsFirst().op("uuid_ops")),
	foreignKey({
			columns: [table.callerId],
			foreignColumns: [profiles.id],
			name: "voice_calls_caller_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.receiverId],
			foreignColumns: [profiles.id],
			name: "voice_calls_receiver_id_fkey"
		}).onDelete("cascade"),
	unique("voice_calls_call_id_key").on(table.callId),
	check("voice_calls_call_type_check", sql`call_type = ANY (ARRAY['webrtc'::text, 'audio-fallback'::text])`),
	check("voice_calls_end_reason_check", sql`end_reason = ANY (ARRAY['completed'::text, 'declined'::text, 'missed'::text, 'disconnected'::text, 'error'::text])`),
	check("voice_calls_status_check", sql`status = ANY (ARRAY['initiated'::text, 'ringing'::text, 'connected'::text, 'ended'::text, 'declined'::text, 'missed'::text])`),
]);

export const userSubscriptions = pgTable("user_subscriptions", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	userId: uuid("user_id").notNull(),
	planType: varchar("plan_type", { length: 20 }).notNull(),
	status: varchar({ length: 20 }).default('active'),
	startedAt: timestamp("started_at", { withTimezone: true, mode: 'string' }).defaultNow(),
	expiresAt: timestamp("expires_at", { withTimezone: true, mode: 'string' }).notNull(),
	cancelledAt: timestamp("cancelled_at", { withTimezone: true, mode: 'string' }),
	paymentGateway: varchar("payment_gateway", { length: 20 }).default('cashfree'),
	gatewaySubscriptionId: varchar("gateway_subscription_id", { length: 100 }),
	amount: numeric({ precision: 10, scale:  2 }),
	currency: varchar({ length: 3 }).default('INR'),
	autoRenew: boolean("auto_renew").default(false),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow(),
}, (table) => [
	index("idx_user_subscriptions_expires_at").using("btree", table.expiresAt.asc().nullsLast().op("timestamptz_ops")),
	index("idx_user_subscriptions_status").using("btree", table.status.asc().nullsLast().op("text_ops")),
	index("idx_user_subscriptions_user_id").using("btree", table.userId.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.userId],
			foreignColumns: [profiles.id],
			name: "user_subscriptions_user_id_fkey"
		}).onDelete("cascade"),
	unique("unique_active_subscription").on(table.userId, table.status),
]);

export const blindDateBlockedMessages = pgTable("blind_date_blocked_messages", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	blindDateId: uuid("blind_date_id").notNull(),
	senderId: uuid("sender_id").notNull(),
	originalMessage: text("original_message").notNull(),
	filteredMessage: text("filtered_message"),
	blockedReason: text("blocked_reason"),
	detectionConfidence: numeric("detection_confidence", { precision: 3, scale:  2 }),
	aiAnalysis: jsonb("ai_analysis"),
	wasReleased: boolean("was_released").default(false),
	releasedAt: timestamp("released_at", { withTimezone: true, mode: 'string' }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow(),
}, (table) => [
	index("idx_blind_date_blocked_messages").using("btree", table.blindDateId.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.blindDateId],
			foreignColumns: [blindDateMatches.id],
			name: "blind_date_blocked_messages_blind_date_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.senderId],
			foreignColumns: [profiles.id],
			name: "blind_date_blocked_messages_sender_id_fkey"
		}).onDelete("cascade"),
]);

export const matchmakingProposals = pgTable("matchmaking_proposals", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	a: uuid().notNull(),
	b: uuid().notNull(),
	status: varchar({ length: 20 }).default('pending'),
	type: varchar({ length: 50 }).default('regular'),
	matchedAt: timestamp("matched_at", { mode: 'string' }),
	createdAt: timestamp("created_at", { mode: 'string' }).default(sql`CURRENT_TIMESTAMP`),
	actionSource: text("action_source").default('match_tab'),
}, (table) => [
	index("idx_matchmaking_proposals_matched_at").using("btree", table.matchedAt.asc().nullsLast().op("timestamp_ops")),
	index("idx_matchmaking_proposals_status").using("btree", table.status.asc().nullsLast().op("text_ops")),
	index("idx_matchmaking_proposals_user_a").using("btree", table.a.asc().nullsLast().op("uuid_ops")),
	index("idx_matchmaking_proposals_user_b").using("btree", table.b.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.a],
			foreignColumns: [profiles.id],
			name: "matchmaking_proposals_a_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.b],
			foreignColumns: [profiles.id],
			name: "matchmaking_proposals_b_fkey"
		}).onDelete("cascade"),
	check("matchmaking_proposals_action_source_check", sql`action_source = ANY (ARRAY['match_tab'::text, 'explore_tab'::text, 'profile_view'::text])`),
]);

export const userSegments = pgTable("user_segments", {
	id: uuid().default(sql`extensions.uuid_generate_v4()`).primaryKey().notNull(),
	name: text().notNull(),
	description: text(),
	criteria: jsonb().notNull(),
	userCount: integer("user_count").default(0),
	lastCalculatedAt: timestamp("last_calculated_at", { withTimezone: true, mode: 'string' }),
	createdBy: uuid("created_by"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow(),
}, (table) => [
	index("idx_segments_created_by").using("btree", table.createdBy.asc().nullsLast().op("uuid_ops")),
	index("idx_user_segments_created_by").using("btree", table.createdBy.asc().nullsLast().op("uuid_ops")),
	index("idx_user_segments_last_calculated").using("btree", table.lastCalculatedAt.asc().nullsLast().op("timestamptz_ops")),
	foreignKey({
			columns: [table.createdBy],
			foreignColumns: [profiles.id],
			name: "user_segments_created_by_fkey"
		}),
]);

export const helpRequests = pgTable("help_requests", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	receiverUserId: uuid("receiver_user_id").notNull(),
	prompt: text().notNull(),
	promptEmbedding: vector("prompt_embedding", { dimensions: 1536 }),
	status: varchar({ length: 20 }).default('searching'),
	matchedGiverId: uuid("matched_giver_id"),
	chatRoomId: uuid("chat_room_id"),
	attemptsCount: integer("attempts_count").default(0),
	declinedGiverIds: uuid("declined_giver_ids").array(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow(),
	expiresAt: timestamp("expires_at", { withTimezone: true, mode: 'string' }).default(sql`(now() + '01:00:00'::interval)`),
	matchedAt: timestamp("matched_at", { withTimezone: true, mode: 'string' }),
	completedAt: timestamp("completed_at", { withTimezone: true, mode: 'string' }),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow(),
}, (table) => [
	index("idx_help_requests_active").using("btree", table.status.asc().nullsLast().op("text_ops"), table.expiresAt.asc().nullsLast().op("text_ops")).where(sql`((status)::text = 'searching'::text)`),
	index("idx_help_requests_attempts").using("btree", table.attemptsCount.asc().nullsLast().op("int4_ops")),
	index("idx_help_requests_embedding").using("ivfflat", table.promptEmbedding.asc().nullsLast().op("vector_cosine_ops")).with({lists: "100"}),
	index("idx_help_requests_receiver").using("btree", table.receiverUserId.asc().nullsLast().op("uuid_ops")),
	index("idx_help_requests_status").using("btree", table.status.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.chatRoomId],
			foreignColumns: [chats.id],
			name: "help_requests_chat_room_id_fkey"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.matchedGiverId],
			foreignColumns: [profiles.id],
			name: "help_requests_matched_giver_id_fkey"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.receiverUserId],
			foreignColumns: [profiles.id],
			name: "help_requests_receiver_user_id_fkey"
		}).onDelete("cascade"),
	pgPolicy("Users can view their own help requests", { as: "permissive", for: "select", to: ["public"], using: sql`((auth.uid() = receiver_user_id) OR (auth.uid() = matched_giver_id))` }),
	pgPolicy("Users can update their own help requests", { as: "permissive", for: "update", to: ["public"] }),
	pgPolicy("Users can create their own help requests", { as: "permissive", for: "insert", to: ["public"] }),
	check("help_requests_status_check", sql`(status)::text = ANY (ARRAY[('searching'::character varying)::text, ('matched'::character varying)::text, ('declined_all'::character varying)::text, ('completed'::character varying)::text, ('cancelled'::character varying)::text, ('expired'::character varying)::text])`),
]);

export const chatMembers = pgTable("chat_members", {
	chatId: uuid("chat_id").notNull(),
	userId: uuid("user_id").notNull(),
	joinedAt: timestamp("joined_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("idx_chat_members_user").using("btree", table.userId.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.chatId],
			foreignColumns: [chats.id],
			name: "chat_members_chat_id_fkey"
		}).onDelete("cascade"),
	primaryKey({ columns: [table.chatId, table.userId], name: "chat_members_pkey"}),
]);
export const acceptedFriendshipsView = pgView("accepted_friendships_view", {	id: uuid(),
	user1Id: uuid("user1_id"),
	user2Id: uuid("user2_id"),
	senderId: uuid("sender_id"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }),
}).as(sql`SELECT id, user1_id, user2_id, sender_id, created_at, updated_at FROM friendships WHERE status::text = 'accepted'::text`);

export const aiConversationAnalytics = pgView("ai_conversation_analytics", {	date: timestamp({ withTimezone: true, mode: 'string' }),
	status: varchar({ length: 50 }),
	intent: varchar({ length: 100 }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	conversationCount: bigint("conversation_count", { mode: "number" }),
	avgRefundExplanations: numeric("avg_refund_explanations"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	escalations: bigint({ mode: "number" }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	resolutions: bigint({ mode: "number" }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	anonymousConversations: bigint("anonymous_conversations", { mode: "number" }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	authenticatedConversations: bigint("authenticated_conversations", { mode: "number" }),
	totalEstimatedCost: numeric("total_estimated_cost"),
	avgCostPerConversation: numeric("avg_cost_per_conversation"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	totalTokens: bigint("total_tokens", { mode: "number" }),
	avgTokensPerConversation: numeric("avg_tokens_per_conversation"),
}).as(sql`SELECT date_trunc('day'::text, created_at) AS date, status, intent, count(*) AS conversation_count, avg(refund_explanation_count) AS avg_refund_explanations, count( CASE WHEN status::text = 'escalated'::text THEN 1 ELSE NULL::integer END) AS escalations, count( CASE WHEN status::text = 'resolved'::text THEN 1 ELSE NULL::integer END) AS resolutions, count( CASE WHEN user_id IS NULL THEN 1 ELSE NULL::integer END) AS anonymous_conversations, count( CASE WHEN user_id IS NOT NULL THEN 1 ELSE NULL::integer END) AS authenticated_conversations, sum(estimated_cost) AS total_estimated_cost, avg(estimated_cost) AS avg_cost_per_conversation, sum(token_count) AS total_tokens, avg(token_count) AS avg_tokens_per_conversation FROM ai_conversations GROUP BY (date_trunc('day'::text, created_at)), status, intent ORDER BY (date_trunc('day'::text, created_at)) DESC, status, intent`);

export const activeHelpRequestsSummary = pgView("active_help_requests_summary", {	id: uuid(),
	receiverUserId: uuid("receiver_user_id"),
	receiverUsername: text("receiver_username"),
	prompt: text(),
	status: varchar({ length: 20 }),
	attemptsCount: integer("attempts_count"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }),
	expiresAt: timestamp("expires_at", { withTimezone: true, mode: 'string' }),
	minutesRemaining: numeric("minutes_remaining"),
}).as(sql`SELECT hr.id, hr.receiver_user_id, p.username AS receiver_username, hr.prompt, hr.status, hr.attempts_count, hr.created_at, hr.expires_at, EXTRACT(epoch FROM hr.expires_at - now()) / 60::numeric AS minutes_remaining FROM help_requests hr JOIN profiles p ON p.id = hr.receiver_user_id WHERE hr.status::text = 'searching'::text AND hr.expires_at > now() ORDER BY hr.created_at`);

export const appVersionDistribution = pgView("app_version_distribution", {	version: varchar({ length: 20 }),
	platform: varchar({ length: 20 }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	userCount: bigint("user_count", { mode: "number" }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	installCount: bigint("install_count", { mode: "number" }),
	latestInstall: timestamp("latest_install", { withTimezone: true, mode: 'string' }),
}).as(sql`SELECT version, platform, count(DISTINCT user_id) AS user_count, count(*) AS install_count, max(created_at) AS latest_install FROM app_versions GROUP BY version, platform ORDER BY (max(created_at)) DESC`);

export const beaconRetryAnalytics = pgView("beacon_retry_analytics", {	requestId: uuid("request_id"),
	receiverUserId: uuid("receiver_user_id"),
	prompt: text(),
	requestStatus: varchar("request_status", { length: 20 }),
	attemptsCount: integer("attempts_count"),
	requestCreatedAt: timestamp("request_created_at", { withTimezone: true, mode: 'string' }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	totalAttempts: bigint("total_attempts", { mode: "number" }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	acceptedCount: bigint("accepted_count", { mode: "number" }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	declinedCount: bigint("declined_count", { mode: "number" }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	timeoutCount: bigint("timeout_count", { mode: "number" }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	pendingCount: bigint("pending_count", { mode: "number" }),
	firstAttemptAt: timestamp("first_attempt_at", { withTimezone: true, mode: 'string' }),
	lastResponseAt: timestamp("last_response_at", { withTimezone: true, mode: 'string' }),
	totalHoursToResolve: numeric("total_hours_to_resolve"),
}).as(sql`SELECT hr.id AS request_id, hr.receiver_user_id, hr.prompt, hr.status AS request_status, hr.attempts_count, hr.created_at AS request_created_at, count(gra.id) AS total_attempts, count( CASE WHEN gra.status::text = 'accepted'::text THEN 1 ELSE NULL::integer END) AS accepted_count, count( CASE WHEN gra.status::text = 'declined'::text THEN 1 ELSE NULL::integer END) AS declined_count, count( CASE WHEN gra.status::text = 'timeout'::text THEN 1 ELSE NULL::integer END) AS timeout_count, count( CASE WHEN gra.status::text = 'pending'::text THEN 1 ELSE NULL::integer END) AS pending_count, min(gra.notified_at) AS first_attempt_at, max(gra.responded_at) AS last_response_at, EXTRACT(epoch FROM max(gra.responded_at) - min(gra.notified_at)) / 3600::numeric AS total_hours_to_resolve FROM help_requests hr LEFT JOIN giver_request_attempts gra ON hr.id = gra.help_request_id WHERE hr.created_at > (now() - '30 days'::interval) GROUP BY hr.id, hr.receiver_user_id, hr.prompt, hr.status, hr.attempts_count, hr.created_at`);

export const callAnalytics = pgView("call_analytics", {	callDate: date("call_date"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	totalCalls: bigint("total_calls", { mode: "number" }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	successfulCalls: bigint("successful_calls", { mode: "number" }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	declinedCalls: bigint("declined_calls", { mode: "number" }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	missedCalls: bigint("missed_calls", { mode: "number" }),
	avgDurationSeconds: numeric("avg_duration_seconds"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	totalDurationSeconds: bigint("total_duration_seconds", { mode: "number" }),
}).as(sql`SELECT date(started_at) AS call_date, count(*) AS total_calls, count( CASE WHEN status = 'connected'::text THEN 1 ELSE NULL::integer END) AS successful_calls, count( CASE WHEN status = 'declined'::text THEN 1 ELSE NULL::integer END) AS declined_calls, count( CASE WHEN status = 'missed'::text THEN 1 ELSE NULL::integer END) AS missed_calls, avg(duration_seconds) AS avg_duration_seconds, sum(duration_seconds) AS total_duration_seconds FROM voice_calls WHERE started_at >= (CURRENT_DATE - '30 days'::interval) GROUP BY (date(started_at)) ORDER BY (date(started_at)) DESC`);

export const conversationAnalyticsView = pgView("conversation_analytics_view", {	date: date(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	totalConversations: bigint("total_conversations", { mode: "number" }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	resolvedConversations: bigint("resolved_conversations", { mode: "number" }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	escalatedConversations: bigint("escalated_conversations", { mode: "number" }),
	averageSatisfaction: numeric("average_satisfaction"),
	averageResponseTimeMinutes: numeric("average_response_time_minutes"),
	totalCost: numeric("total_cost"),
	aiEfficiencyScore: doublePrecision("ai_efficiency_score"),
}).as(sql`SELECT date(created_at) AS date, count(*) AS total_conversations, count(*) FILTER (WHERE status::text = 'resolved'::text) AS resolved_conversations, count(*) FILTER (WHERE status::text = 'escalated'::text) AS escalated_conversations, avg(satisfaction_rating) AS average_satisfaction, avg(EXTRACT(epoch FROM updated_at - created_at) / 60::numeric) AS average_response_time_minutes, sum(estimated_cost) AS total_cost, CASE WHEN count(*) > 0 THEN round((count(*) FILTER (WHERE status::text = 'resolved'::text)::double precision / count(*)::double precision * 100::double precision + (COALESCE(avg(satisfaction_rating), 0::numeric) * 20::numeric)::double precision + GREATEST(0::numeric, 100::numeric - avg(EXTRACT(epoch FROM updated_at - created_at) / 60::numeric))::double precision) / 3::double precision) ELSE 0::double precision END AS ai_efficiency_score FROM ai_conversations WHERE created_at >= (CURRENT_DATE - '30 days'::interval) GROUP BY (date(created_at)) ORDER BY (date(created_at)) DESC`);

export const crashSummary = pgView("crash_summary", {	date: date(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	totalCrashes: bigint("total_crashes", { mode: "number" }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	fatalCrashes: bigint("fatal_crashes", { mode: "number" }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	affectedUsers: bigint("affected_users", { mode: "number" }),
	appVersion: varchar("app_version", { length: 20 }),
	devicePlatform: varchar("device_platform", { length: 20 }),
}).as(sql`SELECT date(created_at) AS date, count(*) AS total_crashes, count( CASE WHEN is_fatal THEN 1 ELSE NULL::integer END) AS fatal_crashes, count(DISTINCT user_id) AS affected_users, app_version, device_platform FROM crash_reports GROUP BY (date(created_at)), app_version, device_platform ORDER BY (date(created_at)) DESC`);

export const dailyActiveUsers = pgView("daily_active_users", {	date: date(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	activeUsers: bigint("active_users", { mode: "number" }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	totalEvents: bigint("total_events", { mode: "number" }),
}).as(sql`SELECT date(created_at) AS date, count(DISTINCT user_id) AS active_users, count(*) AS total_events FROM analytics_events WHERE user_id IS NOT NULL GROUP BY (date(created_at)) ORDER BY (date(created_at)) DESC`);

export const featureAdoption = pgView("feature_adoption", {	featureName: varchar("feature_name", { length: 100 }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	uniqueUsers: bigint("unique_users", { mode: "number" }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	totalUsage: bigint("total_usage", { mode: "number" }),
	avgUsagePerUser: numeric("avg_usage_per_user"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	totalTimeSeconds: bigint("total_time_seconds", { mode: "number" }),
}).as(sql`SELECT feature_name, count(DISTINCT user_id) AS unique_users, sum(usage_count) AS total_usage, avg(usage_count) AS avg_usage_per_user, sum(total_time_seconds) AS total_time_seconds FROM feature_usage GROUP BY feature_name ORDER BY (count(DISTINCT user_id)) DESC`);

export const friendRequestsView = pgView("friend_requests_view", {	id: uuid(),
	senderId: uuid("sender_id"),
	receiverId: uuid("receiver_id"),
	status: varchar({ length: 20 }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }),
}).as(sql`SELECT id, sender_id, CASE WHEN sender_id = user1_id THEN user2_id ELSE user1_id END AS receiver_id, status, created_at, updated_at FROM friendships WHERE status::text = 'pending'::text`);

export const giverLeaderboard = pgView("giver_leaderboard", {	userId: uuid("user_id"),
	username: text(),
	firstName: text("first_name"),
	lastName: text("last_name"),
	totalHelpsGiven: integer("total_helps_given"),
	averageRating: numeric("average_rating", { precision: 3, scale:  2 }),
	isAvailable: boolean("is_available"),
	categories: text(),
	skills: text(),
}).as(sql`SELECT gp.user_id, p.username, p.first_name, p.last_name, gp.total_helps_given, gp.average_rating, gp.is_available, gp.categories, gp.skills FROM giver_profiles gp JOIN profiles p ON p.id = gp.user_id WHERE gp.total_helps_given > 0 ORDER BY gp.total_helps_given DESC, gp.average_rating DESC LIMIT 100`);

export const realTimeMetricsView = pgView("real_time_metrics_view", {	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	activeConversations: bigint("active_conversations", { mode: "number" }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	queueLength: bigint("queue_length", { mode: "number" }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	issuesResolvedToday: bigint("issues_resolved_today", { mode: "number" }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	escalationsToday: bigint("escalations_today", { mode: "number" }),
	currentSatisfactionScore: numeric("current_satisfaction_score"),
	agentUtilization: doublePrecision("agent_utilization"),
}).as(sql`SELECT ( SELECT count(*) AS count FROM ai_conversations WHERE ai_conversations.status::text = 'active'::text AND ai_conversations.updated_at >= (now() - '00:30:00'::interval)) AS active_conversations, ( SELECT count(*) AS count FROM ai_conversations WHERE ai_conversations.status::text = 'active'::text) AS queue_length, ( SELECT count(*) AS count FROM ai_conversations WHERE ai_conversations.status::text = 'resolved'::text AND date(ai_conversations.updated_at) = CURRENT_DATE) AS issues_resolved_today, ( SELECT count(*) AS count FROM ai_conversations WHERE ai_conversations.status::text = 'escalated'::text AND date(ai_conversations.created_at) = CURRENT_DATE) AS escalations_today, ( SELECT avg(satisfaction_ratings.rating) AS avg FROM satisfaction_ratings WHERE satisfaction_ratings.created_at >= (now() - '24:00:00'::interval)) AS current_satisfaction_score, ( SELECT avg(agent_capabilities.current_load::double precision / agent_capabilities.max_load::double precision * 100::double precision) AS avg FROM agent_capabilities WHERE agent_capabilities.availability::text = 'available'::text) AS agent_utilization`);

export const popularFeatures = pgMaterializedView("popular_features", {	featureName: text("feature_name"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	usageCount: bigint("usage_count", { mode: "number" }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	uniqueUsers: bigint("unique_users", { mode: "number" }),
	date: date(),
}).as(sql`SELECT properties ->> 'feature'::text AS feature_name, count(*) AS usage_count, count(DISTINCT user_id) AS unique_users, date(created_at) AS date FROM user_activity_events WHERE event_name = 'feature_usage'::text AND (properties ->> 'feature'::text) IS NOT NULL GROUP BY (properties ->> 'feature'::text), (date(created_at)) ORDER BY (count(*)) DESC`);

export const referralDashboard = pgView("referral_dashboard", {	userId: uuid("user_id"),
	username: text(),
	email: text(),
	referralCode: varchar("referral_code", { length: 12 }),
	totalReferrals: integer("total_referrals"),
	totalEarnings: numeric("total_earnings", { precision: 10, scale:  2 }),
	pendingEarnings: numeric("pending_earnings", { precision: 10, scale:  2 }),
	paidEarnings: numeric("paid_earnings", { precision: 10, scale:  2 }),
	upiId: varchar("upi_id", { length: 100 }),
	upiVerified: boolean("upi_verified"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	pendingCount: bigint("pending_count", { mode: "number" }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	approvedCount: bigint("approved_count", { mode: "number" }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	paidCount: bigint("paid_count", { mode: "number" }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	rejectedCount: bigint("rejected_count", { mode: "number" }),
}).as(sql`SELECT ur.user_id, p.username, p.email, ur.referral_code, ur.total_referrals, ur.total_earnings, ur.pending_earnings, ur.paid_earnings, ur.upi_id, ur.upi_verified, count( CASE WHEN rt.status::text = 'pending'::text THEN 1 ELSE NULL::integer END) AS pending_count, count( CASE WHEN rt.status::text = 'approved'::text THEN 1 ELSE NULL::integer END) AS approved_count, count( CASE WHEN rt.status::text = 'paid'::text THEN 1 ELSE NULL::integer END) AS paid_count, count( CASE WHEN rt.status::text = 'rejected'::text THEN 1 ELSE NULL::integer END) AS rejected_count FROM user_referrals ur JOIN profiles p ON ur.user_id = p.id LEFT JOIN referral_transactions rt ON ur.user_id = rt.referrer_user_id GROUP BY ur.user_id, p.username, p.email, ur.referral_code, ur.total_referrals, ur.total_earnings, ur.pending_earnings, ur.paid_earnings, ur.upi_id, ur.upi_verified`);

export const vActiveAnnouncements = pgView("v_active_announcements", {	id: uuid(),
	title: text(),
	message: text(),
	imageUrl: text("image_url"),
	linkUrl: text("link_url"),
	buttons: jsonb(),
	placements: text(),
	audience: text(),
	countries: text(),
	minAppVersion: text("min_app_version"),
	priority: integer(),
	startsAt: timestamp("starts_at", { withTimezone: true, mode: 'string' }),
	endsAt: timestamp("ends_at", { withTimezone: true, mode: 'string' }),
	isActive: boolean("is_active"),
	sendPushOnPublish: boolean("send_push_on_publish"),
	createdBy: uuid("created_by"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }),
	publishedAt: timestamp("published_at", { withTimezone: true, mode: 'string' }),
}).as(sql`SELECT id, title, message, image_url, link_url, buttons, placements, audience, countries, min_app_version, priority, starts_at, ends_at, is_active, send_push_on_publish, created_by, created_at, updated_at, published_at FROM announcements WHERE is_active = true AND (starts_at IS NULL OR now() >= starts_at) AND (ends_at IS NULL OR now() <= ends_at)`);

export const mvTopUsers = pgMaterializedView("mv_top_users", {	id: uuid(),
	firstName: text("first_name"),
	lastName: text("last_name"),
	username: text(),
	email: text(),
	profilePhotoUrl: text("profile_photo_url"),
	age: integer(),
	gender: text(),
	interests: text(),
	needs: text(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }),
	completenessScore: integer("completeness_score"),
}).as(sql`SELECT id, first_name, last_name, username, email, profile_photo_url, age, gender, interests, needs, created_at, updated_at, CASE WHEN first_name IS NOT NULL THEN 1 ELSE 0 END + CASE WHEN last_name IS NOT NULL THEN 1 ELSE 0 END + CASE WHEN profile_photo_url IS NOT NULL THEN 1 ELSE 0 END + CASE WHEN age IS NOT NULL THEN 1 ELSE 0 END + CASE WHEN gender IS NOT NULL THEN 1 ELSE 0 END + CASE WHEN interests IS NOT NULL AND array_length(interests, 1) > 0 THEN 2 ELSE 0 END + CASE WHEN needs IS NOT NULL AND array_length(needs, 1) > 0 THEN 2 ELSE 0 END AS completeness_score FROM profiles WHERE first_name IS NOT NULL AND last_name IS NOT NULL ORDER BY ( CASE WHEN first_name IS NOT NULL THEN 1 ELSE 0 END + CASE WHEN last_name IS NOT NULL THEN 1 ELSE 0 END + CASE WHEN profile_photo_url IS NOT NULL THEN 1 ELSE 0 END + CASE WHEN age IS NOT NULL THEN 1 ELSE 0 END + CASE WHEN gender IS NOT NULL THEN 1 ELSE 0 END + CASE WHEN interests IS NOT NULL AND array_length(interests, 1) > 0 THEN 2 ELSE 0 END + CASE WHEN needs IS NOT NULL AND array_length(needs, 1) > 0 THEN 2 ELSE 0 END) DESC, updated_at DESC`);