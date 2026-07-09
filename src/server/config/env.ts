import { config } from 'dotenv'
import { z } from 'zod'

config()

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  SERVER_RUNTIME: z.enum(['node', 'vercel']).default('node'),
  PORT: z.coerce.number().default(8080),
  CORS_ORIGIN: z.string().default('*'),
  DATABASE_URL: z.string().optional(),
  JWT_SECRET: z.string().min(16, 'JWT_SECRET must be at least 16 chars'),
  AWS_REGION: z.string().optional().default(''),
  AWS_S3_BUCKET: z.string().optional().default(''),
  AWS_ACCESS_KEY_ID: z.string().optional().default(''),
  AWS_SECRET_ACCESS_KEY: z.string().optional().default(''),
  DEFAULT_PROFILE_PHOTO_URL: z.string().url().optional().default('https://placehold.co/200x200?text=Profile'),
  // SMTP for transactional emails
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().optional(),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(), // Alternative to SMTP_PASS
  SMTP_FROM: z.string().optional(),
  SMTP_FROM_EMAIL: z.string().optional(), // Alternative to SMTP_FROM
  // Google Play Console (service account)
  GOOGLE_SERVICE_ACCOUNT_EMAIL: z.string().optional(),
  GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: z.string().optional(),
  GOOGLE_PLAY_PACKAGE_NAME: z.string().optional(),
  // Google Play billing (subscription purchase verification / RTDN)
  GOOGLE_PLAY_PUBSUB_TOPIC: z.string().optional(),
  // Razorpay (web payments)
  RAZORPAY_KEY_ID: z.string().optional(),
  RAZORPAY_KEY_SECRET: z.string().optional(),
  RAZORPAY_WEBHOOK_SECRET: z.string().optional(),
  // Apple App Store Server API (iOS in-app purchase verification)
  APPLE_ISSUER_ID: z.string().optional(),
  APPLE_KEY_ID: z.string().optional(),
  APPLE_PRIVATE_KEY: z.string().optional(),
  APPLE_BUNDLE_ID: z.string().optional(),
  // YouTube Data API v3 (jam session search + metadata; never exposed to clients)
  YOUTUBE_API_KEY: z.string().optional(),
})

export const env = envSchema.parse(process.env)
