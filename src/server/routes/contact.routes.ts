import { Router, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';

const router = Router();

// Rate limiting for contact form - 5 submissions per hour per IP
const contactRateLimit = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 5, // 5 requests per hour
  message: {
    error: 'Too many contact form submissions. Please try again later.',
    code: 'RATE_LIMIT_EXCEEDED'
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// Simple validation function
const validateContactForm = (data: any) => {
  const errors: string[] = [];
  
  if (!data.name || typeof data.name !== 'string') {
    errors.push('Name is required');
  } else if (data.name.trim().length < 2 || data.name.trim().length > 100) {
    errors.push('Name must be between 2 and 100 characters');
  } else if (!/^[a-zA-Z\s]+$/.test(data.name.trim())) {
    errors.push('Name can only contain letters and spaces');
  }
  
  if (!data.email || typeof data.email !== 'string') {
    errors.push('Email is required');
  } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email.trim())) {
    errors.push('Please provide a valid email address');
  }
  
  if (!data.subject || typeof data.subject !== 'string') {
    errors.push('Subject is required');
  } else if (data.subject.trim().length < 5 || data.subject.trim().length > 200) {
    errors.push('Subject must be between 5 and 200 characters');
  }
  
  if (!data.message || typeof data.message !== 'string') {
    errors.push('Message is required');
  } else if (data.message.trim().length < 10 || data.message.trim().length > 2000) {
    errors.push('Message must be between 10 and 2000 characters');
  }
  
  return errors;
};

/**
 * POST /api/contact
 * Submit contact form
 */
router.post('/', contactRateLimit, async (req: Request, res: Response) => {
  try {
    // Validate form data
    const validationErrors = validateContactForm(req.body);
    if (validationErrors.length > 0) {
      return res.status(400).json({
        error: 'Validation failed',
        details: validationErrors
      });
    }

    const { name, email, subject, message } = req.body;
    
    // Get client IP for logging
    const clientIP = req.ip || 'unknown';
    
    

    // Store contact form data (in production, you would save to database)
    const contactData = {
      name: name.trim(),
      email: email.trim(),
      subject: subject.trim(),
      message: message.trim(),
      clientIP,
      timestamp: new Date().toISOString()
    };
    
    // TODO: Save to database
    // await saveContactFormSubmission(contactData);
    
    // TODO: Send email notifications
    // In production, integrate with email service (SendGrid, AWS SES, etc.)
    //console.log('📧 Contact form data ready for processing:', contactData);

    // Return success response
    res.status(200).json({
      success: true,
      message: 'Thank you for your message! We will get back to you soon.',
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('❌ Contact form error:', error);
    
    res.status(500).json({
      error: 'Internal server error. Please try again later.',
      code: 'INTERNAL_ERROR'
    });
  }
});

/**
 * GET /api/contact/health
 * Health check for contact service
 */
router.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    service: 'contact',
    timestamp: new Date().toISOString(),
    rateLimit: {
      windowMs: 60 * 60 * 1000,
      max: 5
    }
  });
});

export default router;
