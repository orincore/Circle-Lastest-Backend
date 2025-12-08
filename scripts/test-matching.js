#!/usr/bin/env node

/**
 * Test script to verify the matching algorithm works
 */

import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'

// Load environment variables
config()

const supabaseUrl = process.env.SUPABASE_URL
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!supabaseUrl || !supabaseServiceKey) {
  console.error('❌ Missing Supabase environment variables')
  process.exit(1)
}

const supabase = createClient(supabaseUrl, supabaseServiceKey)

/**
 * Generate semantic embedding (same logic as in service)
 */
function generateSemanticEmbedding(text) {
  const cleanText = text.toLowerCase().trim()
  const embedding = new Array(1536).fill(0)
  
  const keywordCategories = {
    programming: ['coding', 'programming', 'development', 'software', 'app', 'website', 'web', 'mobile', 'frontend', 'backend', 'fullstack', 'javascript', 'python', 'react', 'node', 'database', 'api', 'debug', 'bug', 'code', 'developer', 'tech', 'technology'],
    career: ['career', 'job', 'work', 'business', 'professional', 'interview', 'resume', 'cv', 'promotion', 'salary', 'workplace', 'management', 'leadership', 'entrepreneur'],
    health: ['health', 'fitness', 'workout', 'exercise', 'diet', 'nutrition', 'weight', 'gym', 'running', 'yoga', 'meditation', 'mental health', 'wellness'],
    relationships: ['relationship', 'dating', 'love', 'friendship', 'family', 'social', 'communication', 'conflict', 'advice', 'support'],
    education: ['education', 'learning', 'study', 'school', 'university', 'course', 'tutorial', 'teaching', 'knowledge', 'skill', 'training'],
    finance: ['finance', 'money', 'investment', 'investing', 'stocks', 'crypto', 'budget', 'savings', 'financial', 'economy', 'trading'],
    creative: ['creative', 'art', 'design', 'music', 'writing', 'photography', 'video', 'content', 'marketing', 'brand'],
    lifestyle: ['lifestyle', 'personal', 'motivation', 'goals', 'habits', 'productivity', 'time management', 'organization']
  }
  
  // Calculate semantic scores
  Object.entries(keywordCategories).forEach(([category, keywords], categoryIndex) => {
    let categoryScore = 0
    
    keywords.forEach(keyword => {
      if (cleanText.includes(keyword)) {
        const frequency = (cleanText.match(new RegExp(keyword, 'g')) || []).length
        categoryScore += frequency * (keyword.length / 10)
      }
    })
    
    const startDim = categoryIndex * 192
    for (let i = 0; i < 192; i++) {
      embedding[startDim + i] = categoryScore * Math.sin((i + 1) * Math.PI / 192)
    }
  })
  
  // Add text features
  const textLength = cleanText.length
  const wordCount = cleanText.split(/\s+/).length
  const uniqueWords = new Set(cleanText.split(/\s+/)).size
  
  for (let i = 1536 - 64; i < 1536; i++) {
    const featureIndex = i - (1536 - 64)
    if (featureIndex < 20) {
      embedding[i] = textLength / 1000
    } else if (featureIndex < 40) {
      embedding[i] = wordCount / 100
    } else {
      embedding[i] = uniqueWords / wordCount
    }
  }
  
  // Normalize
  const magnitude = Math.sqrt(embedding.reduce((sum, val) => sum + val * val, 0))
  if (magnitude > 0) {
    for (let i = 0; i < embedding.length; i++) {
      embedding[i] = embedding[i] / magnitude
    }
  }
  
  return embedding
}

async function testMatching() {
  try {
    console.log('🧪 Testing matching algorithm...\n')
    
    // Test prompt
    const testPrompt = "I need someone to help me in coding"
    console.log(`📝 Test prompt: "${testPrompt}"`)
    
    // Generate embedding for test prompt
    const promptEmbedding = generateSemanticEmbedding(testPrompt)
    console.log(`🔢 Generated embedding with magnitude: ${Math.sqrt(promptEmbedding.reduce((sum, val) => sum + val * val, 0)).toFixed(4)}`)
    
    // Test the matching function
    const { data: matches, error } = await supabase.rpc('find_best_giver_match', {
      p_prompt_embedding: JSON.stringify(promptEmbedding),
      p_receiver_user_id: '00000000-0000-0000-0000-000000000000', // Dummy receiver ID
      p_excluded_giver_ids: [],
      p_limit: 5
    })

    if (error) {
      throw error
    }

    console.log(`\n🎯 Found ${matches?.length || 0} matches:`)
    
    if (matches && matches.length > 0) {
      matches.forEach((match, index) => {
        console.log(`\n${index + 1}. Giver: ${match.giver_user_id}`)
        console.log(`   📊 Similarity Score: ${(match.similarity_score * 100).toFixed(1)}%`)
        console.log(`   ✅ Available: ${match.is_available}`)
        console.log(`   🤝 Total Helps: ${match.total_helps_given}`)
        console.log(`   ⭐ Rating: ${match.average_rating || 'No rating yet'}`)
      })
      
      const bestMatch = matches[0]
      if (bestMatch.similarity_score > 0.5) {
        console.log(`\n🎉 EXCELLENT MATCH! Similarity: ${(bestMatch.similarity_score * 100).toFixed(1)}%`)
        console.log('✅ This should result in an instant match!')
      } else if (bestMatch.similarity_score > 0.3) {
        console.log(`\n👍 GOOD MATCH! Similarity: ${(bestMatch.similarity_score * 100).toFixed(1)}%`)
        console.log('✅ This should result in a match!')
      } else {
        console.log(`\n⚠️  LOW MATCH! Similarity: ${(bestMatch.similarity_score * 100).toFixed(1)}%`)
        console.log('❓ Match quality could be improved')
      }
    } else {
      console.log('\n❌ No matches found!')
      
      // Debug: Check available givers
      const { data: availableGivers, error: debugError } = await supabase
        .from('giver_profiles')
        .select(`
          user_id,
          is_available,
          profiles!inner(about, interests)
        `)
        .eq('is_available', true)
      
      if (debugError) {
        console.error('Error checking available givers:', debugError)
      } else {
        console.log(`\n🔍 Debug: Found ${availableGivers?.length || 0} available givers:`)
        availableGivers?.forEach(giver => {
          const profileText = [
            giver.profiles?.about || '',
            ...(giver.profiles?.interests || [])
          ].filter(Boolean).join(' ')
          console.log(`   - ${giver.user_id}: "${profileText.substring(0, 50)}..."`)
        })
      }
    }
    
  } catch (error) {
    console.error('💥 Test failed:', error.message)
    process.exit(1)
  }
}

// Run test
testMatching()
