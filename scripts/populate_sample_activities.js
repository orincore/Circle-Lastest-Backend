import { createActivity } from '../src/server/services/activityService.js'

async function populateSampleActivities() {
  
  try {
    // Sample activities to show the variety of events
    const sampleActivities = [
      {
        type: 'user_joined',
        data: {
          user_id: 'sample-user-1',
          user_name: 'Alice',
          age: 25,
          location: 'San Francisco',
        },
        user_id: 'sample-user-1',
      },
      {
        type: 'user_matched',
        data: {
          user1_id: 'sample-user-2',
          user1_name: 'Bob',
          user2_id: 'sample-user-3',
          user2_name: 'Charlie',
        },
        user_id: 'sample-user-2',
      },
      {
        type: 'friends_connected',
        data: {
          user1_id: 'sample-user-4',
          user1_name: 'Diana',
          user2_id: 'sample-user-5',
          user2_name: 'Eve',
        },
        user_id: 'sample-user-4',
      },
      {
        type: 'location_updated',
        data: {
          user_id: 'sample-user-6',
          user_name: 'Frank',
          location: 'Tokyo, Japan',
        },
        user_id: 'sample-user-6',
      },
      {
        type: 'interest_updated',
        data: {
          user_id: 'sample-user-7',
          user_name: 'Grace',
          interests: ['art', 'music', 'travel'],
          interest_count: 3,
        },
        user_id: 'sample-user-7',
      },
      {
        type: 'profile_visited',
        data: {
          visitor_id: 'sample-user-8',
          visitor_name: 'Henry',
          profile_id: 'sample-user-9',
          profile_name: 'Ivy',
        },
        user_id: 'sample-user-8',
      },
      {
        type: 'friend_request_sent',
        data: {
          sender_id: 'sample-user-10',
          sender_name: 'Jack',
          receiver_id: 'sample-user-11',
          receiver_name: 'Kate',
        },
        user_id: 'sample-user-10',
      },
      {
        type: 'chat_started',
        data: {
          user1_id: 'sample-user-12',
          user1_name: 'Liam',
          user2_id: 'sample-user-13',
          user2_name: 'Mia',
        },
        user_id: 'sample-user-12',
      },
    ]

    // Add activities with some delay to create realistic timestamps
    for (let i = 0; i < sampleActivities.length; i++) {
      const activity = sampleActivities[i]
      
      // Add timestamp with some variation
      activity.timestamp = new Date(Date.now() - (i * 5 * 60 * 1000)).toISOString() // 5 minutes apart
      
      await createActivity(activity)
      
      // Small delay to avoid rate limiting
      await new Promise(resolve => setTimeout(resolve, 100))
    }

    
  } catch (error) {
    console.error('❌ Error populating sample activities:', error)
    process.exit(1)
  }
}

// Run the script
populateSampleActivities().then(() => {
  process.exit(0)
}).catch(error => {
  console.error('❌ Script failed:', error)
  process.exit(1)
})
