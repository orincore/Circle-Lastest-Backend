import { relations } from "drizzle-orm/relations";
import { profiles, analyticsEvents, appVersions, blindDateMatches, blindDateBlockedMessages, giverRequestAttempts, helpRequests, activityFeed, aiConversations, friendships, blindDateDailyQueue, blindDatingSettings, voiceCalls, chats, chatDeletions, chatUserSettings, feedbackAnalysis, followUpTasks, friendLocationNotifications, usersInAuth, exploreInteractions, escalationLogs, dailyMatchLimits, featureUsage, helpSessionFeedback, memes, memeComments, memeConnectRequests, memeLikes, messages, messageReactions, matchmakingProposals, memeShares, memeStats, messageViews, messageReceipts, userSubscriptions, promotionalSubscriptions, paymentTransactions, notifications, proactiveAlerts, satisfactionSurveys, surveyResponses, referralPaymentRequests, refunds, userActivities, satisfactionRatings, systemSettings, userConsent, userMatches, userReferrals, referralTransactions, referralCodeAttempts, userMemeAliases, subscriptionPlans, userProfileVisits, userSessions, voiceCallParticipants, memeAssets, nearbyNotifications, faceVerifications, adminRoles, crashReports, marketingCampaigns, campaignAnalytics, giverProfiles, userPhotos, marketingAutomationRules, adminAuditLogs, featureFlags, emailTemplates, pushTokens, userCampaignInteractions, userReports, userActivityEvents, userMarketingPreferences, userSegments, verificationAttempts, notificationTemplates, engagementNotifications, authSessions, jamSessionQueue, jamSessions, jamPlaylists, jamPlaylistTracks, memeSources, memeGenres, chatMembers, memeFeedViews, userSourceAffinity, userGenreAffinity, jamSessionParticipants } from "./schema.js";

export const analyticsEventsRelations = relations(analyticsEvents, ({one}) => ({
	profile: one(profiles, {
		fields: [analyticsEvents.userId],
		references: [profiles.id]
	}),
}));

export const profilesRelations = relations(profiles, ({one, many}) => ({
	analyticsEvents: many(analyticsEvents),
	appVersions: many(appVersions),
	blindDateBlockedMessages: many(blindDateBlockedMessages),
	giverRequestAttempts: many(giverRequestAttempts),
	activityFeeds: many(activityFeed),
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
	blindDateDailyQueues_matchedUserId: many(blindDateDailyQueue, {
		relationName: "blindDateDailyQueue_matchedUserId_profiles_id"
	}),
	blindDateDailyQueues_userId: many(blindDateDailyQueue, {
		relationName: "blindDateDailyQueue_userId_profiles_id"
	}),
	blindDatingSettings: many(blindDatingSettings),
	voiceCalls_callerId: many(voiceCalls, {
		relationName: "voiceCalls_callerId_profiles_id"
	}),
	voiceCalls_receiverId: many(voiceCalls, {
		relationName: "voiceCalls_receiverId_profiles_id"
	}),
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
	chatUserSettings: many(chatUserSettings),
	followUpTasks: many(followUpTasks),
	friendLocationNotifications_fromUserId: many(friendLocationNotifications, {
		relationName: "friendLocationNotifications_fromUserId_profiles_id"
	}),
	friendLocationNotifications_toUserId: many(friendLocationNotifications, {
		relationName: "friendLocationNotifications_toUserId_profiles_id"
	}),
	escalationLogs: many(escalationLogs),
	dailyMatchLimits: many(dailyMatchLimits),
	featureUsages: many(featureUsage),
	helpSessionFeedbacks_giverUserId: many(helpSessionFeedback, {
		relationName: "helpSessionFeedback_giverUserId_profiles_id"
	}),
	helpSessionFeedbacks_receiverUserId: many(helpSessionFeedback, {
		relationName: "helpSessionFeedback_receiverUserId_profiles_id"
	}),
	memeComments: many(memeComments),
	memeConnectRequests_requesterId: many(memeConnectRequests, {
		relationName: "memeConnectRequests_requesterId_profiles_id"
	}),
	memeConnectRequests_targetId: many(memeConnectRequests, {
		relationName: "memeConnectRequests_targetId_profiles_id"
	}),
	memeLikes: many(memeLikes),
	matchmakingProposals_a: many(matchmakingProposals, {
		relationName: "matchmakingProposals_a_profiles_id"
	}),
	matchmakingProposals_b: many(matchmakingProposals, {
		relationName: "matchmakingProposals_b_profiles_id"
	}),
	memeShares: many(memeShares),
	promotionalSubscriptions: many(promotionalSubscriptions),
	paymentTransactions: many(paymentTransactions),
	notifications_recipientId: many(notifications, {
		relationName: "notifications_recipientId_profiles_id"
	}),
	notifications_senderId: many(notifications, {
		relationName: "notifications_senderId_profiles_id"
	}),
	proactiveAlerts: many(proactiveAlerts),
	referralPaymentRequests_processedBy: many(referralPaymentRequests, {
		relationName: "referralPaymentRequests_processedBy_profiles_id"
	}),
	referralPaymentRequests_userId: many(referralPaymentRequests, {
		relationName: "referralPaymentRequests_userId_profiles_id"
	}),
	refunds_processedBy: many(refunds, {
		relationName: "refunds_processedBy_profiles_id"
	}),
	refunds_userId: many(refunds, {
		relationName: "refunds_userId_profiles_id"
	}),
	userActivities_relatedUserId: many(userActivities, {
		relationName: "userActivities_relatedUserId_profiles_id"
	}),
	userActivities_userId: many(userActivities, {
		relationName: "userActivities_userId_profiles_id"
	}),
	satisfactionRatings: many(satisfactionRatings),
	systemSettings: many(systemSettings),
	userConsents: many(userConsent),
	userMatches_user1Id: many(userMatches, {
		relationName: "userMatches_user1Id_profiles_id"
	}),
	userMatches_user2Id: many(userMatches, {
		relationName: "userMatches_user2Id_profiles_id"
	}),
	userReferrals: many(userReferrals),
	referralTransactions_referredUserId: many(referralTransactions, {
		relationName: "referralTransactions_referredUserId_profiles_id"
	}),
	referralTransactions_referrerUserId: many(referralTransactions, {
		relationName: "referralTransactions_referrerUserId_profiles_id"
	}),
	referralTransactions_verifiedBy: many(referralTransactions, {
		relationName: "referralTransactions_verifiedBy_profiles_id"
	}),
	referralCodeAttempts: many(referralCodeAttempts),
	userMemeAliases: many(userMemeAliases),
	userSubscriptions: many(userSubscriptions),
	userProfileVisits_visitedUserId: many(userProfileVisits, {
		relationName: "userProfileVisits_visitedUserId_profiles_id"
	}),
	userProfileVisits_visitorId: many(userProfileVisits, {
		relationName: "userProfileVisits_visitorId_profiles_id"
	}),
	userSessions: many(userSessions),
	voiceCallParticipants: many(voiceCallParticipants),
	nearbyNotifications_fromUserId: many(nearbyNotifications, {
		relationName: "nearbyNotifications_fromUserId_profiles_id"
	}),
	nearbyNotifications_toUserId: many(nearbyNotifications, {
		relationName: "nearbyNotifications_toUserId_profiles_id"
	}),
	faceVerifications_reviewedBy: many(faceVerifications, {
		relationName: "faceVerifications_reviewedBy_profiles_id"
	}),
	faceVerifications_userId: many(faceVerifications, {
		relationName: "faceVerifications_userId_profiles_id"
	}),
	adminRoles_grantedBy: many(adminRoles, {
		relationName: "adminRoles_grantedBy_profiles_id"
	}),
	adminRoles_userId: many(adminRoles, {
		relationName: "adminRoles_userId_profiles_id"
	}),
	crashReports_resolvedBy: many(crashReports, {
		relationName: "crashReports_resolvedBy_profiles_id"
	}),
	crashReports_userId: many(crashReports, {
		relationName: "crashReports_userId_profiles_id"
	}),
	giverProfiles: many(giverProfiles),
	userPhotos: many(userPhotos),
	marketingAutomationRules: many(marketingAutomationRules),
	adminAuditLogs: many(adminAuditLogs),
	featureFlags: many(featureFlags),
	emailTemplates: many(emailTemplates),
	helpRequests_matchedGiverId: many(helpRequests, {
		relationName: "helpRequests_matchedGiverId_profiles_id"
	}),
	helpRequests_receiverUserId: many(helpRequests, {
		relationName: "helpRequests_receiverUserId_profiles_id"
	}),
	pushTokens: many(pushTokens),
	userCampaignInteractions: many(userCampaignInteractions),
	userReports_moderatorId: many(userReports, {
		relationName: "userReports_moderatorId_profiles_id"
	}),
	userReports_reportedUserId: many(userReports, {
		relationName: "userReports_reportedUserId_profiles_id"
	}),
	userReports_reporterId: many(userReports, {
		relationName: "userReports_reporterId_profiles_id"
	}),
	userActivityEvents: many(userActivityEvents),
	userMarketingPreferences: many(userMarketingPreferences),
	userSegments: many(userSegments),
	verificationAttempts: many(verificationAttempts),
	notificationTemplates: many(notificationTemplates),
	marketingCampaigns: many(marketingCampaigns),
	engagementNotifications_recipientId: many(engagementNotifications, {
		relationName: "engagementNotifications_recipientId_profiles_id"
	}),
	engagementNotifications_relatedUserId: many(engagementNotifications, {
		relationName: "engagementNotifications_relatedUserId_profiles_id"
	}),
	authSessions: many(authSessions),
	jamSessions: many(jamSessions),
	jamSessionQueues: many(jamSessionQueue),
	jamPlaylists: many(jamPlaylists),
	jamPlaylistTracks: many(jamPlaylistTracks),
	memes: many(memes),
	memeFeedViews: many(memeFeedViews),
	userSourceAffinities: many(userSourceAffinity),
	userGenreAffinities: many(userGenreAffinity),
	jamSessionParticipants: many(jamSessionParticipants),
}));

export const appVersionsRelations = relations(appVersions, ({one}) => ({
	profile: one(profiles, {
		fields: [appVersions.userId],
		references: [profiles.id]
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

export const blindDateMatchesRelations = relations(blindDateMatches, ({one, many}) => ({
	blindDateBlockedMessages: many(blindDateBlockedMessages),
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

export const activityFeedRelations = relations(activityFeed, ({one}) => ({
	profile: one(profiles, {
		fields: [activityFeed.userId],
		references: [profiles.id]
	}),
}));

export const aiConversationsRelations = relations(aiConversations, ({one, many}) => ({
	profile: one(profiles, {
		fields: [aiConversations.userId],
		references: [profiles.id]
	}),
	feedbackAnalyses: many(feedbackAnalysis),
	followUpTasks: many(followUpTasks),
	escalationLogs: many(escalationLogs),
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

export const blindDatingSettingsRelations = relations(blindDatingSettings, ({one}) => ({
	profile: one(profiles, {
		fields: [blindDatingSettings.userId],
		references: [profiles.id]
	}),
}));

export const voiceCallsRelations = relations(voiceCalls, ({one, many}) => ({
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
	voiceCallParticipants: many(voiceCallParticipants),
}));

export const chatsRelations = relations(chats, ({many}) => ({
	blindDateMatches: many(blindDateMatches),
	chatDeletions: many(chatDeletions),
	chatUserSettings: many(chatUserSettings),
	helpSessionFeedbacks: many(helpSessionFeedback),
	memeConnectRequests: many(memeConnectRequests),
	messages: many(messages),
	helpRequests: many(helpRequests),
	userReports: many(userReports),
	jamSessions: many(jamSessions),
	jamPlaylists: many(jamPlaylists),
	chatMembers: many(chatMembers),
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

export const feedbackAnalysisRelations = relations(feedbackAnalysis, ({one}) => ({
	aiConversation: one(aiConversations, {
		fields: [feedbackAnalysis.conversationId],
		references: [aiConversations.id]
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

export const dailyMatchLimitsRelations = relations(dailyMatchLimits, ({one}) => ({
	profile: one(profiles, {
		fields: [dailyMatchLimits.userId],
		references: [profiles.id]
	}),
}));

export const featureUsageRelations = relations(featureUsage, ({one}) => ({
	profile: one(profiles, {
		fields: [featureUsage.userId],
		references: [profiles.id]
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

export const memesRelations = relations(memes, ({one, many}) => ({
	memeComments: many(memeComments),
	memeConnectRequests: many(memeConnectRequests),
	memeLikes: many(memeLikes),
	messages: many(messages),
	memeShares: many(memeShares),
	memeStats: many(memeStats),
	memeAssets: many(memeAssets),
	engagementNotifications: many(engagementNotifications),
	memeSource: one(memeSources, {
		fields: [memes.sourceId],
		references: [memeSources.id]
	}),
	profile: one(profiles, {
		fields: [memes.uploaderUserId],
		references: [profiles.id]
	}),
	memeGenres: many(memeGenres),
	memeFeedViews: many(memeFeedViews),
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
	messageViews: many(messageViews),
	messageReceipts: many(messageReceipts),
	userReports: many(userReports),
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

export const memeStatsRelations = relations(memeStats, ({one}) => ({
	meme: one(memes, {
		fields: [memeStats.memeId],
		references: [memes.id]
	}),
}));

export const messageViewsRelations = relations(messageViews, ({one}) => ({
	message: one(messages, {
		fields: [messageViews.messageId],
		references: [messages.id]
	}),
}));

export const messageReceiptsRelations = relations(messageReceipts, ({one}) => ({
	message: one(messages, {
		fields: [messageReceipts.messageId],
		references: [messages.id]
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

export const userSubscriptionsRelations = relations(userSubscriptions, ({one, many}) => ({
	promotionalSubscriptions: many(promotionalSubscriptions),
	paymentTransactions: many(paymentTransactions),
	refunds: many(refunds),
	subscriptionPlan: one(subscriptionPlans, {
		fields: [userSubscriptions.planId],
		references: [subscriptionPlans.planId]
	}),
	profile: one(profiles, {
		fields: [userSubscriptions.userId],
		references: [profiles.id]
	}),
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

export const proactiveAlertsRelations = relations(proactiveAlerts, ({one}) => ({
	profile: one(profiles, {
		fields: [proactiveAlerts.userId],
		references: [profiles.id]
	}),
}));

export const surveyResponsesRelations = relations(surveyResponses, ({one}) => ({
	satisfactionSurvey: one(satisfactionSurveys, {
		fields: [surveyResponses.surveyId],
		references: [satisfactionSurveys.id]
	}),
}));

export const satisfactionSurveysRelations = relations(satisfactionSurveys, ({one, many}) => ({
	surveyResponses: many(surveyResponses),
	aiConversation: one(aiConversations, {
		fields: [satisfactionSurveys.conversationId],
		references: [aiConversations.id]
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

export const systemSettingsRelations = relations(systemSettings, ({one}) => ({
	profile: one(profiles, {
		fields: [systemSettings.updatedBy],
		references: [profiles.id]
	}),
}));

export const userConsentRelations = relations(userConsent, ({one}) => ({
	profile: one(profiles, {
		fields: [userConsent.userId],
		references: [profiles.id]
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

export const userReferralsRelations = relations(userReferrals, ({one}) => ({
	profile: one(profiles, {
		fields: [userReferrals.userId],
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

export const referralCodeAttemptsRelations = relations(referralCodeAttempts, ({one}) => ({
	profile: one(profiles, {
		fields: [referralCodeAttempts.attemptedByUserId],
		references: [profiles.id]
	}),
}));

export const userMemeAliasesRelations = relations(userMemeAliases, ({one}) => ({
	profile: one(profiles, {
		fields: [userMemeAliases.userId],
		references: [profiles.id]
	}),
}));

export const subscriptionPlansRelations = relations(subscriptionPlans, ({many}) => ({
	userSubscriptions: many(userSubscriptions),
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

export const userSessionsRelations = relations(userSessions, ({one}) => ({
	profile: one(profiles, {
		fields: [userSessions.userId],
		references: [profiles.id]
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

export const memeAssetsRelations = relations(memeAssets, ({one}) => ({
	meme: one(memes, {
		fields: [memeAssets.memeId],
		references: [memes.id]
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

export const campaignAnalyticsRelations = relations(campaignAnalytics, ({one}) => ({
	marketingCampaign: one(marketingCampaigns, {
		fields: [campaignAnalytics.campaignId],
		references: [marketingCampaigns.id]
	}),
}));

export const marketingCampaignsRelations = relations(marketingCampaigns, ({one, many}) => ({
	campaignAnalytics: many(campaignAnalytics),
	userCampaignInteractions: many(userCampaignInteractions),
	profile: one(profiles, {
		fields: [marketingCampaigns.createdBy],
		references: [profiles.id]
	}),
}));

export const giverProfilesRelations = relations(giverProfiles, ({one}) => ({
	profile: one(profiles, {
		fields: [giverProfiles.userId],
		references: [profiles.id]
	}),
}));

export const userPhotosRelations = relations(userPhotos, ({one}) => ({
	profile: one(profiles, {
		fields: [userPhotos.userId],
		references: [profiles.id]
	}),
}));

export const marketingAutomationRulesRelations = relations(marketingAutomationRules, ({one}) => ({
	profile: one(profiles, {
		fields: [marketingAutomationRules.createdBy],
		references: [profiles.id]
	}),
}));

export const adminAuditLogsRelations = relations(adminAuditLogs, ({one}) => ({
	profile: one(profiles, {
		fields: [adminAuditLogs.adminId],
		references: [profiles.id]
	}),
}));

export const featureFlagsRelations = relations(featureFlags, ({one}) => ({
	profile: one(profiles, {
		fields: [featureFlags.createdBy],
		references: [profiles.id]
	}),
}));

export const emailTemplatesRelations = relations(emailTemplates, ({one}) => ({
	profile: one(profiles, {
		fields: [emailTemplates.createdBy],
		references: [profiles.id]
	}),
}));

export const pushTokensRelations = relations(pushTokens, ({one}) => ({
	profile: one(profiles, {
		fields: [pushTokens.userId],
		references: [profiles.id]
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

export const userActivityEventsRelations = relations(userActivityEvents, ({one}) => ({
	profile: one(profiles, {
		fields: [userActivityEvents.userId],
		references: [profiles.id]
	}),
}));

export const userMarketingPreferencesRelations = relations(userMarketingPreferences, ({one}) => ({
	profile: one(profiles, {
		fields: [userMarketingPreferences.userId],
		references: [profiles.id]
	}),
}));

export const userSegmentsRelations = relations(userSegments, ({one}) => ({
	profile: one(profiles, {
		fields: [userSegments.createdBy],
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

export const notificationTemplatesRelations = relations(notificationTemplates, ({one}) => ({
	profile: one(profiles, {
		fields: [notificationTemplates.createdBy],
		references: [profiles.id]
	}),
}));

export const engagementNotificationsRelations = relations(engagementNotifications, ({one}) => ({
	profile_recipientId: one(profiles, {
		fields: [engagementNotifications.recipientId],
		references: [profiles.id],
		relationName: "engagementNotifications_recipientId_profiles_id"
	}),
	meme: one(memes, {
		fields: [engagementNotifications.relatedMemeId],
		references: [memes.id]
	}),
	profile_relatedUserId: one(profiles, {
		fields: [engagementNotifications.relatedUserId],
		references: [profiles.id],
		relationName: "engagementNotifications_relatedUserId_profiles_id"
	}),
}));

export const authSessionsRelations = relations(authSessions, ({one}) => ({
	profile: one(profiles, {
		fields: [authSessions.userId],
		references: [profiles.id]
	}),
}));

export const jamSessionsRelations = relations(jamSessions, ({one, many}) => ({
	jamSessionQueue: one(jamSessionQueue, {
		fields: [jamSessions.currentQueueItemId],
		references: [jamSessionQueue.id],
		relationName: "jamSessions_currentQueueItemId_jamSessionQueue_id"
	}),
	chat: one(chats, {
		fields: [jamSessions.chatId],
		references: [chats.id]
	}),
	profile: one(profiles, {
		fields: [jamSessions.startedBy],
		references: [profiles.id]
	}),
	jamSessionQueues: many(jamSessionQueue, {
		relationName: "jamSessionQueue_sessionId_jamSessions_id"
	}),
	jamSessionParticipants: many(jamSessionParticipants),
}));

export const jamSessionQueueRelations = relations(jamSessionQueue, ({one, many}) => ({
	jamSessions: many(jamSessions, {
		relationName: "jamSessions_currentQueueItemId_jamSessionQueue_id"
	}),
	profile: one(profiles, {
		fields: [jamSessionQueue.addedBy],
		references: [profiles.id]
	}),
	jamSession: one(jamSessions, {
		fields: [jamSessionQueue.sessionId],
		references: [jamSessions.id],
		relationName: "jamSessionQueue_sessionId_jamSessions_id"
	}),
}));

export const jamPlaylistsRelations = relations(jamPlaylists, ({one, many}) => ({
	chat: one(chats, {
		fields: [jamPlaylists.chatId],
		references: [chats.id]
	}),
	profile: one(profiles, {
		fields: [jamPlaylists.createdBy],
		references: [profiles.id]
	}),
	jamPlaylistTracks: many(jamPlaylistTracks),
}));

export const jamPlaylistTracksRelations = relations(jamPlaylistTracks, ({one}) => ({
	profile: one(profiles, {
		fields: [jamPlaylistTracks.addedBy],
		references: [profiles.id]
	}),
	jamPlaylist: one(jamPlaylists, {
		fields: [jamPlaylistTracks.playlistId],
		references: [jamPlaylists.id]
	}),
}));

export const memeSourcesRelations = relations(memeSources, ({many}) => ({
	memes: many(memes),
	userSourceAffinities: many(userSourceAffinity),
}));

export const memeGenresRelations = relations(memeGenres, ({one}) => ({
	meme: one(memes, {
		fields: [memeGenres.memeId],
		references: [memes.id]
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

export const userGenreAffinityRelations = relations(userGenreAffinity, ({one}) => ({
	profile: one(profiles, {
		fields: [userGenreAffinity.userId],
		references: [profiles.id]
	}),
}));

export const jamSessionParticipantsRelations = relations(jamSessionParticipants, ({one}) => ({
	jamSession: one(jamSessions, {
		fields: [jamSessionParticipants.sessionId],
		references: [jamSessions.id]
	}),
	profile: one(profiles, {
		fields: [jamSessionParticipants.userId],
		references: [profiles.id]
	}),
}));