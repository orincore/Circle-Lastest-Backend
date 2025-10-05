import nodemailer from 'nodemailer';

// Email service using Brevo (Sendinblue) SMTP
class EmailService {
  private transporter: nodemailer.Transporter;

  constructor() {
    this.transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST || 'smtp-relay.brevo.com',
      port: parseInt(process.env.SMTP_PORT || '587'),
      secure: false, // Use TLS
      auth: {
        user: process.env.SMTP_USER || '',
        pass: process.env.SMTP_PASSWORD || '',
      },
    });

    // Verify connection configuration
    this.transporter.verify((error: Error | null, success: boolean) => {
      if (error) {
        console.error('❌ Email service connection failed:', error);
      } else {
        console.log('✅ Email service ready to send messages');
      }
    });
  }

  async sendEmail(options: {
    to: string;
    subject: string;
    html: string;
    text?: string;
    from?: string;
  }) {
    try {
      const defaultFrom = process.env.SMTP_FROM_EMAIL || '"Circle App" <noreply@circle.orincore.com>';
      const mailOptions = {
        from: options.from || defaultFrom,
        to: options.to,
        subject: options.subject,
        html: options.html,
        text: options.text || options.html.replace(/<[^>]*>/g, ''), // Strip HTML for text version
      };

      const info = await this.transporter.sendMail(mailOptions);
      console.log('✅ Email sent:', info.messageId);
      return { success: true, messageId: info.messageId };
    } catch (error) {
      console.error('❌ Failed to send email:', error);
      throw error;
    }
  }

  async sendBulkEmails(emails: Array<{
    to: string;
    subject: string;
    html: string;
    text?: string;
  }>) {
    const results = {
      sent: 0,
      failed: 0,
      errors: [] as any[],
    };

    for (const email of emails) {
      try {
        await this.sendEmail(email);
        results.sent++;
      } catch (error) {
        results.failed++;
        results.errors.push({
          to: email.to,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    }

    return results;
  }

  // Create HTML email template with tracking
  createEmailTemplate(options: {
    title: string;
    content: string;
    buttonText?: string;
    buttonUrl?: string;
    campaignId?: string;
    userId?: string;
  }) {
    const { title, content, buttonText, buttonUrl, campaignId, userId } = options;
    
    // Create tracking URLs
    const trackingBaseUrl = process.env.API_BASE_URL || 'http://localhost:8080';
    const openTrackingUrl = campaignId && userId 
      ? `${trackingBaseUrl}/api/admin/campaigns/${campaignId}/track/open?userId=${userId}`
      : null;
    const clickTrackingUrl = campaignId && userId && buttonUrl
      ? `${trackingBaseUrl}/api/admin/campaigns/${campaignId}/track/click?userId=${userId}&url=${encodeURIComponent(buttonUrl)}`
      : buttonUrl;

    return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
      line-height: 1.6;
      color: #333;
      max-width: 600px;
      margin: 0 auto;
      padding: 20px;
      background-color: #f5f5f5;
    }
    .container {
      background-color: #ffffff;
      border-radius: 8px;
      padding: 40px;
      box-shadow: 0 2px 4px rgba(0,0,0,0.1);
    }
    .header {
      text-align: center;
      margin-bottom: 30px;
    }
    .logo {
      font-size: 32px;
      font-weight: bold;
      color: #7C2B86;
      margin-bottom: 10px;
    }
    h1 {
      color: #1F1147;
      font-size: 24px;
      margin-bottom: 20px;
    }
    .content {
      color: #555;
      font-size: 16px;
      margin-bottom: 30px;
    }
    .button {
      display: inline-block;
      padding: 14px 28px;
      background-color: #7C2B86;
      color: #ffffff !important;
      text-decoration: none;
      border-radius: 6px;
      font-weight: 600;
      text-align: center;
    }
    .button:hover {
      background-color: #6A2474;
    }
    .footer {
      margin-top: 40px;
      padding-top: 20px;
      border-top: 1px solid #e0e0e0;
      text-align: center;
      color: #999;
      font-size: 14px;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <div class="logo">Circle</div>
    </div>
    <h1>${title}</h1>
    <div class="content">
      ${content}
    </div>
    ${buttonText && clickTrackingUrl ? `
    <div style="text-align: center;">
      <a href="${clickTrackingUrl}" class="button">${buttonText}</a>
    </div>
    ` : ''}
    <div class="footer">
      <p>This email was sent by Circle App</p>
      <p>If you didn't request this email, please ignore it.</p>
    </div>
  </div>
  ${openTrackingUrl ? `
  <!-- Open tracking pixel -->
  <img src="${openTrackingUrl}" width="1" height="1" style="display:none;" alt="" />
  ` : ''}
</body>
</html>
    `.trim();
  }
}

export default new EmailService();
