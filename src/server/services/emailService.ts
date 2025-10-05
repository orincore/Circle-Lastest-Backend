import nodemailer from 'nodemailer'
import { supabase } from '../config/supabase.js'

interface EmailOTP {
  email: string
  otp: string
  expires_at: string
  attempts: number
  verified: boolean
}

class EmailService {
  private transporter: nodemailer.Transporter

  constructor() {
    // Configure email transporter using SMTP (same as campaigns)
    this.transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST || 'smtp-relay.brevo.com',
      port: parseInt(process.env.SMTP_PORT || '587'),
      secure: false, // Use TLS
      auth: {
        user: process.env.SMTP_USER || '',
        pass: process.env.SMTP_PASSWORD || '',
      },
    })

    // Verify connection configuration
    this.transporter.verify((error, success) => {
      if (error) {
        console.error('❌ Email service connection failed:', error)
      } else {
        console.log('✅ Email service ready to send messages')
      }
    })
  }

  /**
   * Generate 6-digit OTP
   */
  generateOTP(): string {
    return Math.floor(100000 + Math.random() * 900000).toString()
  }

  /**
   * Send OTP email
   */
  async sendOTPEmail(email: string, otp: string, name?: string): Promise<boolean> {
    try {
      const defaultFrom = process.env.SMTP_FROM_EMAIL || '"Circle App" <noreply@circle.orincore.com>'
      const mailOptions = {
        from: defaultFrom,
        to: email,
        subject: 'Verify Your Email - Circle App',
        html: this.getOTPEmailTemplate(otp, name),
      }

      const result = await this.transporter.sendMail(mailOptions)
      console.log('✅ OTP email sent:', result.messageId)
      return true
    } catch (error) {
      console.error('❌ Failed to send OTP email:', error)
      return false
    }
  }

  /**
   * Generate and store OTP for email verification
   */
  async generateAndStoreOTP(email: string): Promise<{ success: boolean; otp?: string; error?: string }> {
    try {
      const otp = this.generateOTP()
      const expiresAt = new Date()
      expiresAt.setMinutes(expiresAt.getMinutes() + 10) // OTP expires in 10 minutes

      // Check if there's an existing OTP for this email
      const { data: existingOTP } = await supabase
        .from('email_otps')
        .select('*')
        .eq('email', email)
        .single()

      if (existingOTP) {
        // Update existing OTP
        const { error } = await supabase
          .from('email_otps')
          .update({
            otp,
            expires_at: expiresAt.toISOString(),
            attempts: 0,
            verified: false,
            created_at: new Date().toISOString(),
          })
          .eq('email', email)

        if (error) {
          console.error('Failed to update OTP:', error)
          return { success: false, error: 'Failed to generate OTP' }
        }
      } else {
        // Insert new OTP
        const { error } = await supabase
          .from('email_otps')
          .insert({
            email,
            otp,
            expires_at: expiresAt.toISOString(),
            attempts: 0,
            verified: false,
          })

        if (error) {
          console.error('Failed to insert OTP:', error)
          return { success: false, error: 'Failed to generate OTP' }
        }
      }

      return { success: true, otp }
    } catch (error) {
      console.error('Generate OTP error:', error)
      return { success: false, error: 'Failed to generate OTP' }
    }
  }

  /**
   * Verify OTP
   */
  async verifyOTP(email: string, inputOTP: string): Promise<{ success: boolean; error?: string }> {
    try {
      // Get OTP record
      const { data: otpRecord, error: fetchError } = await supabase
        .from('email_otps')
        .select('*')
        .eq('email', email)
        .single()

      if (fetchError || !otpRecord) {
        return { success: false, error: 'OTP not found. Please request a new one.' }
      }

      // Check if already verified
      if (otpRecord.verified) {
        return { success: false, error: 'Email already verified.' }
      }

      // Check if expired
      if (new Date() > new Date(otpRecord.expires_at)) {
        return { success: false, error: 'OTP has expired. Please request a new one.' }
      }

      // Check attempts limit
      if (otpRecord.attempts >= 5) {
        return { success: false, error: 'Too many failed attempts. Please request a new OTP.' }
      }

      // Verify OTP
      if (otpRecord.otp !== inputOTP) {
        // Increment attempts
        await supabase
          .from('email_otps')
          .update({ attempts: otpRecord.attempts + 1 })
          .eq('email', email)

        return { success: false, error: 'Invalid OTP. Please try again.' }
      }

      // Mark as verified
      await supabase
        .from('email_otps')
        .update({ verified: true })
        .eq('email', email)

      return { success: true }
    } catch (error) {
      console.error('Verify OTP error:', error)
      return { success: false, error: 'Failed to verify OTP' }
    }
  }

  /**
   * Check if email is verified
   */
  async isEmailVerified(email: string): Promise<boolean> {
    try {
      const { data } = await supabase
        .from('email_otps')
        .select('verified')
        .eq('email', email)
        .single()

      return data?.verified || false
    } catch (error) {
      return false
    }
  }

  /**
   * Clean up expired OTPs (run this periodically)
   */
  async cleanupExpiredOTPs(): Promise<void> {
    try {
      const { error } = await supabase
        .from('email_otps')
        .delete()
        .lt('expires_at', new Date().toISOString())

      if (error) {
        console.error('Failed to cleanup expired OTPs:', error)
      } else {
        console.log('✅ Expired OTPs cleaned up')
      }
    } catch (error) {
      console.error('Cleanup OTPs error:', error)
    }
  }

  /**
   * Get OTP email template with Circle theme
   */
  private getOTPEmailTemplate(otp: string, name?: string): string {
    return `
    <!DOCTYPE html>
    <html>
    <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Verify Your Email - Circle</title>
        <style>
            body {
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', sans-serif;
                line-height: 1.6;
                color: #1F1147;
                max-width: 600px;
                margin: 0 auto;
                padding: 0;
                background: linear-gradient(135deg, #1F1147 0%, #7C2B86 100%);
                min-height: 100vh;
            }
            .container {
                background: #FFFFFF;
                border-radius: 24px;
                margin: 20px;
                padding: 0;
                box-shadow: 0 20px 40px rgba(31, 17, 71, 0.3);
                overflow: hidden;
            }
            .header {
                background: linear-gradient(135deg, #1F1147 0%, #7C2B86 100%);
                padding: 40px 40px 30px 40px;
                text-align: center;
                color: white;
            }
            .logo {
                font-size: 36px;
                font-weight: 800;
                color: #FFFFFF;
                margin-bottom: 8px;
                letter-spacing: -1px;
            }
            .header-subtitle {
                font-size: 18px;
                color: rgba(255, 255, 255, 0.9);
                font-weight: 500;
            }
            .content {
                padding: 40px;
            }
            .greeting {
                font-size: 24px;
                font-weight: 700;
                color: #1F1147;
                margin-bottom: 20px;
                text-align: center;
            }
            .message {
                font-size: 17px;
                color: #2D2D2D;
                text-align: center;
                margin-bottom: 36px;
                line-height: 1.7;
                font-weight: 500;
            }
            .otp-container {
                text-align: center;
                margin: 40px 0;
            }
            .otp-label {
                font-size: 14px;
                color: #7C2B86;
                font-weight: 600;
                margin-bottom: 12px;
                text-transform: uppercase;
                letter-spacing: 1px;
            }
            .otp-code {
                font-size: 42px;
                font-weight: 800;
                color: #FFFFFF;
                background: linear-gradient(135deg, #7C2B86 0%, #E91E63 100%);
                border: 3px solid #7C2B86;
                border-radius: 16px;
                padding: 24px 32px;
                letter-spacing: 12px;
                display: inline-block;
                box-shadow: 0 8px 16px rgba(124, 43, 134, 0.3);
                text-shadow: 0 2px 4px rgba(0, 0, 0, 0.2);
            }
            .instructions {
                background: linear-gradient(135deg, #F8F4FF 0%, #FFF0F8 100%);
                border-radius: 16px;
                padding: 24px;
                margin: 32px 0;
                border: 2px solid #E1BEE7;
                border-left: 4px solid #7C2B86;
            }
            .instructions h3 {
                color: #7C2B86;
                font-size: 16px;
                font-weight: 700;
                margin: 0 0 12px 0;
            }
            .instructions ul {
                margin: 0;
                padding-left: 20px;
                color: #2D2D2D;
            }
            .instructions li {
                margin-bottom: 10px;
                font-size: 15px;
                font-weight: 500;
                color: #2D2D2D;
            }
            .security-notice {
                background: linear-gradient(135deg, #FFF8E1 0%, #FFFDE7 100%);
                border: 2px solid #FFB74D;
                border-radius: 12px;
                padding: 24px;
                margin: 24px 0;
                text-align: center;
                box-shadow: 0 4px 8px rgba(255, 183, 77, 0.1);
            }
            .security-notice .icon {
                font-size: 28px;
                margin-bottom: 12px;
            }
            .security-notice .title {
                font-weight: 700;
                color: #E65100;
                margin-bottom: 12px;
                font-size: 16px;
            }
            .security-notice .text {
                font-size: 15px;
                color: #4E342E;
                font-weight: 500;
                line-height: 1.6;
            }
            .footer {
                background: #F8F9FA;
                padding: 32px 40px;
                text-align: center;
                border-top: 1px solid #E9ECEF;
            }
            .footer-logo {
                font-size: 24px;
                font-weight: 700;
                background: linear-gradient(135deg, #7C2B86, #E91E63);
                -webkit-background-clip: text;
                -webkit-text-fill-color: transparent;
                margin-bottom: 16px;
            }
            .footer-text {
                font-size: 14px;
                color: #6C757D;
                margin-bottom: 8px;
            }
            .footer-links {
                margin-top: 20px;
            }
            .footer-link {
                color: #7C2B86;
                text-decoration: none;
                font-weight: 500;
                margin: 0 12px;
            }
            .social-links {
                margin-top: 20px;
            }
            .social-link {
                display: inline-block;
                width: 40px;
                height: 40px;
                background: linear-gradient(135deg, #7C2B86, #E91E63);
                border-radius: 50%;
                margin: 0 8px;
                line-height: 40px;
                color: white;
                text-decoration: none;
                font-weight: bold;
            }
            @media (max-width: 600px) {
                .container { margin: 10px; }
                .header, .content, .footer { padding: 24px; }
                .otp-code { font-size: 36px; letter-spacing: 8px; }
            }
        </style>
    </head>
    <body>
        <div class="container">
            <div class="header">
                <div class="logo">Circle</div>
                <div class="header-subtitle">Connect • Match • Belong</div>
            </div>
            
            <div class="content">
                <div class="greeting">Hi${name ? ` ${name}` : ' there'}! 👋</div>
                
                <div class="message">
                    Welcome to <strong>Circle</strong>! We're excited to have you join our community of amazing people. 
                    To complete your registration, please verify your email address using the code below.
                </div>
                
                <div class="otp-container">
                    <div class="otp-label">Verification Code</div>
                    <div class="otp-code">${otp}</div>
                </div>
                
                <div class="instructions">
                    <h3>📱 How to verify:</h3>
                    <ul>
                        <li>Open the Circle app on your device</li>
                        <li>Enter this 6-digit code in the verification screen</li>
                        <li>Complete your profile setup</li>
                        <li>Start connecting with amazing people!</li>
                    </ul>
                </div>
                
                <div class="security-notice">
                    <div class="icon">🔒</div>
                    <div class="title">Security Notice</div>
                    <div class="text">
                        This code expires in <strong>10 minutes</strong> and can only be used once. 
                        Never share this code with anyone. If you didn't request this, please ignore this email.
                    </div>
                </div>
            </div>
            
            <div class="footer">
                <div class="footer-logo">Circle</div>
                <div class="footer-text">Thanks for joining our community! 💜</div>
                <div class="footer-text">Need help? We're here for you.</div>
                
                <div class="footer-links">
                    <a href="#" class="footer-link">Help Center</a>
                    <a href="#" class="footer-link">Contact Support</a>
                    <a href="#" class="footer-link">Privacy Policy</a>
                </div>
                
                <div style="margin-top: 24px; font-size: 12px; color: #ADB5BD;">
                    This is an automated message from Circle. Please do not reply to this email.
                    <br>© 2024 Circle App. All rights reserved.
                </div>
            </div>
        </div>
    </body>
    </html>
    `
  }

  /**
   * Send welcome email after successful verification
   */
  async sendWelcomeEmail(email: string, name: string): Promise<boolean> {
    try {
      const defaultFrom = process.env.SMTP_FROM_EMAIL || '"Circle App" <noreply@circle.orincore.com>'
      const mailOptions = {
        from: defaultFrom,
        to: email,
        subject: 'Welcome to Circle! 🎉',
        html: this.getWelcomeEmailTemplate(name),
      }

      const result = await this.transporter.sendMail(mailOptions)
      console.log('✅ Welcome email sent:', result.messageId)
      return true
    } catch (error) {
      console.error('❌ Failed to send welcome email:', error)
      return false
    }
  }

  /**
   * Get welcome email template with Circle theme
   */
  private getWelcomeEmailTemplate(name: string): string {
    return `
    <!DOCTYPE html>
    <html>
    <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Welcome to Circle!</title>
        <style>
            body {
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', sans-serif;
                line-height: 1.6;
                color: #1F1147;
                max-width: 600px;
                margin: 0 auto;
                padding: 0;
                background: linear-gradient(135deg, #1F1147 0%, #7C2B86 100%);
                min-height: 100vh;
            }
            .container {
                background: #FFFFFF;
                border-radius: 24px;
                margin: 20px;
                padding: 0;
                box-shadow: 0 20px 40px rgba(31, 17, 71, 0.3);
                overflow: hidden;
            }
            .header {
                background: linear-gradient(135deg, #1F1147 0%, #7C2B86 100%);
                padding: 40px;
                text-align: center;
                color: white;
                position: relative;
            }
            .header::after {
                content: '🎉';
                position: absolute;
                top: 20px;
                right: 30px;
                font-size: 24px;
                animation: bounce 2s infinite;
            }
            .logo {
                font-size: 36px;
                font-weight: 800;
                color: #FFFFFF;
                margin-bottom: 8px;
                letter-spacing: -1px;
            }
            .header-subtitle {
                font-size: 18px;
                color: rgba(255, 255, 255, 0.9);
                font-weight: 500;
            }
            .welcome-badge {
                background: rgba(255, 255, 255, 0.2);
                border-radius: 20px;
                padding: 8px 16px;
                display: inline-block;
                margin-top: 16px;
                font-size: 14px;
                font-weight: 600;
            }
            .content {
                padding: 40px;
            }
            .welcome-title {
                font-size: 28px;
                font-weight: 700;
                color: #1F1147;
                text-align: center;
                margin-bottom: 16px;
            }
            .welcome-message {
                font-size: 17px;
                color: #2D2D2D;
                text-align: center;
                margin-bottom: 40px;
                line-height: 1.7;
                font-weight: 500;
            }
            .features-grid {
                display: grid;
                grid-template-columns: 1fr 1fr;
                gap: 20px;
                margin: 32px 0;
            }
            .feature-card {
                background: linear-gradient(135deg, #F8F4FF 0%, #FFF0F8 100%);
                border-radius: 16px;
                padding: 24px;
                text-align: center;
                border: 2px solid #E1BEE7;
                transition: transform 0.2s ease;
            }
            .feature-icon {
                font-size: 32px;
                margin-bottom: 12px;
                display: block;
            }
            .feature-title {
                font-size: 16px;
                font-weight: 700;
                color: #7C2B86;
                margin-bottom: 8px;
            }
            .feature-desc {
                font-size: 15px;
                color: #2D2D2D;
                line-height: 1.5;
                font-weight: 500;
            }
            .cta-section {
                background: linear-gradient(135deg, #7C2B86 0%, #E91E63 100%);
                border-radius: 16px;
                padding: 32px;
                text-align: center;
                margin: 32px 0;
                color: white;
            }
            .cta-title {
                font-size: 20px;
                font-weight: 700;
                margin-bottom: 12px;
            }
            .cta-text {
                font-size: 14px;
                margin-bottom: 20px;
                opacity: 0.9;
            }
            .cta-button {
                background: rgba(255, 255, 255, 0.2);
                border: 2px solid rgba(255, 255, 255, 0.3);
                border-radius: 12px;
                padding: 12px 24px;
                color: white;
                text-decoration: none;
                font-weight: 600;
                display: inline-block;
                transition: all 0.2s ease;
            }
            .tips-section {
                background: #F8F9FA;
                border-radius: 16px;
                padding: 24px;
                margin: 24px 0;
            }
            .tips-title {
                font-size: 18px;
                font-weight: 700;
                color: #1F1147;
                margin-bottom: 16px;
                text-align: center;
            }
            .tip-item {
                display: flex;
                align-items: flex-start;
                margin-bottom: 12px;
                padding: 8px 0;
            }
            .tip-number {
                background: #7C2B86;
                color: white;
                width: 24px;
                height: 24px;
                border-radius: 50%;
                display: flex;
                align-items: center;
                justify-content: center;
                font-size: 12px;
                font-weight: 700;
                margin-right: 12px;
                flex-shrink: 0;
            }
            .tip-text {
                font-size: 15px;
                color: #2D2D2D;
                line-height: 1.5;
                font-weight: 500;
            }
            .footer {
                background: #F8F9FA;
                padding: 32px 40px;
                text-align: center;
                border-top: 1px solid #E9ECEF;
            }
            .footer-logo {
                font-size: 24px;
                font-weight: 700;
                background: linear-gradient(135deg, #7C2B86, #E91E63);
                -webkit-background-clip: text;
                -webkit-text-fill-color: transparent;
                margin-bottom: 16px;
            }
            .footer-text {
                font-size: 14px;
                color: #6C757D;
                margin-bottom: 8px;
            }
            .footer-links {
                margin-top: 20px;
            }
            .footer-link {
                color: #7C2B86;
                text-decoration: none;
                font-weight: 500;
                margin: 0 12px;
            }
            @keyframes bounce {
                0%, 20%, 50%, 80%, 100% { transform: translateY(0); }
                40% { transform: translateY(-10px); }
                60% { transform: translateY(-5px); }
            }
            @media (max-width: 600px) {
                .container { margin: 10px; }
                .header, .content, .footer { padding: 24px; }
                .features-grid { grid-template-columns: 1fr; }
                .welcome-title { font-size: 24px; }
            }
        </style>
    </head>
    <body>
        <div class="container">
            <div class="header">
                <div class="logo">Circle</div>
                <div class="header-subtitle">Connect • Match • Belong</div>
                <div class="welcome-badge">✨ Account Verified</div>
            </div>
            
            <div class="content">
                <div class="welcome-title">Welcome to Circle, ${name}! 🎉</div>
                
                <div class="welcome-message">
                    Your email has been verified successfully! You're now part of our amazing community. 
                    Get ready to connect with incredible people who share your interests and values.
                </div>
                
                <div class="features-grid">
                    <div class="feature-card">
                        <span class="feature-icon">💕</span>
                        <div class="feature-title">Smart Matching</div>
                        <div class="feature-desc">Find people who truly connect with you</div>
                    </div>
                    <div class="feature-card">
                        <span class="feature-icon">💬</span>
                        <div class="feature-title">Instant Chat</div>
                        <div class="feature-desc">Start meaningful conversations</div>
                    </div>
                    <div class="feature-card">
                        <span class="feature-icon">👫</span>
                        <div class="feature-title">True Friendships</div>
                        <div class="feature-desc">Build lasting relationships</div>
                    </div>
                    <div class="feature-card">
                        <span class="feature-icon">📍</span>
                        <div class="feature-title">Nearby Connections</div>
                        <div class="feature-desc">Meet amazing people around you</div>
                    </div>
                </div>
                
                <div class="cta-section">
                    <div class="cta-title">Ready to start your journey? 🚀</div>
                    <div class="cta-text">Complete your profile and start connecting with amazing people today!</div>
                    <a href="#" class="cta-button">Complete Your Profile</a>
                </div>
                
                <div class="tips-section">
                    <div class="tips-title">💡 Tips for Success</div>
                    <div class="tip-item">
                        <div class="tip-number">1</div>
                        <div class="tip-text">Add a great profile photo that shows your personality</div>
                    </div>
                    <div class="tip-item">
                        <div class="tip-number">2</div>
                        <div class="tip-text">Share your interests to find people with common hobbies</div>
                    </div>
                    <div class="tip-item">
                        <div class="tip-number">3</div>
                        <div class="tip-text">Be authentic and genuine in your conversations</div>
                    </div>
                    <div class="tip-item">
                        <div class="tip-number">4</div>
                        <div class="tip-text">Stay safe and report any inappropriate behavior</div>
                    </div>
                </div>
            </div>
            
            <div class="footer">
                <div class="footer-logo">Circle</div>
                <div class="footer-text">Welcome to our community! 💜</div>
                <div class="footer-text">We're here to help you connect and belong.</div>
                
                <div class="footer-links">
                    <a href="#" class="footer-link">Help Center</a>
                    <a href="#" class="footer-link">Community Guidelines</a>
                    <a href="#" class="footer-link">Contact Support</a>
                </div>
                
                <div style="margin-top: 24px; font-size: 12px; color: #ADB5BD;">
                    This is an automated message from Circle. Please do not reply to this email.
                    <br>© 2024 Circle App. All rights reserved.
                </div>
            </div>
        </div>
    </body>
    </html>
    `
  }

  /**
   * Send login alert email
   */
  async sendLoginAlert(email: string, name: string, loginInfo: {
    device?: string
    location?: string
    ip?: string
    timestamp?: string
  }): Promise<boolean> {
    try {
      const defaultFrom = process.env.SMTP_FROM_EMAIL || '"Circle Security" <noreply@circle.orincore.com>'
      const mailOptions = {
        from: defaultFrom,
        to: email,
        subject: 'New Login to Your Circle Account 🔐',
        html: this.getLoginAlertTemplate(name, loginInfo),
      }

      const result = await this.transporter.sendMail(mailOptions)
      console.log('✅ Login alert email sent:', result.messageId)
      return true
    } catch (error) {
      console.error('❌ Failed to send login alert email:', error)
      return false
    }
  }

  /**
   * Get login alert email template
   */
  private getLoginAlertTemplate(name: string, loginInfo: {
    device?: string
    location?: string
    ip?: string
    timestamp?: string
  }): string {
    const timestamp = loginInfo.timestamp || new Date().toLocaleString()
    const device = loginInfo.device || 'Unknown device'
    const location = loginInfo.location || 'Unknown location'
    const ip = loginInfo.ip || 'Unknown IP'

    return `
    <!DOCTYPE html>
    <html>
    <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>New Login Alert - Circle</title>
        <style>
            body {
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', sans-serif;
                line-height: 1.6;
                color: #1F1147;
                max-width: 600px;
                margin: 0 auto;
                padding: 0;
                background: linear-gradient(135deg, #1F1147 0%, #7C2B86 100%);
                min-height: 100vh;
            }
            .container {
                background: #FFFFFF;
                border-radius: 24px;
                margin: 20px;
                padding: 0;
                box-shadow: 0 20px 40px rgba(31, 17, 71, 0.3);
                overflow: hidden;
            }
            .header {
                background: linear-gradient(135deg, #1F1147 0%, #7C2B86 100%);
                padding: 40px;
                text-align: center;
                color: white;
                position: relative;
            }
            .security-icon {
                font-size: 48px;
                margin-bottom: 16px;
                display: block;
            }
            .logo {
                font-size: 36px;
                font-weight: 800;
                color: #FFFFFF;
                margin-bottom: 8px;
                letter-spacing: -1px;
            }
            .header-subtitle {
                font-size: 18px;
                color: rgba(255, 255, 255, 0.9);
                font-weight: 500;
            }
            .alert-badge {
                background: #FF6B6B;
                border-radius: 20px;
                padding: 8px 16px;
                display: inline-block;
                margin-top: 16px;
                font-size: 14px;
                font-weight: 600;
                color: white;
            }
            .content {
                padding: 40px;
            }
            .alert-title {
                font-size: 24px;
                font-weight: 700;
                color: #1F1147;
                text-align: center;
                margin-bottom: 16px;
            }
            .alert-message {
                font-size: 16px;
                color: #4A4A4A;
                text-align: center;
                margin-bottom: 32px;
                line-height: 1.7;
            }
            .login-details {
                background: linear-gradient(135deg, #F8F4FF 0%, #FFF0F8 100%);
                border-radius: 16px;
                padding: 24px;
                margin: 24px 0;
                border-left: 4px solid #7C2B86;
            }
            .login-details h3 {
                color: #7C2B86;
                font-size: 18px;
                font-weight: 700;
                margin: 0 0 16px 0;
            }
            .detail-item {
                display: flex;
                justify-content: space-between;
                align-items: center;
                padding: 8px 0;
                border-bottom: 1px solid rgba(124, 43, 134, 0.1);
            }
            .detail-item:last-child {
                border-bottom: none;
            }
            .detail-label {
                font-weight: 600;
                color: #7C2B86;
                font-size: 14px;
            }
            .detail-value {
                font-size: 14px;
                color: #4A4A4A;
                text-align: right;
                max-width: 60%;
                word-break: break-word;
            }
            .security-section {
                background: #FFF8E1;
                border: 2px solid #FFD54F;
                border-radius: 16px;
                padding: 24px;
                margin: 24px 0;
                text-align: center;
            }
            .security-section .icon {
                font-size: 32px;
                margin-bottom: 12px;
            }
            .security-section .title {
                font-size: 18px;
                font-weight: 700;
                color: #F57F17;
                margin-bottom: 12px;
            }
            .security-section .text {
                font-size: 14px;
                color: #6D4C41;
                margin-bottom: 20px;
                line-height: 1.6;
            }
            .action-buttons {
                display: flex;
                gap: 12px;
                justify-content: center;
                flex-wrap: wrap;
            }
            .btn {
                padding: 12px 24px;
                border-radius: 12px;
                text-decoration: none;
                font-weight: 600;
                font-size: 14px;
                display: inline-block;
                transition: all 0.2s ease;
            }
            .btn-primary {
                background: linear-gradient(135deg, #7C2B86, #E91E63);
                color: white;
            }
            .btn-secondary {
                background: #F8F9FA;
                color: #7C2B86;
                border: 2px solid #E1BEE7;
            }
            .tips-section {
                background: #F8F9FA;
                border-radius: 16px;
                padding: 24px;
                margin: 24px 0;
            }
            .tips-title {
                font-size: 16px;
                font-weight: 700;
                color: #1F1147;
                margin-bottom: 16px;
                text-align: center;
            }
            .tip-item {
                display: flex;
                align-items: flex-start;
                margin-bottom: 12px;
                padding: 8px 0;
            }
            .tip-icon {
                color: #4CAF50;
                margin-right: 12px;
                font-size: 16px;
                margin-top: 2px;
            }
            .tip-text {
                font-size: 15px;
                color: #2D2D2D;
                line-height: 1.5;
                font-weight: 500;
            }
            .footer {
                background: #F8F9FA;
                padding: 32px 40px;
                text-align: center;
                border-top: 1px solid #E9ECEF;
            }
            .footer-logo {
                font-size: 24px;
                font-weight: 700;
                background: linear-gradient(135deg, #7C2B86, #E91E63);
                -webkit-background-clip: text;
                -webkit-text-fill-color: transparent;
                margin-bottom: 16px;
            }
            .footer-text {
                font-size: 14px;
                color: #6C757D;
                margin-bottom: 8px;
            }
            .footer-links {
                margin-top: 20px;
            }
            .footer-link {
                color: #7C2B86;
                text-decoration: none;
                font-weight: 500;
                margin: 0 12px;
            }
            @media (max-width: 600px) {
                .container { margin: 10px; }
                .header, .content, .footer { padding: 24px; }
                .action-buttons { flex-direction: column; }
                .detail-item { flex-direction: column; align-items: flex-start; }
                .detail-value { max-width: 100%; text-align: left; margin-top: 4px; }
            }
        </style>
    </head>
    <body>
        <div class="container">
            <div class="header">
                <span class="security-icon">🔐</span>
                <div class="logo">Circle</div>
                <div class="header-subtitle">Security Alert</div>
                <div class="alert-badge">New Login Detected</div>
            </div>
            
            <div class="content">
                <div class="alert-title">Hi ${name}, we detected a new login</div>
                
                <div class="alert-message">
                    Someone just signed in to your Circle account. If this was you, you can safely ignore this email. 
                    If you don't recognize this activity, please secure your account immediately.
                </div>
                
                <div class="login-details">
                    <h3>🔍 Login Details</h3>
                    <div class="detail-item">
                        <span class="detail-label">Time</span>
                        <span class="detail-value">${timestamp}</span>
                    </div>
                    <div class="detail-item">
                        <span class="detail-label">Device</span>
                        <span class="detail-value">${device}</span>
                    </div>
                    <div class="detail-item">
                        <span class="detail-label">Location</span>
                        <span class="detail-value">${location}</span>
                    </div>
                    <div class="detail-item">
                        <span class="detail-label">IP Address</span>
                        <span class="detail-value">${ip}</span>
                    </div>
                </div>
                
                <div class="security-section">
                    <div class="icon">⚠️</div>
                    <div class="title">Didn't recognize this login?</div>
                    <div class="text">
                        If this wasn't you, your account may be compromised. Take action immediately to secure your account 
                        and prevent unauthorized access.
                    </div>
                    <div class="action-buttons">
                        <a href="#" class="btn btn-primary">Secure My Account</a>
                        <a href="#" class="btn btn-secondary">Change Password</a>
                    </div>
                </div>
                
                <div class="tips-section">
                    <div class="tips-title">🛡️ Keep Your Account Safe</div>
                    <div class="tip-item">
                        <span class="tip-icon">✅</span>
                        <div class="tip-text">Use a strong, unique password for your Circle account</div>
                    </div>
                    <div class="tip-item">
                        <span class="tip-icon">✅</span>
                        <div class="tip-text">Enable two-factor authentication for extra security</div>
                    </div>
                    <div class="tip-item">
                        <span class="tip-icon">✅</span>
                        <div class="tip-text">Never share your login credentials with anyone</div>
                    </div>
                    <div class="tip-item">
                        <span class="tip-icon">✅</span>
                        <div class="tip-text">Log out from shared or public devices</div>
                    </div>
                </div>
            </div>
            
            <div class="footer">
                <div class="footer-logo">Circle</div>
                <div class="footer-text">Keeping your account secure 🔒</div>
                <div class="footer-text">Questions? We're here to help.</div>
                
                <div class="footer-links">
                    <a href="#" class="footer-link">Security Center</a>
                    <a href="#" class="footer-link">Contact Support</a>
                    <a href="#" class="footer-link">Privacy Policy</a>
                </div>
                
                <div style="margin-top: 24px; font-size: 12px; color: #ADB5BD;">
                    This is an automated security alert from Circle. Please do not reply to this email.
                    <br>© 2024 Circle App. All rights reserved.
                </div>
            </div>
        </div>
    </body>
    </html>
    `
  }

  /**
   * Send signup success email (after profile completion)
   */
  async sendSignupSuccessEmail(email: string, name: string): Promise<boolean> {
    try {
      // Send welcome email
      const welcomeSent = await this.sendWelcomeEmail(email, name)
      
      // Log signup completion
      console.log(`🎉 User ${name} (${email}) completed signup successfully`)
      
      return welcomeSent
    } catch (error) {
      console.error('❌ Failed to send signup success email:', error)
      return false
    }
  }
}

export default new EmailService()
