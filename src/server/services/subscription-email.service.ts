import fs from 'fs/promises'
import path from 'path'
import { fileURLToPath } from 'url'
import nodemailer from 'nodemailer'
import { logger } from '../config/logger.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

export interface SubscriptionEmailData {
  userEmail: string
  userName: string
  planType: 'premium' | 'premium_plus'
  amount?: number
  currency?: string
  paymentMethod?: string
  startDate: string
  expiryDate?: string
  autoRenew?: boolean
  isSponsored?: boolean
  receiptUrl?: string
}

export class SubscriptionEmailService {
  private static instance: SubscriptionEmailService
  private transporter: nodemailer.Transporter
  private templatesPath: string

  constructor() {
    this.transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST || 'smtp-relay.brevo.com',
      port: parseInt(process.env.SMTP_PORT || '587'),
      secure: false,
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
    })
    this.templatesPath = path.join(__dirname, '../templates/email')
  }

  static getInstance(): SubscriptionEmailService {
    if (!SubscriptionEmailService.instance) {
      SubscriptionEmailService.instance = new SubscriptionEmailService()
    }
    return SubscriptionEmailService.instance
  }

  /**
   * Test email sending functionality
   */
  async testEmailSending(userEmail: string): Promise<boolean> {
    try {
      console.log('📧 Testing email sending to:', userEmail)
      
      const result = await this.transporter.sendMail({
        from: `"Circle Team" <${process.env.SMTP_FROM_EMAIL || 'noreply@circle.orincore.com'}>`,
        to: userEmail,
        subject: 'Test Email from Circle',
        html: `
          <div style="font-family: Arial, sans-serif; padding: 20px;">
            <h1>Test Email</h1>
            <p>This is a test email from Circle to verify email functionality.</p>
            <p>If you receive this, email sending is working correctly!</p>
          </div>
        `,
      })

      console.log('📧 Test email result:', result)
      return !!result.messageId
    } catch (error) {
      console.error('📧 Test email failed:', error)
      return false
    }
  }

  /**
   * Send sponsored subscription email when admin creates a subscription
   */
  async sendSponsoredSubscriptionEmail(data: SubscriptionEmailData): Promise<boolean> {
    try {
      logger.info({ userEmail: data.userEmail, planType: data.planType }, 'Sending sponsored subscription email')

      const templatePath = path.join(this.templatesPath, 'sponsored-subscription.html')
      console.log('📧 Loading template from:', templatePath)
      
      let template: string
      try {
        template = await fs.readFile(templatePath, 'utf-8')
        console.log('📧 Template loaded successfully, length:', template.length)
      } catch (templateError: any) {
        console.error('📧 Failed to load template:', templateError)
        // Fallback to simple HTML email
        template = `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
            <h1 style="color: #7C2B86;">🎁 Congratulations!</h1>
            <p>Hi ${data.userName},</p>
            <p>You've received a sponsored ${this.getPlanDisplayName(data.planType)} subscription from the Circle team!</p>
            <p>Your premium features are now active${data.expiryDate ? ` until ${new Date(data.expiryDate).toLocaleDateString()}` : ''}.</p>
            <p>Start exploring your premium features in the Circle app!</p>
            <p>Best regards,<br>The Circle Team</p>
          </div>
        `
        console.log('📧 Using fallback template')
      }

      // Replace template variables
      const replacements = {
        '{{USER_NAME}}': data.userName,
        '{{PLAN_NAME}}': this.getPlanDisplayName(data.planType),
        '{{EXPIRY_DATE}}': data.expiryDate ? new Date(data.expiryDate).toLocaleDateString('en-US', {
          year: 'numeric',
          month: 'long',
          day: 'numeric'
        }) : '',
        '{{APP_URL}}': process.env.FRONTEND_URL || 'https://circle.orincore.com',
        '{{UNSUBSCRIBE_URL}}': `${process.env.FRONTEND_URL || 'https://circle.orincore.com'}/unsubscribe`,
        '{{#if isPremiumPlus}}': data.planType === 'premium_plus' ? '' : '<!--',
        '{{/if}}': data.planType === 'premium_plus' ? '' : '-->',
        '{{#if expiryDate}}': data.expiryDate ? '' : '<!--'
      }

      // Apply replacements
      Object.entries(replacements).forEach(([placeholder, value]) => {
        template = template.replace(new RegExp(placeholder, 'g'), value)
      })

      const subject = `🎁 You've received a sponsored ${this.getPlanDisplayName(data.planType)} subscription!`

      console.log('📧 Attempting to send sponsored subscription email to:', data.userEmail)
      console.log('📧 SMTP Config:', {
        host: process.env.SMTP_HOST,
        port: process.env.SMTP_PORT,
        user: process.env.SMTP_USER ? 'Present' : 'Missing',
        pass: process.env.SMTP_PASS ? 'Present' : 'Missing',
        from: process.env.SMTP_FROM_EMAIL
      })

      const result = await this.transporter.sendMail({
        from: `"Circle Team" <${process.env.SMTP_FROM_EMAIL || 'noreply@circle.orincore.com'}>`,
        to: data.userEmail,
        subject,
        html: template,
      })

      console.log('📧 Email send result:', result)
      const success = !!result.messageId

      if (success) {
        logger.info({ userEmail: data.userEmail, messageId: result.messageId }, 'Sponsored subscription email sent successfully')
      } else {
        logger.error({ userEmail: data.userEmail }, 'Failed to send sponsored subscription email')
      }

      return success
    } catch (error) {
      logger.error({ error, userEmail: data.userEmail }, 'Error sending sponsored subscription email')
      return false
    }
  }

  /**
   * Send subscription confirmation email when user subscribes
   */
  async sendSubscriptionConfirmationEmail(data: SubscriptionEmailData): Promise<boolean> {
    try {
      logger.info({ userEmail: data.userEmail, planType: data.planType }, 'Sending subscription confirmation email')

      const templatePath = path.join(this.templatesPath, 'subscription-confirmation.html')
      let template = await fs.readFile(templatePath, 'utf-8')

      // Replace template variables
      const replacements = {
        '{{USER_NAME}}': data.userName,
        '{{PLAN_NAME}}': this.getPlanDisplayName(data.planType),
        '{{AMOUNT}}': data.amount?.toFixed(2) || '0.00',
        '{{CURRENCY}}': data.currency || 'USD',
        '{{PAYMENT_METHOD}}': data.paymentMethod || 'Credit Card',
        '{{START_DATE}}': new Date(data.startDate).toLocaleDateString('en-US', {
          year: 'numeric',
          month: 'long',
          day: 'numeric'
        }),
        '{{EXPIRY_DATE}}': data.expiryDate ? new Date(data.expiryDate).toLocaleDateString('en-US', {
          year: 'numeric',
          month: 'long',
          day: 'numeric'
        }) : '',
        '{{AUTO_RENEW_STATUS}}': data.autoRenew ? 'Enabled' : 'Disabled',
        '{{APP_URL}}': process.env.FRONTEND_URL || 'https://circle.orincore.com',
        '{{RECEIPT_URL}}': data.receiptUrl || `${process.env.FRONTEND_URL || 'https://circle.orincore.com'}/profile/subscription`,
        '{{UNSUBSCRIBE_URL}}': `${process.env.FRONTEND_URL || 'https://circle.orincore.com'}/unsubscribe`,
        '{{#if isPremiumPlus}}': data.planType === 'premium_plus' ? '' : '<!--',
        '{{/if}}': data.planType === 'premium_plus' ? '' : '-->',
        '{{#if expiryDate}}': data.expiryDate ? '' : '<!--'
      }

      // Apply replacements
      Object.entries(replacements).forEach(([placeholder, value]) => {
        template = template.replace(new RegExp(placeholder, 'g'), value)
      })

      const subject = `✅ Welcome to Circle ${this.getPlanDisplayName(data.planType)}!`

      console.log('📧 Attempting to send subscription confirmation email to:', data.userEmail)

      const result = await this.transporter.sendMail({
        from: `"Circle Team" <${process.env.SMTP_FROM_EMAIL || 'noreply@circle.orincore.com'}>`,
        to: data.userEmail,
        subject,
        html: template,
      })

      console.log('📧 Confirmation email send result:', result)
      const success = !!result.messageId

      if (success) {
        logger.info({ userEmail: data.userEmail, messageId: result.messageId }, 'Subscription confirmation email sent successfully')
      } else {
        logger.error({ userEmail: data.userEmail }, 'Failed to send subscription confirmation email')
      }

      return success
    } catch (error) {
      logger.error({ error, userEmail: data.userEmail }, 'Error sending subscription confirmation email')
      return false
    }
  }

  /**
   * Send subscription cancellation email
   */
  async sendSubscriptionCancellationEmail(data: SubscriptionEmailData): Promise<boolean> {
    try {
      logger.info({ userEmail: data.userEmail, planType: data.planType }, 'Sending subscription cancellation email')

      const subject = `Subscription Cancelled - Circle ${this.getPlanDisplayName(data.planType)}`
      
      const html = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
          <div style="background: linear-gradient(135deg, #1F1147 0%, #7C2B86 100%); color: white; padding: 30px; border-radius: 15px; text-align: center; margin-bottom: 20px;">
            <h1 style="margin: 0; font-size: 24px;">Circle</h1>
            <h2 style="margin: 10px 0 0 0;">Subscription Cancelled</h2>
          </div>
          
          <div style="background: white; padding: 30px; border-radius: 15px; border: 1px solid #eee;">
            <p>Hi ${data.userName},</p>
            
            <p>Your Circle ${this.getPlanDisplayName(data.planType)} subscription has been cancelled.</p>
            
            ${data.expiryDate ? `
              <div style="background: #fff3cd; border: 1px solid #ffeaa7; border-radius: 8px; padding: 15px; margin: 20px 0;">
                <strong>⏰ Important:</strong> You'll continue to have access to premium features until <strong>${new Date(data.expiryDate).toLocaleDateString('en-US', {
                  year: 'numeric',
                  month: 'long',
                  day: 'numeric'
                })}</strong>
              </div>
            ` : ''}
            
            <p>If you change your mind, you can always resubscribe from your profile settings in the Circle app.</p>
            
            <p>Thank you for being part of the Circle community!</p>
            
            <div style="text-align: center; margin: 30px 0;">
              <a href="${process.env.FRONTEND_URL || 'https://circle.orincore.com'}" 
                 style="background: linear-gradient(135deg, #7C2B86, #9333EA); color: white; text-decoration: none; padding: 12px 24px; border-radius: 25px; font-weight: bold;">
                Continue Using Circle
              </a>
            </div>
          </div>
          
          <div style="text-align: center; color: #666; font-size: 14px; margin-top: 20px;">
            <p>© 2024 Circle. All rights reserved.</p>
          </div>
        </div>
      `

      await this.transporter.sendMail({
        from: `"Circle Team" <${process.env.SMTP_FROM_EMAIL || 'noreply@circle.orincore.com'}>`,
        to: data.userEmail,
        subject,
        html,
      })

      const success = true

      if (success) {
        logger.info({ userEmail: data.userEmail }, 'Subscription cancellation email sent successfully')
      } else {
        logger.error({ userEmail: data.userEmail }, 'Failed to send subscription cancellation email')
      }

      return success
    } catch (error) {
      logger.error({ error, userEmail: data.userEmail }, 'Error sending subscription cancellation email')
      return false
    }
  }

  /**
   * Get display name for plan type
   */
  private getPlanDisplayName(planType: string): string {
    switch (planType) {
      case 'premium_plus':
        return 'Premium+'
      case 'premium':
        return 'Premium'
      default:
        return 'Premium'
    }
  }

  /**
   * Get plan features for display
   */
  private getPlanFeatures(planType: string): string[] {
    const baseFeatures = [
      'Unlimited matches and connections',
      'Advanced search filters',
      'Priority profile visibility',
      'Read receipts for messages',
      'Voice and video calling',
      'Premium badges',
      'Ad-free experience'
    ]

    if (planType === 'premium_plus') {
      return [
        ...baseFeatures,
        'Super likes and priority matching',
        'Incognito mode browsing',
        'Advanced analytics and insights'
      ]
    }

    return baseFeatures
  }
}

export default SubscriptionEmailService
