import { relations } from "drizzle-orm/relations";
import { subscriptionPlans, userSubscriptions, profiles, paymentTransactions, refunds, memeSources, memes, memeAssets, userMemeAliases, memeLikes, memeComments, chats, memeConnectRequests, memeStats, memeShares, activityFeed, adminAuditLogs, analyticsEvents, adminRoles, aiConversations, friendships, giverRequestAttempts, helpRequests, appVersions, crashReports, blindDateMatches, blindDateDailyQueue, dailyMatchLimits, blindDatingSettings, chatUserSettings, marketingCampaigns, campaignAnalytics, escalationLogs, chatDeletions, emailTemplates, featureUsage, giverProfiles, followUpTasks, feedbackAnalysis, friendLocationNotifications, helpSessionFeedback, messages, messageReactions, featureFlags, usersInAuth, exploreInteractions, faceVerifications, marketingAutomationRules, referralTransactions, promotionalSubscriptions, proactiveAlerts, messageReceipts, referralCodeAttempts, satisfactionRatings, userReferrals, userActivityEvents, notifications, messageViews, nearbyNotifications, notificationTemplates, pushTokens, satisfactionSurveys, surveyResponses, userPhotos, userConsent, userActivities, userCampaignInteractions, userMarketingPreferences, userReports, userMatches, systemSettings, referralPaymentRequests, userProfileVisits, voiceCalls, voiceCallParticipants, userSessions, verificationAttempts, blindDateBlockedMessages, matchmakingProposals, userSegments, chatMembers, memeFeedViews, userSourceAffinity } from "./schema.js";

export const userSubscriptionsRelations = relations(userSubscriptions, ({one, many}) => ({
	subscriptionPlan: one(subscriptionPlans, {
		fields: [userSubscriptions.planId],
		references: [subscriptionPlans.planId]
	}),
	profile: one(profiles, {
		fields: [userSubscriptions.userId],
		references: [profiles.id]
	}),
	paymentTransactions: many(paymentTransactions),
	refunds: many(refunds),
	promotionalSubscriptions: many(promotionalSubscriptions),
}));

export const subscriptionPlansRelations = relations(subscriptionPlans, ({many}) => ({
	userSubscriptions: many(userSubscriptions),
}));

export const profilesRelations = relations(profiles, ({one, many}) => ({
	userSubscriptions: many(userSubscriptions),
	paymentTransactions: many(paymentTransactions),
	refunds_processedBy: many(refunds, {
		relationName: "refunds_processedBy_profiles_id"
	}),
	refunds_userId: many(refunds, {
		relationName: "refunds_userId_profiles_id"
	}),
	userMemeAliases: many(userMemeAliases),
	memeLikes: many(memeLikes),
	memeComments: many(memeComments),
	memeConnectRequests_requesterId: many(memeConnectRequests, {
		relationName: "memeConnectRequests_requesterId_profiles_id"
	}),
	memeConnectRequests_targetId: many(memeConnectRequests, {
		relationName: "memeConnectRequests_targetId_profiles_id"
	}),
	memeShares: many(memeShares),
	activityFeeds: many(activityFeed),
	adminAuditLogs: many(adminAuditLogs),
	analyticsEvents: many(analyticsEvents),
	adminRoles_grantedBy: many(adminRoles, {
		relationName: "adminRoles_grantedBy_profiles_id"
	}),
	adminRoles_userId: many(adminRoles, {
		relationName: "adminRoles_userId_profiles_id"
	}),
	aiConversations: many(aiConversations),
	friendships_user1Id: many(friendships, {
		relationName: "friendships_user1Id_profiles_id"
	}),
	friendships_user2Id: many(friendships, {
		relationName: "friendships_user2Id_profiles_id"
	}),
	friendships_senderId: many(friendships, {
		relationName: "friendships_senderId_profiles_id"
	}),
	giverRequestAttempts: many(giverRequestAttempts),
	profile_deletedBy: one(profiles, {
		fields: [profiles.deletedBy],
		references: [profiles.id],
		relationName: "profiles_deletedBy_profiles_id"
	}),
	profiles_deletedBy: many(profiles, {
		relationName: "profiles_deletedBy_profiles_id"
	}),
	profile_suspendedBy: one(profiles, {
		fields: [profiles.suspendedBy],
		references: [profiles.id],
		relationName: "profiles_suspendedBy_profiles_id"
	}),
	profiles_suspendedBy: many(profiles, {
		relationName: "profiles_suspendedBy_profiles_id"
	}),
	appVersions: many(appVersions),
	crashReports_resolvedBy: many(crashReports, {
		relationName: "crashReports_resolvedBy_profiles_id"
	}),
	crashReports_userId: many(crashReports, {
		relationName: "crashReports_userId_profiles_id"
	}),
	blindDateDailyQueues_matchedUserId: many(blindDateDailyQueue, {
		relationName: "blindDateDailyQueue_matchedUserId_profiles_id"
	}),
	blindDateDailyQueues_userId: many(blindDateDailyQueue, {
		relationName: "blindDateDailyQueue_userId_profiles_id"
	}),
	dailyMatchLimits: many(dailyMatchLimits),
	blindDatingSettings: many(blindDatingSettings),
	chatUserSettings: many(chatUserSettings),
	escalationLogs: many(escalationLogs),
	blindDateMatches_endedBy: many(blindDateMatches, {
		relationName: "blindDateMatches_endedBy_profiles_id"
	}),
	blindDateMatches_revealRequestedBy: many(blindDateMatches, {
		relationName: "blindDateMatches_revealRequestedBy_profiles_id"
	}),
	blindDateMatches_userA: many(blindDateMatches, {
		relationName: "blindDateMatches_userA_profiles_id"
	}),
	blindDateMatches_userB: many(blindDateMatches, {
		relationName: "blindDateMatches_userB_profiles_id"
	}),
	chatDeletions: many(chatDeletions),
	emailTemplates: many(emailTemplates),
	featureUsages: many(featureUsage),
	giverProfiles: many(giverProfiles),
	followUpTasks: many(followUpTasks),
	friendLocationNotifications_fromUserId: many(friendLocationNotifications, {
		relationName: "friendLocationNotifications_fromUserId_profiles_id"
	}),
	friendLocationNotifications_toUserId: many(friendLocationNotifications, {
		relationName: "friendLocationNotifications_toUserId_profiles_id"
	}),
	marketingCampaigns: many(marketingCampaigns),
	helpSessionFeedbacks_giverUserId: many(helpSessionFeedback, {
		relationName: "helpSessionFeedback_giverUserId_profiles_id"
	}),
	helpSessionFeedbacks_receiverUserId: many(helpSessionFeedback, {
		relationName: "helpSessionFeedback_receiverUserId_profiles_id"
	}),
	featureFlags: many(featureFlags),
	faceVerifications_reviewedBy: many(faceVerifications, {
		relationName: "faceVerifications_reviewedBy_profiles_id"
	}),
	faceVerifications_userId: many(faceVerifications, {
		relationName: "faceVerifications_userId_profiles_id"
	}),
	marketingAutomationRules: many(marketingAutomationRules),
	referralTransactions_referredUserId: many(referralTransactions, {
		relationName: "referralTransactions_referredUserId_profiles_id"
	}),
	referralTransactions_referrerUserId: many(referralTransactions, {
		relationName: "referralTransactions_referrerUserId_profiles_id"
	}),
	referralTransactions_verifiedBy: many(referralTransactions, {
		relationName: "referralTransactions_verifiedBy_profiles_id"
	}),
	promotionalSubscriptions: many(promotionalSubscriptions),
	proactiveAlerts: many(proactiveAlerts),
	referralCodeAttempts: many(referralCodeAttempts),
	satisfactionRatings: many(satisfactionRatings),
	userReferrals: many(userReferrals),
	userActivityEvents: many(userActivityEvents),
	notifications_recipientId: many(notifications, {
		relationName: "notifications_recipientId_profiles_id"
	}),
	notifications_senderId: many(notifications, {
		relationName: "notifications_senderId_profiles_id"
	}),
	nearbyNotifications_fromUserId: many(nearbyNotifications, {
		relationName: "nearbyNotifications_fromUserId_profiles_id"
	}),
	nearbyNotifications_toUserId: many(nearbyNotifications, {
		relationName: "nearbyNotifications_toUserId_profiles_id"
	}),
	notificationTemplates: many(notificationTemplates),
	pushTokens: many(pushTokens),
	userPhotos: many(userPhotos),
	userConsents: many(userConsent),
	userActivities_relatedUserId: many(userActivities, {
		relationName: "userActivities_relatedUserId_profiles_id"
	}),
	userActivities_userId: many(userActivities, {
		relationName: "userActivities_userId_profiles_id"
	}),
	userCampaignInteractions: many(userCampaignInteractions),
	userMarketingPreferences: many(userMarketingPreferences),
	userReports_moderatorId: many(userReports, {
		relationName: "userReports_moderatorId_profiles_id"
	}),
	userReports_reportedUserId: many(userReports, {
		relationName: "userReports_reportedUserId_profiles_id"
	}),
	userReports_reporterId: many(userReports, {
		relationName: "userReports_reporterId_profiles_id"
	}),
	userMatches_user1Id: many(userMatches, {
		relationName: "userMatches_user1Id_profiles_id"
	}),
	userMatches_user2Id: many(userMatches, {
		relationName: "userMatches_user2Id_profiles_id"
	}),
	systemSettings: many(systemSettings),
	referralPaymentRequests_processedBy: many(referralPaymentRequests, {
		relationName: "referralPaymentRequests_processedBy_profiles_id"
	}),
	referralPaymentRequests_userId: many(referralPaymentRequests, {
		relationName: "referralPaymentRequests_userId_profiles_id"
	}),
	userProfileVisits_visitedUserId: many(userProfileVisits, {
		relationName: "userProfileVisits_visitedUserId_profiles_id"
	}),
	userProfileVisits_visitorId: many(userProfileVisits, {
		relationName: "userProfileVisits_visitorId_profiles_id"
	}),
	voiceCallParticipants: many(voiceCallParticipants),
	userSessions: many(userSessions),
	verificationAttempts: many(verificationAttempts),
	voiceCalls_callerId: many(voiceCalls, {
		relationName: "voiceCalls_callerId_profiles_id"
	}),
	voiceCalls_receiverId: many(voiceCalls, {
		relationName: "voiceCalls_receiverId_profiles_id"
	}),
	blindDateBlockedMessages: many(blindDateBlockedMessages),
	matchmakingProposals_a: many(matchmakingProposals, {
		relationName: "matchmakingProposals_a_profiles_id"
	}),
	matchmakingProposals_b: many(matchmakingProposals, {
		relationName: "matchmakingProposals_b_profiles_id"
	}),
	userSegments: many(userSegments),
	helpRequests_matchedGiverId: many(helpRequests, {
		relationName: "helpRequests_matchedGiverId_profiles_id"
	}),
	helpRequests_receiverUserId: many(helpRequests, {
		relationName: "helpRequests_receiverUserId_profiles_id"
	}),
	memeFeedViews: many(memeFeedViews),
	userSourceAffinities: many(userSourceAffinity),
}));

export const paymentTransactionsRelations = relations(paymentTransactions, ({one, many}) => ({
	userSubscription: one(userSubscriptions, {
		fields: [paymentTransactions.subscriptionId],
		references: [userSubscriptions.id]
	}),
	profile: one(profiles, {
		fields: [paymentTransactions.userId],
		references: [profiles.id]
	}),
	refunds: many(refunds),
}));

export const refundsRelations = relations(refunds, ({one}) => ({
	profile_processedBy: one(profiles, {
		fields: [refunds.processedBy],
		references: [profiles.id],
		relationName: "refunds_processedBy_profiles_id"
	}),
	userSubscription: one(userSubscriptions, {
		fields: [refunds.subscriptionId],
		references: [userSubscriptions.id]
	}),
	paymentTransaction: one(paymentTransactions, {
		fields: [refunds.transactionId],
		references: [paymentTransactions.id]
	}),
	profile_userId: one(profiles, {
		fields: [refunds.userId],
		references: [profiles.id],
		relationName: "refunds_userId_profiles_id"
	}),
}));

export const memesRelations = relations(memes, ({one, many}) => ({
	memeSource: one(memeSources, {
		fields: [memes.sourceId],
		references: [memeSources.id]
	}),
	memeAssets: many(memeAssets),
	memeLikes: many(memeLikes),
	memeComments: many(memeComments),
	memeConnectRequests: many(memeConnectRequests),
	memeStats: many(memeStats),
	memeShares: many(memeShares),
	messages: many(messages),
	memeFeedViews: many(memeFeedViews),
}));

export const memeSourcesRelations = relations(memeSources, ({many}) => ({
	memes: many(memes),
	userSourceAffinities: many(userSourceAffinity),
}));

export const memeAssetsRelations = relations(memeAssets, ({one}) => ({
	meme: one(memes, {
		fields: [memeAssets.memeId],
		references: [memes.id]
	}),
}));

export const userMemeAliasesRelations = relations(userMemeAliases, ({one}) => ({
	profile: one(profiles, {
		fields: [userMemeAliases.userId],
		references: [profiles.id]
	}),
}));

export const memeLikesRelations = relations(memeLikes, ({one}) => ({
	meme: one(memes, {
		fields: [memeLikes.memeId],
		references: [memes.id]
	}),
	profile: one(profiles, {
		fields: [memeLikes.userId],
		references: [profiles.id]
	}),
}));

export const memeCommentsRelations = relations(memeComments, ({one, many}) => ({
	meme: one(memes, {
		fields: [memeComments.memeId],
		references: [memes.id]
	}),
	memeComment: one(memeComments, {
		fields: [memeComments.parentCommentId],
		references: [memeComments.id],
		relationName: "memeComments_parentCommentId_memeComments_id"
	}),
	memeComments: many(memeComments, {
		relationName: "memeComments_parentCommentId_memeComments_id"
	}),
	profile: one(profiles, {
		fields: [memeComments.userId],
		references: [profiles.id]
	}),
}));

export const memeConnectRequestsRelations = relations(memeConnectRequests, ({one}) => ({
	chat: one(chats, {
		fields: [memeConnectRequests.chatId],
		references: [chats.id]
	}),
	meme: one(memes, {
		fields: [memeConnectRequests.contextMemeId],
		references: [memes.id]
	}),
	profile_requesterId: one(profiles, {
		fields: [memeConnectRequests.requesterId],
		references: [profiles.id],
		relationName: "memeConnectRequests_requesterId_profiles_id"
	}),
	profile_targetId: one(profiles, {
		fields: [memeConnectRequests.targetId],
		references: [profiles.id],
		relationName: "memeConnectRequests_targetId_profiles_id"
	}),
}));

export const chatsRelations = relations(chats, ({many}) => ({
	memeConnectRequests: many(memeConnectRequests),
	chatUserSettings: many(chatUserSettings),
	blindDateMatches: many(blindDateMatches),
	chatDeletions: many(chatDeletions),
	helpSessionFeedbacks: many(helpSessionFeedback),
	messages: many(messages),
	userReports: many(userReports),
	helpRequests: many(helpRequests),
	chatMembers: many(chatMembers),
}));

export const memeStatsRelations = relations(memeStats, ({one}) => ({
	meme: one(memes, {
		fields: [memeStats.memeId],
		references: [memes.id]
	}),
}));

export const memeSharesRelations = relations(memeShares, ({one}) => ({
	meme: one(memes, {
		fields: [memeShares.memeId],
		references: [memes.id]
	}),
	profile: one(profiles, {
		fields: [memeShares.userId],
		references: [profiles.id]
	}),
}));

export const activityFeedRelations = relations(activityFeed, ({one}) => ({
	profile: one(profiles, {
		fields: [activityFeed.userId],
		references: [profiles.id]
	}),
}));

export const adminAuditLogsRelations = relations(adminAuditLogs, ({one}) => ({
	profile: one(profiles, {
		fields: [adminAuditLogs.adminId],
		references: [profiles.id]
	}),
}));

export const analyticsEventsRelations = relations(analyticsEvents, ({one}) => ({
	profile: one(profiles, {
		fields: [analyticsEvents.userId],
		references: [profiles.id]
	}),
}));

export const adminRolesRelations = relations(adminRoles, ({one}) => ({
	profile_grantedBy: one(profiles, {
		fields: [adminRoles.grantedBy],
		references: [profiles.id],
		relationName: "adminRoles_grantedBy_profiles_id"
	}),
	profile_userId: one(profiles, {
		fields: [adminRoles.userId],
		references: [profiles.id],
		relationName: "adminRoles_userId_profiles_id"
	}),
}));

export const aiConversationsRelations = relations(aiConversations, ({one, many}) => ({
	profile: one(profiles, {
		fields: [aiConversations.userId],
		references: [profiles.id]
	}),
	escalationLogs: many(escalationLogs),
	followUpTasks: many(followUpTasks),
	feedbackAnalyses: many(feedbackAnalysis),
	satisfactionRatings: many(satisfactionRatings),
	satisfactionSurveys: many(satisfactionSurveys),
}));

export const friendshipsRelations = relations(friendships, ({one}) => ({
	profile_user1Id: one(profiles, {
		fields: [friendships.user1Id],
		references: [profiles.id],
		relationName: "friendships_user1Id_profiles_id"
	}),
	profile_user2Id: one(profiles, {
		fields: [friendships.user2Id],
		references: [profiles.id],
		relationName: "friendships_user2Id_profiles_id"
	}),
	profile_senderId: one(profiles, {
		fields: [friendships.senderId],
		references: [profiles.id],
		relationName: "friendships_senderId_profiles_id"
	}),
}));

export const giverRequestAttemptsRelations = relations(giverRequestAttempts, ({one}) => ({
	profile: one(profiles, {
		fields: [giverRequestAttempts.giverUserId],
		references: [profiles.id]
	}),
	helpRequest: one(helpRequests, {
		fields: [giverRequestAttempts.helpRequestId],
		references: [helpRequests.id]
	}),
}));

export const helpRequestsRelations = relations(helpRequests, ({one, many}) => ({
	giverRequestAttempts: many(giverRequestAttempts),
	helpSessionFeedbacks: many(helpSessionFeedback),
	chat: one(chats, {
		fields: [helpRequests.chatRoomId],
		references: [chats.id]
	}),
	profile_matchedGiverId: one(profiles, {
		fields: [helpRequests.matchedGiverId],
		references: [profiles.id],
		relationName: "helpRequests_matchedGiverId_profiles_id"
	}),
	profile_receiverUserId: one(profiles, {
		fields: [helpRequests.receiverUserId],
		references: [profiles.id],
		relationName: "helpRequests_receiverUserId_profiles_id"
	}),
}));

export const appVersionsRelations = relations(appVersions, ({one}) => ({
	profile: one(profiles, {
		fields: [appVersions.userId],
		references: [profiles.id]
	}),
}));

export const crashReportsRelations = relations(crashReports, ({one}) => ({
	profile_resolvedBy: one(profiles, {
		fields: [crashReports.resolvedBy],
		references: [profiles.id],
		relationName: "crashReports_resolvedBy_profiles_id"
	}),
	profile_userId: one(profiles, {
		fields: [crashReports.userId],
		references: [profiles.id],
		relationName: "crashReports_userId_profiles_id"
	}),
}));

export const blindDateDailyQueueRelations = relations(blindDateDailyQueue, ({one}) => ({
	blindDateMatch: one(blindDateMatches, {
		fields: [blindDateDailyQueue.matchId],
		references: [blindDateMatches.id]
	}),
	profile_matchedUserId: one(profiles, {
		fields: [blindDateDailyQueue.matchedUserId],
		references: [profiles.id],
		relationName: "blindDateDailyQueue_matchedUserId_profiles_id"
	}),
	profile_userId: one(profiles, {
		fields: [blindDateDailyQueue.userId],
		references: [profiles.id],
		relationName: "blindDateDailyQueue_userId_profiles_id"
	}),
}));

export const blindDateMatchesRelations = relations(blindDateMatches, ({one, many}) => ({
	blindDateDailyQueues: many(blindDateDailyQueue),
	chat: one(chats, {
		fields: [blindDateMatches.chatId],
		references: [chats.id]
	}),
	profile_endedBy: one(profiles, {
		fields: [blindDateMatches.endedBy],
		references: [profiles.id],
		relationName: "blindDateMatches_endedBy_profiles_id"
	}),
	profile_revealRequestedBy: one(profiles, {
		fields: [blindDateMatches.revealRequestedBy],
		references: [profiles.id],
		relationName: "blindDateMatches_revealRequestedBy_profiles_id"
	}),
	profile_userA: one(profiles, {
		fields: [blindDateMatches.userA],
		references: [profiles.id],
		relationName: "blindDateMatches_userA_profiles_id"
	}),
	profile_userB: one(profiles, {
		fields: [blindDateMatches.userB],
		references: [profiles.id],
		relationName: "blindDateMatches_userB_profiles_id"
	}),
	blindDateBlockedMessages: many(blindDateBlockedMessages),
}));

export const dailyMatchLimitsRelations = relations(dailyMatchLimits, ({one}) => ({
	profile: one(profiles, {
		fields: [dailyMatchLimits.userId],
		references: [profiles.id]
	}),
}));

export const blindDatingSettingsRelations = relations(blindDatingSettings, ({one}) => ({
	profile: one(profiles, {
		fields: [blindDatingSettings.userId],
		references: [profiles.id]
	}),
}));

export const chatUserSettingsRelations = relations(chatUserSettings, ({one}) => ({
	chat: one(chats, {
		fields: [chatUserSettings.chatId],
		references: [chats.id]
	}),
	profile: one(profiles, {
		fields: [chatUserSettings.userId],
		references: [profiles.id]
	}),
}));

export const campaignAnalyticsRelations = relations(campaignAnalytics, ({one}) => ({
	marketingCampaign: one(marketingCampaigns, {
		fields: [campaignAnalytics.campaignId],
		references: [marketingCampaigns.id]
	}),
}));

export const marketingCampaignsRelations = relations(marketingCampaigns, ({one, many}) => ({
	campaignAnalytics: many(campaignAnalytics),
	profile: one(profiles, {
		fields: [marketingCampaigns.createdBy],
		references: [profiles.id]
	}),
	userCampaignInteractions: many(userCampaignInteractions),
}));

export const escalationLogsRelations = relations(escalationLogs, ({one}) => ({
	aiConversation: one(aiConversations, {
		fields: [escalationLogs.conversationId],
		references: [aiConversations.id]
	}),
	profile: one(profiles, {
		fields: [escalationLogs.userId],
		references: [profiles.id]
	}),
}));

export const chatDeletionsRelations = relations(chatDeletions, ({one}) => ({
	chat: one(chats, {
		fields: [chatDeletions.chatId],
		references: [chats.id]
	}),
	profile: one(profiles, {
		fields: [chatDeletions.userId],
		references: [profiles.id]
	}),
}));

export const emailTemplatesRelations = relations(emailTemplates, ({one}) => ({
	profile: one(profiles, {
		fields: [emailTemplates.createdBy],
		references: [profiles.id]
	}),
}));

export const featureUsageRelations = relations(featureUsage, ({one}) => ({
	profile: one(profiles, {
		fields: [featureUsage.userId],
		references: [profiles.id]
	}),
}));

export const giverProfilesRelations = relations(giverProfiles, ({one}) => ({
	profile: one(profiles, {
		fields: [giverProfiles.userId],
		references: [profiles.id]
	}),
}));

export const followUpTasksRelations = relations(followUpTasks, ({one}) => ({
	aiConversation: one(aiConversations, {
		fields: [followUpTasks.conversationId],
		references: [aiConversations.id]
	}),
	profile: one(profiles, {
		fields: [followUpTasks.userId],
		references: [profiles.id]
	}),
}));

export const feedbackAnalysisRelations = relations(feedbackAnalysis, ({one}) => ({
	aiConversation: one(aiConversations, {
		fields: [feedbackAnalysis.conversationId],
		references: [aiConversations.id]
	}),
}));

export const friendLocationNotificationsRelations = relations(friendLocationNotifications, ({one}) => ({
	profile_fromUserId: one(profiles, {
		fields: [friendLocationNotifications.fromUserId],
		references: [profiles.id],
		relationName: "friendLocationNotifications_fromUserId_profiles_id"
	}),
	profile_toUserId: one(profiles, {
		fields: [friendLocationNotifications.toUserId],
		references: [profiles.id],
		relationName: "friendLocationNotifications_toUserId_profiles_id"
	}),
}));

export const helpSessionFeedbackRelations = relations(helpSessionFeedback, ({one}) => ({
	chat: one(chats, {
		fields: [helpSessionFeedback.chatRoomId],
		references: [chats.id]
	}),
	profile_giverUserId: one(profiles, {
		fields: [helpSessionFeedback.giverUserId],
		references: [profiles.id],
		relationName: "helpSessionFeedback_giverUserId_profiles_id"
	}),
	helpRequest: one(helpRequests, {
		fields: [helpSessionFeedback.helpRequestId],
		references: [helpRequests.id]
	}),
	profile_receiverUserId: one(profiles, {
		fields: [helpSessionFeedback.receiverUserId],
		references: [profiles.id],
		relationName: "helpSessionFeedback_receiverUserId_profiles_id"
	}),
}));

export const messageReactionsRelations = relations(messageReactions, ({one}) => ({
	message: one(messages, {
		fields: [messageReactions.messageId],
		references: [messages.id]
	}),
}));

export const messagesRelations = relations(messages, ({one, many}) => ({
	messageReactions: many(messageReactions),
	chat: one(chats, {
		fields: [messages.chatId],
		references: [chats.id]
	}),
	message: one(messages, {
		fields: [messages.replyToId],
		references: [messages.id],
		relationName: "messages_replyToId_messages_id"
	}),
	messages: many(messages, {
		relationName: "messages_replyToId_messages_id"
	}),
	meme: one(memes, {
		fields: [messages.sharedMemeId],
		references: [memes.id]
	}),
	messageReceipts: many(messageReceipts),
	messageViews: many(messageViews),
	userReports: many(userReports),
}));

export const featureFlagsRelations = relations(featureFlags, ({one}) => ({
	profile: one(profiles, {
		fields: [featureFlags.createdBy],
		references: [profiles.id]
	}),
}));

export const exploreInteractionsRelations = relations(exploreInteractions, ({one}) => ({
	usersInAuth_targetUserId: one(usersInAuth, {
		fields: [exploreInteractions.targetUserId],
		references: [usersInAuth.id],
		relationName: "exploreInteractions_targetUserId_usersInAuth_id"
	}),
	usersInAuth_userId: one(usersInAuth, {
		fields: [exploreInteractions.userId],
		references: [usersInAuth.id],
		relationName: "exploreInteractions_userId_usersInAuth_id"
	}),
}));

export const usersInAuthRelations = relations(usersInAuth, ({many}) => ({
	exploreInteractions_targetUserId: many(exploreInteractions, {
		relationName: "exploreInteractions_targetUserId_usersInAuth_id"
	}),
	exploreInteractions_userId: many(exploreInteractions, {
		relationName: "exploreInteractions_userId_usersInAuth_id"
	}),
}));

export const faceVerificationsRelations = relations(faceVerifications, ({one, many}) => ({
	profile_reviewedBy: one(profiles, {
		fields: [faceVerifications.reviewedBy],
		references: [profiles.id],
		relationName: "faceVerifications_reviewedBy_profiles_id"
	}),
	profile_userId: one(profiles, {
		fields: [faceVerifications.userId],
		references: [profiles.id],
		relationName: "faceVerifications_userId_profiles_id"
	}),
	verificationAttempts: many(verificationAttempts),
}));

export const marketingAutomationRulesRelations = relations(marketingAutomationRules, ({one}) => ({
	profile: one(profiles, {
		fields: [marketingAutomationRules.createdBy],
		references: [profiles.id]
	}),
}));

export const referralTransactionsRelations = relations(referralTransactions, ({one}) => ({
	profile_referredUserId: one(profiles, {
		fields: [referralTransactions.referredUserId],
		references: [profiles.id],
		relationName: "referralTransactions_referredUserId_profiles_id"
	}),
	profile_referrerUserId: one(profiles, {
		fields: [referralTransactions.referrerUserId],
		references: [profiles.id],
		relationName: "referralTransactions_referrerUserId_profiles_id"
	}),
	profile_verifiedBy: one(profiles, {
		fields: [referralTransactions.verifiedBy],
		references: [profiles.id],
		relationName: "referralTransactions_verifiedBy_profiles_id"
	}),
}));

export const promotionalSubscriptionsRelations = relations(promotionalSubscriptions, ({one}) => ({
	userSubscription: one(userSubscriptions, {
		fields: [promotionalSubscriptions.subscriptionId],
		references: [userSubscriptions.id]
	}),
	profile: one(profiles, {
		fields: [promotionalSubscriptions.userId],
		references: [profiles.id]
	}),
}));

export const proactiveAlertsRelations = relations(proactiveAlerts, ({one}) => ({
	profile: one(profiles, {
		fields: [proactiveAlerts.userId],
		references: [profiles.id]
	}),
}));

export const messageReceiptsRelations = relations(messageReceipts, ({one}) => ({
	message: one(messages, {
		fields: [messageReceipts.messageId],
		references: [messages.id]
	}),
}));

export const referralCodeAttemptsRelations = relations(referralCodeAttempts, ({one}) => ({
	profile: one(profiles, {
		fields: [referralCodeAttempts.attemptedByUserId],
		references: [profiles.id]
	}),
}));

export const satisfactionRatingsRelations = relations(satisfactionRatings, ({one}) => ({
	aiConversation: one(aiConversations, {
		fields: [satisfactionRatings.conversationId],
		references: [aiConversations.id]
	}),
	profile: one(profiles, {
		fields: [satisfactionRatings.userId],
		references: [profiles.id]
	}),
}));

export const userReferralsRelations = relations(userReferrals, ({one}) => ({
	profile: one(profiles, {
		fields: [userReferrals.userId],
		references: [profiles.id]
	}),
}));

export const userActivityEventsRelations = relations(userActivityEvents, ({one}) => ({
	profile: one(profiles, {
		fields: [userActivityEvents.userId],
		references: [profiles.id]
	}),
}));

export const notificationsRelations = relations(notifications, ({one}) => ({
	profile_recipientId: one(profiles, {
		fields: [notifications.recipientId],
		references: [profiles.id],
		relationName: "notifications_recipientId_profiles_id"
	}),
	profile_senderId: one(profiles, {
		fields: [notifications.senderId],
		references: [profiles.id],
		relationName: "notifications_senderId_profiles_id"
	}),
}));

export const messageViewsRelations = relations(messageViews, ({one}) => ({
	message: one(messages, {
		fields: [messageViews.messageId],
		references: [messages.id]
	}),
}));

export const nearbyNotificationsRelations = relations(nearbyNotifications, ({one}) => ({
	profile_fromUserId: one(profiles, {
		fields: [nearbyNotifications.fromUserId],
		references: [profiles.id],
		relationName: "nearbyNotifications_fromUserId_profiles_id"
	}),
	profile_toUserId: one(profiles, {
		fields: [nearbyNotifications.toUserId],
		references: [profiles.id],
		relationName: "nearbyNotifications_toUserId_profiles_id"
	}),
}));

export const notificationTemplatesRelations = relations(notificationTemplates, ({one}) => ({
	profile: one(profiles, {
		fields: [notificationTemplates.createdBy],
		references: [profiles.id]
	}),
}));

export const pushTokensRelations = relations(pushTokens, ({one}) => ({
	profile: one(profiles, {
		fields: [pushTokens.userId],
		references: [profiles.id]
	}),
}));

export const satisfactionSurveysRelations = relations(satisfactionSurveys, ({one, many}) => ({
	aiConversation: one(aiConversations, {
		fields: [satisfactionSurveys.conversationId],
		references: [aiConversations.id]
	}),
	surveyResponses: many(surveyResponses),
}));

export const surveyResponsesRelations = relations(surveyResponses, ({one}) => ({
	satisfactionSurvey: one(satisfactionSurveys, {
		fields: [surveyResponses.surveyId],
		references: [satisfactionSurveys.id]
	}),
}));

export const userPhotosRelations = relations(userPhotos, ({one}) => ({
	profile: one(profiles, {
		fields: [userPhotos.userId],
		references: [profiles.id]
	}),
}));

export const userConsentRelations = relations(userConsent, ({one}) => ({
	profile: one(profiles, {
		fields: [userConsent.userId],
		references: [profiles.id]
	}),
}));

export const userActivitiesRelations = relations(userActivities, ({one}) => ({
	profile_relatedUserId: one(profiles, {
		fields: [userActivities.relatedUserId],
		references: [profiles.id],
		relationName: "userActivities_relatedUserId_profiles_id"
	}),
	profile_userId: one(profiles, {
		fields: [userActivities.userId],
		references: [profiles.id],
		relationName: "userActivities_userId_profiles_id"
	}),
}));

export const userCampaignInteractionsRelations = relations(userCampaignInteractions, ({one}) => ({
	marketingCampaign: one(marketingCampaigns, {
		fields: [userCampaignInteractions.campaignId],
		references: [marketingCampaigns.id]
	}),
	profile: one(profiles, {
		fields: [userCampaignInteractions.userId],
		references: [profiles.id]
	}),
}));

export const userMarketingPreferencesRelations = relations(userMarketingPreferences, ({one}) => ({
	profile: one(profiles, {
		fields: [userMarketingPreferences.userId],
		references: [profiles.id]
	}),
}));

export const userReportsRelations = relations(userReports, ({one}) => ({
	chat: one(chats, {
		fields: [userReports.chatId],
		references: [chats.id]
	}),
	message: one(messages, {
		fields: [userReports.messageId],
		references: [messages.id]
	}),
	profile_moderatorId: one(profiles, {
		fields: [userReports.moderatorId],
		references: [profiles.id],
		relationName: "userReports_moderatorId_profiles_id"
	}),
	profile_reportedUserId: one(profiles, {
		fields: [userReports.reportedUserId],
		references: [profiles.id],
		relationName: "userReports_reportedUserId_profiles_id"
	}),
	profile_reporterId: one(profiles, {
		fields: [userReports.reporterId],
		references: [profiles.id],
		relationName: "userReports_reporterId_profiles_id"
	}),
}));

export const userMatchesRelations = relations(userMatches, ({one}) => ({
	profile_user1Id: one(profiles, {
		fields: [userMatches.user1Id],
		references: [profiles.id],
		relationName: "userMatches_user1Id_profiles_id"
	}),
	profile_user2Id: one(profiles, {
		fields: [userMatches.user2Id],
		references: [profiles.id],
		relationName: "userMatches_user2Id_profiles_id"
	}),
}));

export const systemSettingsRelations = relations(systemSettings, ({one}) => ({
	profile: one(profiles, {
		fields: [systemSettings.updatedBy],
		references: [profiles.id]
	}),
}));

export const referralPaymentRequestsRelations = relations(referralPaymentRequests, ({one}) => ({
	profile_processedBy: one(profiles, {
		fields: [referralPaymentRequests.processedBy],
		references: [profiles.id],
		relationName: "referralPaymentRequests_processedBy_profiles_id"
	}),
	profile_userId: one(profiles, {
		fields: [referralPaymentRequests.userId],
		references: [profiles.id],
		relationName: "referralPaymentRequests_userId_profiles_id"
	}),
}));

export const userProfileVisitsRelations = relations(userProfileVisits, ({one}) => ({
	profile_visitedUserId: one(profiles, {
		fields: [userProfileVisits.visitedUserId],
		references: [profiles.id],
		relationName: "userProfileVisits_visitedUserId_profiles_id"
	}),
	profile_visitorId: one(profiles, {
		fields: [userProfileVisits.visitorId],
		references: [profiles.id],
		relationName: "userProfileVisits_visitorId_profiles_id"
	}),
}));

export const voiceCallParticipantsRelations = relations(voiceCallParticipants, ({one}) => ({
	voiceCall: one(voiceCalls, {
		fields: [voiceCallParticipants.callId],
		references: [voiceCalls.callId]
	}),
	profile: one(profiles, {
		fields: [voiceCallParticipants.userId],
		references: [profiles.id]
	}),
}));

export const voiceCallsRelations = relations(voiceCalls, ({one, many}) => ({
	voiceCallParticipants: many(voiceCallParticipants),
	profile_callerId: one(profiles, {
		fields: [voiceCalls.callerId],
		references: [profiles.id],
		relationName: "voiceCalls_callerId_profiles_id"
	}),
	profile_receiverId: one(profiles, {
		fields: [voiceCalls.receiverId],
		references: [profiles.id],
		relationName: "voiceCalls_receiverId_profiles_id"
	}),
}));

export const userSessionsRelations = relations(userSessions, ({one}) => ({
	profile: one(profiles, {
		fields: [userSessions.userId],
		references: [profiles.id]
	}),
}));

export const verificationAttemptsRelations = relations(verificationAttempts, ({one}) => ({
	profile: one(profiles, {
		fields: [verificationAttempts.userId],
		references: [profiles.id]
	}),
	faceVerification: one(faceVerifications, {
		fields: [verificationAttempts.verificationId],
		references: [faceVerifications.id]
	}),
}));

export const blindDateBlockedMessagesRelations = relations(blindDateBlockedMessages, ({one}) => ({
	blindDateMatch: one(blindDateMatches, {
		fields: [blindDateBlockedMessages.blindDateId],
		references: [blindDateMatches.id]
	}),
	profile: one(profiles, {
		fields: [blindDateBlockedMessages.senderId],
		references: [profiles.id]
	}),
}));

export const matchmakingProposalsRelations = relations(matchmakingProposals, ({one}) => ({
	profile_a: one(profiles, {
		fields: [matchmakingProposals.a],
		references: [profiles.id],
		relationName: "matchmakingProposals_a_profiles_id"
	}),
	profile_b: one(profiles, {
		fields: [matchmakingProposals.b],
		references: [profiles.id],
		relationName: "matchmakingProposals_b_profiles_id"
	}),
}));

export const userSegmentsRelations = relations(userSegments, ({one}) => ({
	profile: one(profiles, {
		fields: [userSegments.createdBy],
		references: [profiles.id]
	}),
}));

export const chatMembersRelations = relations(chatMembers, ({one}) => ({
	chat: one(chats, {
		fields: [chatMembers.chatId],
		references: [chats.id]
	}),
}));

export const memeFeedViewsRelations = relations(memeFeedViews, ({one}) => ({
	meme: one(memes, {
		fields: [memeFeedViews.memeId],
		references: [memes.id]
	}),
	profile: one(profiles, {
		fields: [memeFeedViews.userId],
		references: [profiles.id]
	}),
}));

export const userSourceAffinityRelations = relations(userSourceAffinity, ({one}) => ({
	memeSource: one(memeSources, {
		fields: [userSourceAffinity.sourceId],
		references: [memeSources.id]
	}),
	profile: one(profiles, {
		fields: [userSourceAffinity.userId],
		references: [profiles.id]
	}),
}));