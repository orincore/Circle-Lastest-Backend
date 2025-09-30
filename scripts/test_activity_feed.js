import { createActivity, trackUserJoined, trackUserMatched, trackFriendsConnected } from '../src/server/services/activityService.js'

async function testActivityFeed() {
  console.log('🧪 Testing Live Activity Feed...')
  
  try {
    // Test 1: Create a basic activity
    console.log('\n1. Testing basic activity creation...')
    await createActivity({
      type: 'user_joined',
      data: {
        user_id: 'test-user-1',
        user_name: 'Alice',
        age: 25,
        location: 'San Francisco'
      },
      user_id: 'test-user-1'
    })
    console.log('✅ Basic activity created successfully')

    // Test 2: Test user matched activity
    console.log('\n2. Testing user matched activity...')
    const user1 = {
      id: 'test-user-1',
      first_name: 'Alice'
    }
    const user2 = {
      id: 'test-user-2', 
      first_name: 'Bob'
    }
    await trackUserMatched(user1, user2)
    console.log('✅ User matched activity created successfully')

    // Test 3: Test friends connected activity
    console.log('\n3. Testing friends connected activity...')
    await trackFriendsConnected(user1, user2)
    console.log('✅ Friends connected activity created successfully')

    // Test 4: Test user joined activity
    console.log('\n4. Testing user joined activity...')
    const newUser = {
      id: 'test-user-3',
      first_name: 'Charlie',
      age: 28,
      location_city: 'New York'
    }
    await trackUserJoined(newUser)
    console.log('✅ User joined activity created successfully')

    console.log('\n🎉 All activity feed tests passed!')
    
  } catch (error) {
    console.error('❌ Activity feed test failed:', error)
    process.exit(1)
  }
}

// Run the test
testActivityFeed().then(() => {
  console.log('\n✅ Activity feed testing completed')
  process.exit(0)
}).catch(error => {
  console.error('❌ Test execution failed:', error)
  process.exit(1)
})
