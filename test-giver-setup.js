#!/usr/bin/env node

/**
 * Test script to create a giver profile for Help Connect testing
 * Run this to set up a test giver with "developing apps and websites" in their profile
 */

import fetch from 'node-fetch';

const API_BASE_URL = process.env.API_BASE_URL || 'http://localhost:3001';

// Test user credentials - replace with actual test user
const TEST_USER = {
  email: 'testgiver@example.com',
  password: 'testpassword123'
};

async function loginUser() {
  try {
    const response = await fetch(`${API_BASE_URL}/api/auth/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        email: TEST_USER.email,
        password: TEST_USER.password
      })
    });

    if (!response.ok) {
      throw new Error(`Login failed: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    return data.token;
  } catch (error) {
    console.error('❌ Login failed:', error.message);
    throw error;
  }
}

async function createGiverProfile(token) {
  try {
    // First, set up giver profile with skills
    const setupResponse = await fetch(`${API_BASE_URL}/api/match/giver/setup`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({
        skills: ['web development', 'mobile apps', 'javascript', 'react', 'node.js'],
        categories: ['tech', 'programming', 'career']
      })
    });

    if (!setupResponse.ok) {
      const errorText = await setupResponse.text();
      throw new Error(`Giver setup failed: ${setupResponse.status} ${errorText}`);
    }

    const setupData = await setupResponse.json();
    console.log('✅ Giver profile created:', setupData);

    // Then, toggle availability to true
    const toggleResponse = await fetch(`${API_BASE_URL}/api/match/giver/toggle`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({
        isAvailable: true
      })
    });

    if (!toggleResponse.ok) {
      const errorText = await toggleResponse.text();
      throw new Error(`Toggle availability failed: ${toggleResponse.status} ${errorText}`);
    }

    const toggleData = await toggleResponse.json();
    console.log('✅ Giver availability set:', toggleData);

    return { setupData, toggleData };
  } catch (error) {
    console.error('❌ Giver profile creation failed:', error.message);
    throw error;
  }
}

async function updateUserProfile(token) {
  try {
    // Update user profile to include "developing apps and websites" in about section
    const response = await fetch(`${API_BASE_URL}/api/profiles/update`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({
        about: 'I love developing apps and websites. I have experience with React, Node.js, and mobile development. Always happy to help others learn programming!',
        interests: ['programming', 'web development', 'mobile apps', 'technology', 'helping others'],
        needs: ['learning new technologies', 'networking with developers']
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.warn('⚠️ Profile update failed (this is optional):', response.status, errorText);
      return null;
    }

    const data = await response.json();
    console.log('✅ User profile updated with relevant bio');
    return data;
  } catch (error) {
    console.warn('⚠️ Profile update failed (this is optional):', error.message);
    return null;
  }
}

async function main() {
  try {
    console.log('🚀 Setting up test giver profile...');
    console.log(`📡 API Base URL: ${API_BASE_URL}`);
    
    // Step 1: Login
    console.log('\n1️⃣ Logging in test user...');
    const token = await loginUser();
    console.log('✅ Login successful');

    // Step 2: Update user profile (optional)
    console.log('\n2️⃣ Updating user profile...');
    await updateUserProfile(token);

    // Step 3: Create giver profile
    console.log('\n3️⃣ Creating giver profile...');
    const result = await createGiverProfile(token);

    console.log('\n🎉 Test giver setup complete!');
    console.log('📝 Summary:');
    console.log('   - User profile updated with "developing apps and websites"');
    console.log('   - Giver profile created with web development skills');
    console.log('   - Giver availability set to true');
    console.log('\n💡 Now you can test Help Connect with prompt: "I need help in developing apps"');

  } catch (error) {
    console.error('\n💥 Setup failed:', error.message);
    console.log('\n🔧 Troubleshooting:');
    console.log('   1. Make sure the backend server is running');
    console.log('   2. Check that the test user exists and credentials are correct');
    console.log('   3. Verify the API_BASE_URL is correct');
    process.exit(1);
  }
}

// Run the script
main();
