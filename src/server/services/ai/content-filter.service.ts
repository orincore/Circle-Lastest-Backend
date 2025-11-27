import { logger } from '../../config/logger.js'

/**
 * Together AI Content Filter Service for Personal Information Detection
 * Used in blind dating feature to filter messages containing personal info
 */

export interface PersonalInfoAnalysis {
  containsPersonalInfo: boolean
  confidence: number
  detectedTypes: PersonalInfoType[]
  flaggedContent: FlaggedContent[]
  safeMessage?: string
  rawAnalysis?: string
}

export type PersonalInfoType = 
  | 'full_name'
  | 'phone_number'
  | 'email'
  | 'social_media'
  | 'address'
  | 'workplace'
  | 'school'
  | 'username'
  | 'instagram'
  | 'snapchat'
  | 'whatsapp'
  | 'facebook'
  | 'twitter'
  | 'tiktok'
  | 'linkedin'
  | 'location_specific'
  | 'other_identifier'

export interface FlaggedContent {
  type: PersonalInfoType
  text: string
  startIndex: number
  endIndex: number
  confidence: number
}

export class ContentFilterService {
  private static readonly API_BASE_URL = 'https://api.together.xyz/v1'
  // Using Llama-3.2-3B-Instruct-Turbo - fast, cheap, and effective for classification
  private static readonly MODEL = 'meta-llama/Llama-3.2-3B-Instruct-Turbo'
  private static readonly MAX_TOKENS = 300
  private static readonly TEMPERATURE = 0.1 // Very low for consistent analysis
  
  private static getApiKey(): string {
    const apiKey = process.env.TOGETHER_AI_API_KEY
    if (!apiKey) {
      throw new Error('TOGETHER_AI_API_KEY environment variable is required')
    }
    return apiKey
  }

  /**
   * Analyze a message for personal information
   * Returns analysis with detected personal info types and confidence
   */
  static async analyzeMessage(message: string, context?: {
    senderGender?: string
    receiverGender?: string
    messageCount?: number
  }): Promise<PersonalInfoAnalysis> {
    try {
      if (!message || message.trim().length === 0) {
        return {
          containsPersonalInfo: false,
          confidence: 1.0,
          detectedTypes: [],
          flaggedContent: []
        }
      }

      // Quick check first - if no patterns detected, skip AI call
      if (!this.quickCheck(message)) {
        return {
          containsPersonalInfo: false,
          confidence: 0.95,
          detectedTypes: [],
          flaggedContent: []
        }
      }

      const prompt = this.buildAnalysisPrompt(message, context)
      
      const response = await fetch(`${this.API_BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.getApiKey()}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: this.MODEL,
          messages: [
            { role: 'system', content: this.getSystemPrompt() },
            { role: 'user', content: prompt }
          ],
          max_tokens: this.MAX_TOKENS,
          temperature: this.TEMPERATURE,
          stream: false
        })
      })

      if (!response.ok) {
        const errorText = await response.text()
        logger.error({ status: response.status, error: errorText }, 'Together AI API error')
        // Fall back to pattern detection
        return this.fallbackPatternDetection(message)
      }

      const data = await response.json()
      const aiResponse = data.choices?.[0]?.message?.content || ''
      
      return this.parseAnalysisResponse(aiResponse, message)
    } catch (error) {
      logger.error({ error, message: message.substring(0, 50) }, 'Failed to analyze message with Together AI')
      
      // Fallback: Use pattern-based detection if AI fails
      return this.fallbackPatternDetection(message)
    }
  }

  /**
   * System prompt for the AI
   */
  private static getSystemPrompt(): string {
    return `You are a content moderation AI for a blind dating app. Your ONLY job is to detect if a message contains personal identifying information.

You must respond with ONLY valid JSON in this exact format:
{
  "containsPersonalInfo": true or false,
  "confidence": 0.0 to 1.0,
  "detectedTypes": ["type1", "type2"],
  "flaggedContent": [{"type": "type_name", "text": "flagged text", "confidence": 0.9}],
  "explanation": "brief reason"
}

Personal info types to detect:
- phone_number: Any phone number format
- email: Email addresses
- instagram, snapchat, whatsapp, facebook, twitter, tiktok, linkedin: Social media handles
- social_media: General social media mentions
- full_name: First and last name together
- address: Physical addresses
- workplace: Specific company names
- school: Specific school/university names
- username: Any username that could identify them
- location_specific: Very specific locations (street names, etc)
- other_identifier: Any other identifying info

DO NOT flag:
- Age, general interests, hobbies
- Generic job titles without company names
- General city names (partially shared already)
- Emotional expressions
- Hypothetical scenarios

Respond ONLY with JSON, nothing else.`
  }

  /**
   * Build the prompt for analysis
   */
  private static buildAnalysisPrompt(message: string, context?: {
    senderGender?: string
    receiverGender?: string
    messageCount?: number
  }): string {
    return `Analyze this message from an anonymous blind date chat for personal information:

MESSAGE: "${message}"

${context?.messageCount ? `(This is message #${context.messageCount} in the conversation)` : ''}

Does this message contain personal identifying information that should be blocked?`
  }

  /**
   * Parse the AI response into structured analysis
   */
  private static parseAnalysisResponse(response: string, originalMessage: string): PersonalInfoAnalysis {
    try {
      // Try to extract JSON from response
      const jsonMatch = response.match(/\{[\s\S]*\}/)
      if (!jsonMatch) {
        logger.warn({ response: response.substring(0, 200) }, 'Could not extract JSON from Together AI response')
        return this.fallbackPatternDetection(originalMessage)
      }

      const parsed = JSON.parse(jsonMatch[0])
      
      // Map flagged content with positions
      const flaggedContent: FlaggedContent[] = (parsed.flaggedContent || []).map((item: any) => {
        const text = item.text || ''
        const startIndex = originalMessage.toLowerCase().indexOf(text.toLowerCase())
        return {
          type: item.type as PersonalInfoType,
          text: text,
          startIndex: startIndex >= 0 ? startIndex : 0,
          endIndex: startIndex >= 0 ? startIndex + text.length : 0,
          confidence: item.confidence || parsed.confidence || 0.8
        }
      })

      return {
        containsPersonalInfo: parsed.containsPersonalInfo === true,
        confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0.8,
        detectedTypes: parsed.detectedTypes || [],
        flaggedContent,
        rawAnalysis: parsed.explanation
      }
    } catch (error) {
      logger.error({ error, response: response.substring(0, 200) }, 'Failed to parse Together AI response')
      return this.fallbackPatternDetection(originalMessage)
    }
  }

  /**
   * Fallback pattern-based detection when AI is unavailable
   */
  private static fallbackPatternDetection(message: string): PersonalInfoAnalysis {
    const detectedTypes: PersonalInfoType[] = []
    const flaggedContent: FlaggedContent[] = []
    const lowerMessage = message.toLowerCase()

    // Phone number patterns (various formats)
    const phonePatterns = [
      /\+?[\d\s\-\(\)]{10,}/g,
      /\d{3}[\s\-]?\d{3}[\s\-]?\d{4}/g,
      /\d{10,}/g
    ]
    
    for (const pattern of phonePatterns) {
      const matches = message.match(pattern)
      if (matches) {
        for (const match of matches) {
          if (match.replace(/\D/g, '').length >= 10) {
            if (!detectedTypes.includes('phone_number')) {
              detectedTypes.push('phone_number')
            }
            flaggedContent.push({
              type: 'phone_number',
              text: match,
              startIndex: message.indexOf(match),
              endIndex: message.indexOf(match) + match.length,
              confidence: 0.9
            })
          }
        }
        break
      }
    }

    // Email pattern
    const emailPattern = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/gi
    const emails = message.match(emailPattern)
    if (emails) {
      detectedTypes.push('email')
      emails.forEach(email => {
        flaggedContent.push({
          type: 'email',
          text: email,
          startIndex: message.indexOf(email),
          endIndex: message.indexOf(email) + email.length,
          confidence: 0.95
        })
      })
    }

    // Social media patterns
    const socialMediaPatterns: Array<{ pattern: RegExp; type: PersonalInfoType }> = [
      { pattern: /@[a-zA-Z0-9_]{2,30}/g, type: 'instagram' },
      { pattern: /instagram[:\s]*@?[a-zA-Z0-9_\.]+/gi, type: 'instagram' },
      { pattern: /\binsta[:\s]*@?[a-zA-Z0-9_\.]+/gi, type: 'instagram' },
      { pattern: /\big[:\s]*@?[a-zA-Z0-9_\.]+/gi, type: 'instagram' },
      { pattern: /snapchat[:\s]*@?[a-zA-Z0-9_\.]+/gi, type: 'snapchat' },
      { pattern: /\bsnap[:\s]*@?[a-zA-Z0-9_\.]+/gi, type: 'snapchat' },
      { pattern: /whatsapp[:\s]*\+?[\d\s]+/gi, type: 'whatsapp' },
      { pattern: /facebook\.com\/[a-zA-Z0-9.]+/gi, type: 'facebook' },
      { pattern: /\bfb[:\s]*[a-zA-Z0-9.]+/gi, type: 'facebook' },
      { pattern: /twitter[:\s]*@?[a-zA-Z0-9_]+/gi, type: 'twitter' },
      { pattern: /\btiktok[:\s]*@?[a-zA-Z0-9_\.]+/gi, type: 'tiktok' },
      { pattern: /linkedin\.com\/in\/[a-zA-Z0-9-]+/gi, type: 'linkedin' }
    ]

    for (const { pattern, type } of socialMediaPatterns) {
      const matches = message.match(pattern)
      if (matches) {
        if (!detectedTypes.includes(type)) {
          detectedTypes.push(type)
        }
        matches.forEach(match => {
          // Avoid duplicates
          if (!flaggedContent.some(f => f.text === match)) {
            flaggedContent.push({
              type,
              text: match,
              startIndex: message.indexOf(match),
              endIndex: message.indexOf(match) + match.length,
              confidence: 0.85
            })
          }
        })
      }
    }

    // Keywords that suggest sharing personal info
    const suspiciousKeywords = [
      'my number is',
      'call me at',
      'text me at',
      'reach me at',
      'find me on',
      'add me on',
      'follow me',
      'my instagram',
      'my snap',
      'my facebook',
      'my whatsapp',
      'dm me on',
      'message me on',
      "here's my",
      'my full name is',
      'i live at',
      'i work at',
      'i go to school at',
      'my address'
    ]

    for (const keyword of suspiciousKeywords) {
      if (lowerMessage.includes(keyword)) {
        if (!detectedTypes.includes('other_identifier')) {
          detectedTypes.push('other_identifier')
        }
        const idx = lowerMessage.indexOf(keyword)
        flaggedContent.push({
          type: 'other_identifier',
          text: message.substring(idx, Math.min(idx + keyword.length + 30, message.length)),
          startIndex: idx,
          endIndex: Math.min(idx + keyword.length + 30, message.length),
          confidence: 0.7
        })
      }
    }

    const containsPersonalInfo = detectedTypes.length > 0

    return {
      containsPersonalInfo,
      confidence: containsPersonalInfo ? 0.8 : 1.0,
      detectedTypes,
      flaggedContent
    }
  }

  /**
   * Create a sanitized version of the message with personal info redacted
   */
  static sanitizeMessage(message: string, analysis: PersonalInfoAnalysis): string {
    if (!analysis.containsPersonalInfo || analysis.flaggedContent.length === 0) {
      return message
    }

    let sanitized = message
    
    // Sort by start index descending so we replace from end to start
    const sortedFlags = [...analysis.flaggedContent].sort((a, b) => b.startIndex - a.startIndex)
    
    for (const flag of sortedFlags) {
      if (flag.startIndex >= 0 && flag.endIndex > flag.startIndex) {
        const replacement = '[Personal info removed]'
        sanitized = sanitized.substring(0, flag.startIndex) + replacement + sanitized.substring(flag.endIndex)
      }
    }

    return sanitized
  }

  /**
   * Quick check if message likely contains personal info (fast, pattern-based)
   * Use this for quick screening before calling the full AI analysis
   */
  static quickCheck(message: string): boolean {
    const lowerMessage = message.toLowerCase()
    
    // Quick patterns that almost certainly indicate personal info
    const quickPatterns = [
      /@[a-zA-Z0-9_]{3,}/,
      /\+?[\d\s\-]{10,}/,
      /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/i,
      /instagram|snapchat|whatsapp|facebook|twitter|tiktok|linkedin/i,
      /my number|call me|text me|reach me at|find me on|add me|follow me/i,
      /my insta|my snap|my fb|dm me|message me on/i
    ]

    for (const pattern of quickPatterns) {
      if (pattern.test(message)) {
        return true
      }
    }

    return false
  }

  /**
   * Test the content filter with sample messages
   */
  static async runTests(): Promise<{
    passed: number
    failed: number
    results: Array<{
      message: string
      expected: boolean
      actual: boolean
      passed: boolean
      analysis: PersonalInfoAnalysis
    }>
  }> {
    const testCases = [
      // Should be BLOCKED (contains personal info)
      { message: "My instagram is @johndoe123", shouldBlock: true },
      { message: "Text me at 555-123-4567", shouldBlock: true },
      { message: "My email is john@example.com", shouldBlock: true },
      { message: "Add me on snapchat: cooluser99", shouldBlock: true },
      { message: "Find me on Facebook, my name is John Smith", shouldBlock: true },
      { message: "My whatsapp number is +1234567890", shouldBlock: true },
      { message: "DM me on twitter @myhandle", shouldBlock: true },
      { message: "I work at Google headquarters in Mountain View", shouldBlock: true },
      { message: "My address is 123 Main Street", shouldBlock: true },
      
      // Should be ALLOWED (no personal info)
      { message: "Hi! How are you doing today?", shouldBlock: false },
      { message: "I love hiking and photography", shouldBlock: false },
      { message: "What kind of music do you like?", shouldBlock: false },
      { message: "I'm 25 years old and work in tech", shouldBlock: false },
      { message: "I live in a big city", shouldBlock: false },
      { message: "What are your hobbies?", shouldBlock: false },
      { message: "I enjoy cooking Italian food", shouldBlock: false },
      { message: "Do you like traveling?", shouldBlock: false },
      { message: "I have a dog named Max", shouldBlock: false },
      { message: "What do you do for fun?", shouldBlock: false },
    ]

    const results = []
    let passed = 0
    let failed = 0

    for (const testCase of testCases) {
      const analysis = await this.analyzeMessage(testCase.message)
      const actualBlocked = analysis.containsPersonalInfo
      const testPassed = actualBlocked === testCase.shouldBlock

      if (testPassed) {
        passed++
      } else {
        failed++
      }

      results.push({
        message: testCase.message,
        expected: testCase.shouldBlock,
        actual: actualBlocked,
        passed: testPassed,
        analysis
      })
    }

    return { passed, failed, results }
  }

  /**
   * Validate API connection
   */
  static async validateConnection(): Promise<boolean> {
    try {
      const response = await fetch(`${this.API_BASE_URL}/models`, {
        headers: {
          'Authorization': `Bearer ${this.getApiKey()}`
        }
      })
      return response.ok
    } catch (error) {
      logger.error({ error }, 'Failed to validate Together AI connection')
      return false
    }
  }

  /**
   * Get service info
   */
  static getServiceInfo(): {
    model: string
    provider: string
    endpoint: string
    features: string[]
  } {
    return {
      model: this.MODEL,
      provider: 'Together AI',
      endpoint: this.API_BASE_URL,
      features: [
        'Personal information detection',
        'Phone number recognition',
        'Email detection',
        'Social media handle detection',
        'Address and location detection',
        'Workplace/school detection',
        'Pattern-based fallback detection',
        'Quick check for fast screening'
      ]
    }
  }
}

export default ContentFilterService

