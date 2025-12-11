#!/usr/bin/env node

/**
 * Migration script to regenerate embeddings for existing giver profiles
 * Run this after updating the embedding generation logic
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

async function migrateEmbeddings() {
  try {
    //console.log('🔄 Starting embedding migration...')
    
    // Get all giver profiles with their user data
    const { data: givers, error: fetchError } = await supabase
      .from('giver_profiles')
      .select(`
        user_id,
        profiles!inner(about, interests, needs)
      `)
    
    if (fetchError) {
      throw fetchError
    }
    
    //console.log(`📊 Found ${givers.length} giver profiles to migrate`)
    
    let updated = 0
    let errors = 0
    
    for (const giver of givers) {
      try {
        const profile = giver.profiles
        
        // Combine profile data for embedding
        const profileText = [
          profile?.about || '',
          ...(profile?.interests || []),
          ...(profile?.needs || [])
        ].filter(Boolean).join(' ')
        
        if (!profileText.trim()) {
          //console.log(`⚠️  Skipping ${giver.user_id} - no profile text`)
          continue
        }
        
        // Generate new semantic embedding
        const newEmbedding = generateSemanticEmbedding(profileText)
        
        // Update the giver profile
        const { error: updateError } = await supabase
          .from('giver_profiles')
          .update({
            profile_embedding: JSON.stringify(newEmbedding),
            updated_at: new Date().toISOString()
          })
          .eq('user_id', giver.user_id)
        
        if (updateError) {
          console.error(`❌ Error updating ${giver.user_id}:`, updateError.message)
          errors++
        } else {
          //console.log(`✅ Updated ${giver.user_id} - "${profileText.substring(0, 50)}..."`)
          updated++
        }
        
        // Small delay to avoid rate limits
        await new Promise(resolve => setTimeout(resolve, 100))
        
      } catch (error) {
        console.error(`❌ Error processing ${giver.user_id}:`, error.message)
        errors++
      }
    }
    
    //console.log('\n📈 Migration Results:')
    //console.log(`✅ Successfully updated: ${updated}`)
    //console.log(`❌ Errors: ${errors}`)
    //console.log(`📊 Total processed: ${givers.length}`)
    
    if (updated > 0) {
      //console.log('\n🎉 Migration completed! New semantic embeddings are now active.')
      //console.log('💡 Test your matching scenario again.')
    }
    
  } catch (error) {
    console.error('💥 Migration failed:', error.message)
    process.exit(1)
  }
}

// Run migration
migrateEmbeddings()
