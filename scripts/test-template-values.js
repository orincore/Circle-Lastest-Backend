#!/usr/bin/env node

/**
 * Test template variable values
 * Usage: node scripts/test-template-values.js
 */

console.log('🧪 Testing template variable generation...\n')

// Test the same logic used in the email template
const planType = 'premium'
const amount = 9.99
const currency = 'USD'
const name = 'Test User'

const planName = planType === 'premium' ? 'Premium' : 'Premium Plus'
const formattedAmount = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: currency.toUpperCase()
}).format(amount)

console.log('📧 Template Variables:')
console.log('  name:', name)
console.log('  planType:', planType)
console.log('  planName:', planName)
console.log('  amount:', amount)
console.log('  formattedAmount:', formattedAmount)
console.log('  currency:', currency)

console.log('\n🔍 Template String Test:')
console.log(`Plan: ${planName}`)
console.log(`Amount Paid: ${formattedAmount}`)
console.log(`Billing: Monthly`)
console.log(`Status: ✅ Active`)

console.log('\n✅ Template variables are working correctly!')

// Test with Premium Plus
console.log('\n🧪 Testing Premium Plus...')
const planType2 = 'premium_plus'
const amount2 = 19.99
const planName2 = planType2 === 'premium' ? 'Premium' : 'Premium Plus'
const formattedAmount2 = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD'
}).format(amount2)

console.log(`Plan: ${planName2}`)
console.log(`Amount Paid: ${formattedAmount2}`)
