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
    // Configure email transporter (using Gmail as example)
    this.transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: process.env.EMAIL_USER, // Your email
        pass: process.env.EMAIL_APP_PASSWORD, // App password
      },
    })

    // Alternative SMTP configuration
    // this.transporter = nodemailer.createTransport({
    //   host: process.env.SMTP_HOST,
    //   port: parseInt(process.env.SMTP_PORT || '587'),
    //   secure: false,
    //   auth: {
    //     user: process.env.SMTP_USER,
    //     pass: process.env.SMTP_PASS,
    //   },
    // })
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
      const mailOptions = {
        from: `"Circle App" <${process.env.EMAIL_USER}>`,
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
   * Get OTP email template
   */
  private getOTPEmailTemplate(otp: string, name?: string): string {
    return `
    <!DOCTYPE html>
    <html>
    <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Verify Your Email - Circle App</title>
        <style>
            body {
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                line-height: 1.6;
                color: #333;
                max-width: 600px;
                margin: 0 auto;
                padding: 20px;
                background-color: #f5f5f5;
            }
            .container {
                background: white;
                border-radius: 16px;
                padding: 40px;
                box-shadow: 0 4px 20px rgba(0,0,0,0.1);
            }
            .header {
                text-align: center;
                margin-bottom: 30px;
            }
            .logo {
                font-size: 32px;
                font-weight: bold;
                background: linear-gradient(135deg, #7C2B86, #E91E63);
                -webkit-background-clip: text;
                -webkit-text-fill-color: transparent;
                margin-bottom: 10px;
            }
            .otp-code {
                font-size: 36px;
                font-weight: bold;
                color: #7C2B86;
                text-align: center;
                padding: 20px;
                background: linear-gradient(135deg, #F3E5F5, #FCE4EC);
                border-radius: 12px;
                margin: 30px 0;
                letter-spacing: 8px;
                border: 2px solid #E1BEE7;
            }
            .message {
                text-align: center;
                margin-bottom: 30px;
            }
            .warning {
                background: #FFF3E0;
                border: 1px solid #FFB74D;
                border-radius: 8px;
                padding: 15px;
                margin: 20px 0;
                font-size: 14px;
            }
            .footer {
                text-align: center;
                margin-top: 30px;
                padding-top: 20px;
                border-top: 1px solid #eee;
                font-size: 14px;
                color: #666;
            }
        </style>
    </head>
    <body>
        <div class="container">
            <div class="header">
                <div class="logo">Circle</div>
                <h1>Verify Your Email Address</h1>
            </div>
            
            <div class="message">
                <p>Hi${name ? ` ${name}` : ''}! 👋</p>
                <p>Welcome to Circle! Please use the verification code below to complete your registration:</p>
            </div>
            
            <div class="otp-code">${otp}</div>
            
            <div class="message">
                <p>Enter this code in the Circle app to verify your email address.</p>
            </div>
            
            <div class="warning">
                <strong>⏰ Important:</strong>
                <ul style="margin: 10px 0; padding-left: 20px;">
                    <li>This code expires in <strong>10 minutes</strong></li>
                    <li>Don't share this code with anyone</li>
                    <li>If you didn't request this, please ignore this email</li>
                </ul>
            </div>
            
            <div class="footer">
                <p>Thanks for joining Circle! 💜</p>
                <p>If you have any questions, contact us at support@circle-app.com</p>
                <p style="margin-top: 20px; font-size: 12px;">
                    This is an automated message. Please do not reply to this email.
                </p>
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
      const mailOptions = {
        from: `"Circle App" <${process.env.EMAIL_USER}>`,
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
   * Get welcome email template
   */
  private getWelcomeEmailTemplate(name: string): string {
    return `
    <!DOCTYPE html>
    <html>
    <head>
        <meta charset="utf-8">
        <title>Welcome to Circle!</title>
        <style>
            body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; }
            .container { background: white; border-radius: 16px; padding: 40px; }
            .logo { font-size: 32px; font-weight: bold; color: #7C2B86; text-align: center; margin-bottom: 20px; }
            .welcome { text-align: center; margin: 30px 0; }
            .features { margin: 30px 0; }
            .feature { margin: 15px 0; padding: 15px; background: #F3E5F5; border-radius: 8px; }
        </style>
    </head>
    <body>
        <div class="container">
            <div class="logo">Circle</div>
            <div class="welcome">
                <h1>Welcome to Circle, ${name}! 🎉</h1>
                <p>Your email has been verified successfully. You're now ready to start connecting with amazing people!</p>
            </div>
            
            <div class="features">
                <h3>What you can do now:</h3>
                <div class="feature">💕 <strong>Find Matches:</strong> Discover people who share your interests</div>
                <div class="feature">💬 <strong>Start Chatting:</strong> Connect with your matches instantly</div>
                <div class="feature">👫 <strong>Make Friends:</strong> Build meaningful friendships</div>
                <div class="feature">📍 <strong>Location-based:</strong> Meet people nearby</div>
            </div>
            
            <div style="text-align: center; margin-top: 30px;">
                <p>Happy connecting! 💜</p>
                <p><em>The Circle Team</em></p>
            </div>
        </div>
    </body>
    </html>
    `
  }
}

export default new EmailService()
