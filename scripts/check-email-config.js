#!/usr/bin/env node

/**
 * Check email configuration and test email sending
 * Usage: node scripts/check-email-config.js
 */

import { config } from 'dotenv'

// Load environment variables
config()


// Check environment variables

const hasRequiredConfig = process.env.SMTP_USER && process.env.SMTP_PASSWORD

if (hasRequiredConfig) {
} else {
}


