import nodemailer, { type Transporter } from 'nodemailer'
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2'
import { env } from './env.js'
import { logger } from './logger.js'

// All transactional/marketing email goes through AWS SES now (previously
// Zoho SMTP). Reuses the same AWS credentials already configured for S3
// uploads (env.AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY) -- notifications.orincore.com
// is domain-verified (SPF+DKIM) in ap-south-1, the same region already used
// for S3, so no separate SES-only region/credential set is needed.
const sesClient = (env.AWS_REGION && env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY)
  ? new SESv2Client({
      region: env.AWS_REGION,
      credentials: {
        accessKeyId: env.AWS_ACCESS_KEY_ID,
        secretAccessKey: env.AWS_SECRET_ACCESS_KEY
      }
    })
  : null

// Attaches every send to the existing "orincore-crm" SES configuration set
// (bounce/complaint/reputation tracking) when one is configured. Safe to
// leave unset in an environment where it doesn't exist.
const configurationSetName = process.env.SES_CONFIGURATION_SET || 'orincore-crm'

const sesOptions = sesClient ? { SES: { sesClient, SendEmailCommand } } : null

export const sesTransport: Transporter | null = sesOptions
  ? nodemailer.createTransport(sesOptions, {
      ...sesOptions,
      ...(configurationSetName ? { ses: { ConfigurationSetName: configurationSetName } } : {})
    })
  : null

if (!sesTransport) {
  logger.error('[email] AWS SES transport not configured -- missing AWS_REGION/AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY. Emails will fail to send.')
} else {
  sesTransport.verify((error) => {
    if (error) {
      logger.error({ error }, '[email] AWS SES transport verification failed')
    } else {
      logger.info('[email] AWS SES transport ready')
    }
  })
}
