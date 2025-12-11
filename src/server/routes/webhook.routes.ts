import { Router } from 'express'
import { Request, Response } from 'express'
import { execSync } from 'child_process'
import crypto from 'crypto'
import { logger } from '../config/logger.js'

const router = Router()

/**
 * POST /api/webhook/github
 * GitHub webhook endpoint to trigger OTA updates on push to main branch
 * This ensures OTA updates are automatically built and deployed when code changes
 */
router.post('/github', async (req: Request, res: Response) => {
  try {
    // Verify GitHub webhook signature for security
    const signature = req.headers['x-hub-signature-256'] as string
    const webhookSecret = process.env.GITHUB_WEBHOOK_SECRET
    
    if (webhookSecret && signature) {
      const expectedSignature = 'sha256=' + crypto
        .createHmac('sha256', webhookSecret)
        .update(JSON.stringify(req.body))
        .digest('hex')
      
      if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature))) {
        logger.warn({ signature }, 'Invalid GitHub webhook signature')
        return res.status(401).json({ error: 'Invalid signature' })
      }
    }

    const { ref, repository, commits } = req.body
    
    // Only trigger on push to main branch
    if (ref !== 'refs/heads/main') {
      logger.info({ ref }, 'Ignoring push to non-main branch')
      return res.json({ message: 'Ignored - not main branch' })
    }

    // Check if this is the Circle frontend repository
    const isCircleRepo = repository?.name === 'CircleReact' || 
                        repository?.full_name?.includes('Circle') ||
                        repository?.clone_url?.includes('CircleReact')

    if (!isCircleRepo) {
      logger.info({ repoName: repository?.name }, 'Ignoring push to non-Circle repository')
      return res.json({ message: 'Ignored - not Circle repository' })
    }

    logger.info({ 
      ref, 
      repository: repository?.name,
      commits: commits?.length || 0 
    }, 'GitHub webhook received - triggering OTA build')

    // Trigger OTA build asynchronously (don't block webhook response)
    triggerOTABuild().catch(error => {
      logger.error({ error: error instanceof Error ? error.message : String(error) }, 'OTA build failed after webhook trigger')
    })

    res.json({ 
      success: true, 
      message: 'OTA build triggered',
      repository: repository?.name,
      commits: commits?.length || 0
    })

  } catch (error) {
    logger.error({ error }, 'Error processing GitHub webhook')
    res.status(500).json({ error: 'Webhook processing failed' })
  }
})

/**
 * POST /api/webhook/manual-ota
 * Manual trigger for OTA updates (for testing or emergency deployments)
 */
router.post('/manual-ota', async (req: Request, res: Response) => {
  try {
    // Check authorization
    const apiKey = req.headers['x-api-key']
    const internalApiKey = process.env.INTERNAL_API_KEY
    
    if (!internalApiKey || apiKey !== internalApiKey) {
      return res.status(401).json({ error: 'Unauthorized' })
    }

    logger.info('Manual OTA build triggered')

    // Trigger OTA build asynchronously
    triggerOTABuild().catch(error => {
      logger.error({ error: error instanceof Error ? error.message : String(error) }, 'Manual OTA build failed')
    })

    res.json({ 
      success: true, 
      message: 'Manual OTA build triggered' 
    })

  } catch (error) {
    logger.error({ error }, 'Error processing manual OTA trigger')
    res.status(500).json({ error: 'Manual OTA trigger failed' })
  }
})

/**
 * Trigger OTA build process
 * This function pulls latest code and builds OTA updates
 */
async function triggerOTABuild(): Promise<void> {
  try {
    logger.info('Starting automated OTA build process...')

    // Set environment variables for the build
    const env = {
      ...process.env,
      BACKEND_URL: process.env.BACKEND_URL || 'http://localhost',
      INTERNAL_API_KEY: process.env.INTERNAL_API_KEY,
      RUNTIME_VERSION: process.env.RUNTIME_VERSION || '1.0.0',
      CIRCLE_APP_DIR: process.env.CIRCLE_APP_DIR || '/root/CircleReact',
    }

    // Check if we're in production environment
    const isProduction = process.env.NODE_ENV === 'production'
    const scriptPath = isProduction 
      ? '/root/Circle-Lastest-Backend/scripts/deploy-ota-update.sh'
      : './scripts/deploy-ota-update.sh'

    logger.info({ scriptPath, isProduction }, 'Executing OTA deployment script')

    // Execute the OTA deployment script
    const output = execSync(`bash ${scriptPath}`, {
      env,
      encoding: 'utf8',
      timeout: 600000, // 10 minute timeout
      maxBuffer: 10 * 1024 * 1024, // 10MB buffer
    })

    logger.info({ output: output.substring(0, 1000) }, 'OTA build completed successfully')

    // Send notification about successful deployment
    await sendOTANotification('success', 'OTA update deployed successfully')

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    logger.error({ error: errorMessage }, 'OTA build failed')
    
    // Send notification about failed deployment
    await sendOTANotification('error', `OTA build failed: ${errorMessage}`)
    
    throw error
  }
}

/**
 * Send notification about OTA deployment status
 */
async function sendOTANotification(status: 'success' | 'error', message: string): Promise<void> {
  try {
    const slackWebhookUrl = process.env.SLACK_WEBHOOK_URL
    
    if (slackWebhookUrl) {
      const color = status === 'success' ? 'good' : 'danger'
      const emoji = status === 'success' ? '🚀' : '❌'
      
      const payload = {
        text: `${emoji} Circle OTA Update`,
        attachments: [{
          color,
          fields: [{
            title: 'Status',
            value: status.toUpperCase(),
            short: true
          }, {
            title: 'Message',
            value: message,
            short: false
          }, {
            title: 'Timestamp',
            value: new Date().toISOString(),
            short: true
          }]
        }]
      }

      const response = await fetch(slackWebhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      })

      if (!response.ok) {
        logger.warn({ status: response.status }, 'Failed to send Slack notification')
      }
    }
  } catch (error) {
    logger.warn({ error }, 'Failed to send OTA notification')
  }
}

/**
 * GET /api/webhook/ota-status
 * Get current OTA build status
 */
router.get('/ota-status', async (req: Request, res: Response) => {
  try {
    // Get latest update information
    const response = await fetch(`${process.env.BACKEND_URL || 'http://localhost'}/api/updates/status`)
    const updatesData = await response.json()

    res.json({
      success: true,
      lastCheck: new Date().toISOString(),
      updates: updatesData.updates || [],
      webhookEnabled: !!process.env.GITHUB_WEBHOOK_SECRET,
      autoDeployEnabled: true
    })

  } catch (error) {
    logger.error({ error }, 'Error getting OTA status')
    res.status(500).json({ error: 'Failed to get OTA status' })
  }
})

export default router
