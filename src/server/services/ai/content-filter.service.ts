import { logger } from '../../config/logger.js'

/**
 * Together AI Content Filter Service for Personal Information Detection
 * AGGRESSIVE filtering for blind dating - blocks any identifying information
 * Users must remain completely anonymous until mutual reveal
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
  | 'first_name'
  | 'last_name'
  | 'full_name'
  | 'nickname'
  | 'phone_number'
  | 'phone_words'
  | 'email'
  | 'social_media'
  | 'address'
  | 'workplace'
  | 'company_name'
  | 'school'
  | 'university'
  | 'username'
  | 'instagram'
  | 'snapchat'
  | 'whatsapp'
  | 'facebook'
  | 'twitter'
  | 'tiktok'
  | 'linkedin'
  | 'discord'
  | 'telegram'
  | 'location_specific'
  | 'street_address'
  | 'personal_website'
  | 'other_identifier'

export interface FlaggedContent {
  type: PersonalInfoType
  text: string
  startIndex: number
  endIndex: number
  confidence: number
}

// Common first names database (expanded)
const COMMON_FIRST_NAMES = new Set([
  // Male names
  'james', 'john', 'robert', 'michael', 'david', 'william', 'richard', 'joseph', 'thomas', 'charles',
  'daniel', 'matthew', 'anthony', 'mark', 'donald', 'steven', 'paul', 'andrew', 'joshua', 'kenneth',
  'kevin', 'brian', 'george', 'timothy', 'ronald', 'edward', 'jason', 'jeffrey', 'ryan', 'jacob',
  'gary', 'nicholas', 'eric', 'jonathan', 'stephen', 'larry', 'justin', 'scott', 'brandon', 'benjamin',
  'samuel', 'raymond', 'gregory', 'frank', 'alexander', 'patrick', 'jack', 'dennis', 'jerry', 'tyler',
  'aaron', 'jose', 'adam', 'nathan', 'henry', 'zachary', 'douglas', 'peter', 'kyle', 'noah',
  'ethan', 'jeremy', 'walter', 'christian', 'keith', 'roger', 'terry', 'austin', 'sean', 'gerald',
  'carl', 'harold', 'dylan', 'arthur', 'lawrence', 'jordan', 'jesse', 'bryan', 'billy', 'bruce',
  'gabriel', 'joe', 'logan', 'albert', 'willie', 'alan', 'eugene', 'russell', 'vincent', 'philip',
  'bobby', 'johnny', 'bradley', 'roy', 'ralph', 'randy', 'louis', 'russell', 'howard', 'fred',
  // Female names
  'mary', 'patricia', 'jennifer', 'linda', 'barbara', 'elizabeth', 'susan', 'jessica', 'sarah', 'karen',
  'lisa', 'nancy', 'betty', 'margaret', 'sandra', 'ashley', 'kimberly', 'emily', 'donna', 'michelle',
  'dorothy', 'carol', 'amanda', 'melissa', 'deborah', 'stephanie', 'rebecca', 'sharon', 'laura', 'cynthia',
  'kathleen', 'amy', 'angela', 'shirley', 'anna', 'brenda', 'pamela', 'emma', 'nicole', 'helen',
  'samantha', 'katherine', 'christine', 'debra', 'rachel', 'carolyn', 'janet', 'catherine', 'maria', 'heather',
  'diane', 'ruth', 'julie', 'olivia', 'joyce', 'virginia', 'victoria', 'kelly', 'lauren', 'christina',
  'joan', 'evelyn', 'judith', 'megan', 'andrea', 'cheryl', 'hannah', 'jacqueline', 'martha', 'gloria',
  'teresa', 'ann', 'sara', 'madison', 'frances', 'kathryn', 'janice', 'jean', 'abigail', 'alice',
  'judy', 'sophia', 'grace', 'denise', 'amber', 'doris', 'marilyn', 'danielle', 'beverly', 'isabella',
  'theresa', 'diana', 'natalie', 'brittany', 'charlotte', 'marie', 'kayla', 'alexis', 'lori', 'julia',
  // Indian names
  'adarsh', 'rahul', 'priya', 'amit', 'pooja', 'raj', 'neha', 'vikram', 'anita', 'sanjay',
  'deepika', 'arjun', 'sneha', 'karan', 'kavita', 'rohit', 'anjali', 'vijay', 'divya', 'ravi',
  'sunita', 'manish', 'rekha', 'suresh', 'meera', 'ashok', 'lakshmi', 'anil', 'geeta', 'mukesh',
  'nisha', 'rajesh', 'shweta', 'vinod', 'rani', 'dinesh', 'sapna', 'ramesh', 'jyoti', 'prakash',
  'aarav', 'aanya', 'vivaan', 'aditi', 'vihaan', 'ananya', 'ishaan', 'aisha', 'aryan', 'kiara',
  // Other common international names
  'mohammed', 'muhammad', 'ahmed', 'ali', 'hassan', 'omar', 'fatima', 'aisha', 'sara', 'layla',
  'wei', 'chen', 'li', 'zhang', 'ming', 'ling', 'yuki', 'kenji', 'sakura', 'hiro',
  'carlos', 'maria', 'jose', 'juan', 'luis', 'ana', 'pedro', 'miguel', 'carmen', 'rosa',
  'nick', 'mike', 'sam', 'alex', 'chris', 'pat', 'kim', 'lee', 'jamie', 'taylor',
  'jordan', 'casey', 'riley', 'morgan', 'avery', 'drew', 'cameron', 'dakota', 'harley', 'quinn'
])

// Number words mapping
const NUMBER_WORDS: Record<string, string> = {
  'zero': '0', 'one': '1', 'two': '2', 'three': '3', 'four': '4',
  'five': '5', 'six': '6', 'seven': '7', 'eight': '8', 'nine': '9',
  'oh': '0', 'o': '0'
}

// Major companies that should be blocked
const MAJOR_COMPANIES = [
  'google', 'apple', 'microsoft', 'amazon', 'meta', 'facebook', 'netflix', 'tesla', 'uber', 'lyft',
  'airbnb', 'twitter', 'instagram', 'snapchat', 'tiktok', 'linkedin', 'spotify', 'adobe', 'oracle',
  'salesforce', 'ibm', 'intel', 'nvidia', 'amd', 'cisco', 'hp', 'dell', 'samsung', 'sony',
  'walmart', 'target', 'costco', 'starbucks', 'mcdonalds', 'subway', 'nike', 'adidas', 'disney',
  'coca cola', 'pepsi', 'boeing', 'lockheed', 'jpmorgan', 'goldman', 'morgan stanley', 'citi',
  'bank of america', 'wells fargo', 'chase', 'deloitte', 'pwc', 'kpmg', 'ernst', 'accenture',
  'mckinsey', 'bain', 'bcg', 'infosys', 'tcs', 'wipro', 'cognizant', 'capgemini', 'hcl',
  'zoho', 'freshworks', 'flipkart', 'swiggy', 'zomato', 'ola', 'paytm', 'razorpay', 'byju',
  'reliance', 'tata', 'mahindra', 'hdfc', 'icici', 'sbi', 'airtel', 'jio', 'vodafone'
]

// Universities and colleges
const UNIVERSITIES = [
  'harvard', 'stanford', 'mit', 'yale', 'princeton', 'columbia', 'berkeley', 'ucla', 'nyu', 'usc',
  'oxford', 'cambridge', 'imperial', 'lse', 'ucl', 'edinburgh', 'manchester', 'bristol', 'leeds',
  'iit', 'iim', 'bits', 'nit', 'vit', 'srm', 'manipal', 'amity', 'symbiosis', 'christ',
  'du', 'delhi university', 'jnu', 'mumbai university', 'pune university', 'anna university',
  'university of', 'college of', 'institute of', 'school of'
]

export class ContentFilterService {
  private static readonly API_BASE_URL = 'https://api.together.xyz/v1'
  private static readonly MODEL = 'meta-llama/Llama-3.2-3B-Instruct-Turbo'
  private static readonly MAX_TOKENS = 500
  private static readonly TEMPERATURE = 0.1

  private static getApiKey(): string {
    const apiKey = process.env.TOGETHER_AI_API_KEY
    if (!apiKey) {
      throw new Error('TOGETHER_AI_API_KEY environment variable is required')
    }
    return apiKey
  }

  /**
   * Analyze a message for personal information - AGGRESSIVE MODE
   * In blind dating, we err on the side of caution - if in doubt, BLOCK
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

      // ALWAYS run pattern detection first - it's fast and catches obvious cases
      const patternResult = this.aggressivePatternDetection(message)
      
      // If pattern detection found something with high confidence, block immediately
      if (patternResult.containsPersonalInfo && patternResult.confidence >= 0.7) {
        logger.info({ 
          message: message.substring(0, 50), 
          detectedTypes: patternResult.detectedTypes 
        }, 'Message blocked by pattern detection')
        return patternResult
      }

      // For edge cases, use AI for deeper analysis
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
        // Return pattern detection result as fallback
        return patternResult
      }

      const data = await response.json()
      const aiResponse = data.choices?.[0]?.message?.content || ''
      
      const aiResult = this.parseAnalysisResponse(aiResponse, message)
      
      // Merge AI result with pattern detection - if either finds something, block
      if (aiResult.containsPersonalInfo || patternResult.containsPersonalInfo) {
        return {
          containsPersonalInfo: true,
          confidence: Math.max(aiResult.confidence, patternResult.confidence),
          detectedTypes: [...new Set([...aiResult.detectedTypes, ...patternResult.detectedTypes])],
          flaggedContent: [...aiResult.flaggedContent, ...patternResult.flaggedContent],
          rawAnalysis: aiResult.rawAnalysis
        }
      }
      
      return aiResult
    } catch (error) {
      logger.error({ error, message: message.substring(0, 50) }, 'Failed to analyze message with Together AI')
      return this.aggressivePatternDetection(message)
    }
  }

  /**
   * System prompt - VERY AGGRESSIVE about blocking personal info
   */
  private static getSystemPrompt(): string {
    return `You are an EXTREMELY STRICT content moderation AI for an anonymous blind dating app.

Your job is to detect ANY information that could identify a person. You must be VERY AGGRESSIVE about blocking.

ALWAYS BLOCK messages containing:
1. ANY names (first name, last name, nickname, username, pet names people call them)
2. Phone numbers in ANY format (digits, words like "nine nine two four", spelled out)
3. ANY social media (Instagram, Snapchat, WhatsApp, Facebook, Twitter, TikTok, Discord, Telegram)
4. Email addresses
5. Physical addresses, street names, apartment numbers
6. Specific workplace/company names (Google, Apple, any specific company)
7. Specific school/university names (Harvard, MIT, any specific school)
8. Specific locations (building names, landmarks that could identify location)
9. Personal websites or URLs
10. Any username or handle that could be searched

PATTERNS TO BLOCK:
- "I am [name]" or "My name is [name]" or "I'm [name]" or "Call me [name]"
- "People call me [nickname]"
- Phone numbers written as words: "nine nine two four six eight"
- "I work at [company]" or "I'm at [company]"
- "My office is in [location]"
- "I go to [school]" or "I studied at [university]"
- "I live at/on/in [specific address]"
- "Find me at" or "Add me on" or "My [social media] is"

ALLOW:
- General interests and hobbies
- Age (already partially shared)
- General job descriptions without company names ("I work in tech", "I'm an engineer")
- General city (already partially shared in profile)
- Emotions and feelings
- Questions about preferences
- Generic pet names ("honey", "dear" - not specific to person)

Respond with ONLY valid JSON:
{
  "containsPersonalInfo": true/false,
  "confidence": 0.0-1.0,
  "detectedTypes": ["type1", "type2"],
  "flaggedContent": [{"type": "type_name", "text": "flagged text", "confidence": 0.9}],
  "explanation": "reason"
}

When in doubt, BLOCK. User anonymity is critical.`
  }

  /**
   * Build analysis prompt
   */
  private static buildAnalysisPrompt(message: string, context?: {
    senderGender?: string
    receiverGender?: string
    messageCount?: number
  }): string {
    return `STRICTLY analyze this message from an anonymous blind dating chat. Block ANY identifying information.

MESSAGE: "${message}"

${context?.messageCount ? `Message #${context.messageCount} in conversation.` : ''}

Look for:
- Names (first, last, nicknames)
- Phone numbers (digits OR words like "nine nine two")
- Social media handles/platforms
- Emails, websites
- Specific companies, schools, addresses
- Any phrase like "I am [name]", "call me [name]", "I work at [company]"

Does this message contain ANY personal identifying information? Be STRICT.`
  }

  /**
   * Parse AI response
   */
  private static parseAnalysisResponse(response: string, originalMessage: string): PersonalInfoAnalysis {
    try {
      const jsonMatch = response.match(/\{[\s\S]*\}/)
      if (!jsonMatch) {
        logger.warn({ response: response.substring(0, 200) }, 'Could not extract JSON from Together AI response')
        return this.aggressivePatternDetection(originalMessage)
      }

      const parsed = JSON.parse(jsonMatch[0])
      
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
      return this.aggressivePatternDetection(originalMessage)
    }
  }

  /**
   * AGGRESSIVE pattern-based detection - catches most cases without AI
   */
  private static aggressivePatternDetection(message: string): PersonalInfoAnalysis {
    const detectedTypes: PersonalInfoType[] = []
    const flaggedContent: FlaggedContent[] = []
    const lowerMessage = message.toLowerCase()
    const originalLower = message.toLowerCase()

    // ============ NAME DETECTION ============
    
    // Pattern: "I am [name]", "I'm [name]", "My name is [name]", "Call me [name]"
    const namePatterns = [
      /\b(?:i am|i'm|im|this is|my name is|name's|names|call me|people call me|they call me|everyone calls me|friends call me)\s+([a-zA-Z]{2,20})\b/gi,
      /\bhey,?\s+(?:i am|i'm|im)\s+([a-zA-Z]{2,20})\b/gi,
      /\b([a-zA-Z]{2,20})\s+here\b/gi,
    ]
    
    for (const pattern of namePatterns) {
      let match
      while ((match = pattern.exec(message)) !== null) {
        const potentialName = match[1]?.toLowerCase()
        if (potentialName && potentialName.length >= 2) {
          // Check if it's a common name OR if the pattern strongly suggests it's a name
          const isCommonName = COMMON_FIRST_NAMES.has(potentialName)
          const isNameIntro = /(?:i am|i'm|im|my name is|call me)/i.test(match[0])
          
          if (isCommonName || isNameIntro) {
            if (!detectedTypes.includes('first_name')) {
              detectedTypes.push('first_name')
            }
            flaggedContent.push({
              type: 'first_name',
              text: match[0],
              startIndex: match.index,
              endIndex: match.index + match[0].length,
              confidence: isCommonName ? 0.95 : 0.85
            })
          }
        }
      }
    }

    // Check for standalone common names (more risky but important)
    const words = message.split(/\s+/)
    for (const word of words) {
      const cleanWord = word.toLowerCase().replace(/[^a-z]/g, '')
      if (cleanWord.length >= 3 && COMMON_FIRST_NAMES.has(cleanWord)) {
        // Check context - is this likely a name being shared?
        const wordIndex = lowerMessage.indexOf(cleanWord)
        const beforeWord = lowerMessage.substring(Math.max(0, wordIndex - 20), wordIndex)
        const nameContextPatterns = /(?:am|i'm|im|name|call|called|it's|its)\s*$/i
        
        if (nameContextPatterns.test(beforeWord)) {
          if (!detectedTypes.includes('first_name')) {
            detectedTypes.push('first_name')
          }
          flaggedContent.push({
            type: 'first_name',
            text: word,
            startIndex: message.indexOf(word),
            endIndex: message.indexOf(word) + word.length,
            confidence: 0.8
          })
        }
      }
    }

    // ============ PHONE NUMBER DETECTION ============
    
    // Standard digit patterns
    const phonePatterns = [
      /\+?[\d\s\-\(\)\.]{10,}/g,
      /\d{3}[\s\-\.]?\d{3}[\s\-\.]?\d{4}/g,
      /\(\d{3}\)\s*\d{3}[\s\-]?\d{4}/g,
      /\d{5}[\s\-]?\d{5}/g,
      /\d{4}[\s\-]?\d{3}[\s\-]?\d{3}/g
    ]
    
    for (const pattern of phonePatterns) {
      const matches = message.match(pattern)
      if (matches) {
        for (const match of matches) {
          const digitsOnly = match.replace(/\D/g, '')
          if (digitsOnly.length >= 10) {
            if (!detectedTypes.includes('phone_number')) {
              detectedTypes.push('phone_number')
            }
            flaggedContent.push({
              type: 'phone_number',
              text: match,
              startIndex: message.indexOf(match),
              endIndex: message.indexOf(match) + match.length,
              confidence: 0.95
            })
          }
        }
      }
    }

    // Phone numbers in WORDS (like "nine nine two four six eight seven seven")
    const numberWordPattern = /\b(zero|one|two|three|four|five|six|seven|eight|nine|oh|o)(\s+(zero|one|two|three|four|five|six|seven|eight|nine|oh|o)){6,}/gi
    const wordMatches = message.match(numberWordPattern)
    if (wordMatches) {
      for (const match of wordMatches) {
        const words = match.toLowerCase().split(/\s+/)
        const digits = words.map(w => NUMBER_WORDS[w] || '').join('')
        if (digits.length >= 7) {
          if (!detectedTypes.includes('phone_words')) {
            detectedTypes.push('phone_words')
          }
          flaggedContent.push({
            type: 'phone_words',
            text: match,
            startIndex: message.toLowerCase().indexOf(match.toLowerCase()),
            endIndex: message.toLowerCase().indexOf(match.toLowerCase()) + match.length,
            confidence: 0.9
          })
        }
      }
    }

    // ============ EMAIL DETECTION ============
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
          confidence: 0.98
        })
      })
    }

    // ============ SOCIAL MEDIA DETECTION ============
    const socialMediaPatterns: Array<{ pattern: RegExp; type: PersonalInfoType }> = [
      // @ handles
      { pattern: /@[a-zA-Z0-9_\.]{2,30}/g, type: 'social_media' },
      
      // Instagram
      { pattern: /\b(?:instagram|insta|ig)\s*[:\-]?\s*@?[a-zA-Z0-9_\.]+/gi, type: 'instagram' },
      { pattern: /\bmy\s+(?:instagram|insta|ig)\b/gi, type: 'instagram' },
      
      // Snapchat
      { pattern: /\b(?:snapchat|snap|sc)\s*[:\-]?\s*@?[a-zA-Z0-9_\.]+/gi, type: 'snapchat' },
      { pattern: /\badd\s+(?:me\s+)?(?:on\s+)?snap/gi, type: 'snapchat' },
      
      // WhatsApp
      { pattern: /\b(?:whatsapp|whats\s*app|wa)\s*[:\-]?\s*\+?[\d\s]+/gi, type: 'whatsapp' },
      { pattern: /\btext\s+me\s+on\s+whatsapp/gi, type: 'whatsapp' },
      
      // Facebook
      { pattern: /\b(?:facebook|fb)\s*[:\-]?\s*@?[a-zA-Z0-9_\.]+/gi, type: 'facebook' },
      { pattern: /facebook\.com\/[a-zA-Z0-9.]+/gi, type: 'facebook' },
      
      // Twitter/X
      { pattern: /\b(?:twitter|tweet|x\.com)\s*[:\-]?\s*@?[a-zA-Z0-9_]+/gi, type: 'twitter' },
      
      // TikTok
      { pattern: /\b(?:tiktok|tik\s*tok)\s*[:\-]?\s*@?[a-zA-Z0-9_\.]+/gi, type: 'tiktok' },
      
      // LinkedIn
      { pattern: /\blinkedin\s*[:\-]?\s*[a-zA-Z0-9_\-]+/gi, type: 'linkedin' },
      { pattern: /linkedin\.com\/in\/[a-zA-Z0-9-]+/gi, type: 'linkedin' },
      
      // Discord
      { pattern: /\b(?:discord)\s*[:\-]?\s*[a-zA-Z0-9_#]+/gi, type: 'discord' },
      
      // Telegram
      { pattern: /\b(?:telegram|tg)\s*[:\-]?\s*@?[a-zA-Z0-9_]+/gi, type: 'telegram' },
      
      // General patterns
      { pattern: /\b(?:add|find|follow|dm|message)\s+me\s+(?:on|at)\s+\w+/gi, type: 'social_media' },
      { pattern: /\bmy\s+(?:handle|username|profile)\s+is/gi, type: 'username' },
    ]

    for (const { pattern, type } of socialMediaPatterns) {
      const matches = message.match(pattern)
      if (matches) {
        if (!detectedTypes.includes(type)) {
          detectedTypes.push(type)
        }
        matches.forEach(match => {
          if (!flaggedContent.some(f => f.text.toLowerCase() === match.toLowerCase())) {
            flaggedContent.push({
              type,
              text: match,
              startIndex: message.toLowerCase().indexOf(match.toLowerCase()),
              endIndex: message.toLowerCase().indexOf(match.toLowerCase()) + match.length,
              confidence: 0.9
            })
          }
        })
      }
    }

    // ============ WORKPLACE/COMPANY DETECTION ============
    const workPatterns = [
      /\b(?:i\s+)?work\s+(?:at|for|in)\s+([a-zA-Z\s&]+?)(?:\s+(?:headquarters|hq|office|campus|building))?(?:\s+in\s+[a-zA-Z\s]+)?/gi,
      /\b(?:employed|working)\s+(?:at|by|with)\s+([a-zA-Z\s&]+)/gi,
      /\bmy\s+(?:company|office|workplace)\s+is\s+([a-zA-Z\s&]+)/gi,
      /\bjob\s+(?:at|with)\s+([a-zA-Z\s&]+)/gi,
    ]

    for (const pattern of workPatterns) {
      let match
      while ((match = pattern.exec(message)) !== null) {
        const company = match[1]?.trim().toLowerCase()
        if (company) {
          // Check against known companies
          const isKnownCompany = MAJOR_COMPANIES.some(c => company.includes(c))
          if (isKnownCompany || company.length >= 3) {
            if (!detectedTypes.includes('workplace')) {
              detectedTypes.push('workplace')
            }
            flaggedContent.push({
              type: 'workplace',
              text: match[0],
              startIndex: match.index,
              endIndex: match.index + match[0].length,
              confidence: isKnownCompany ? 0.95 : 0.8
            })
          }
        }
      }
    }

    // Direct company name mentions
    for (const company of MAJOR_COMPANIES) {
      if (lowerMessage.includes(company)) {
        // Check if it's in a work context
        const companyIndex = lowerMessage.indexOf(company)
        const contextBefore = lowerMessage.substring(Math.max(0, companyIndex - 30), companyIndex)
        const workContext = /(?:work|job|employed|office|company|at|for|with)\s*$/i.test(contextBefore)
        
        if (workContext || lowerMessage.includes(`at ${company}`) || lowerMessage.includes(`for ${company}`)) {
          if (!detectedTypes.includes('company_name')) {
            detectedTypes.push('company_name')
          }
          flaggedContent.push({
            type: 'company_name',
            text: company,
            startIndex: message.toLowerCase().indexOf(company),
            endIndex: message.toLowerCase().indexOf(company) + company.length,
            confidence: 0.9
          })
        }
      }
    }

    // ============ SCHOOL/UNIVERSITY DETECTION ============
    const schoolPatterns = [
      /\b(?:i\s+)?(?:go|went|study|studied|attend|attended|graduate[d]?)\s+(?:to|at|from)\s+([a-zA-Z\s]+?)(?:\s+university|\s+college|\s+school)?/gi,
      /\b(?:student|alumni|alumnus|alumna)\s+(?:at|of|from)\s+([a-zA-Z\s]+)/gi,
    ]

    for (const pattern of schoolPatterns) {
      let match
      while ((match = pattern.exec(message)) !== null) {
        const school = match[1]?.trim().toLowerCase()
        if (school && school.length >= 3) {
          const isKnownSchool = UNIVERSITIES.some(u => school.includes(u))
          if (isKnownSchool) {
            if (!detectedTypes.includes('university')) {
              detectedTypes.push('university')
            }
            flaggedContent.push({
              type: 'university',
              text: match[0],
              startIndex: match.index,
              endIndex: match.index + match[0].length,
              confidence: 0.9
            })
          }
        }
      }
    }

    // ============ ADDRESS DETECTION ============
    const addressPatterns = [
      /\b\d+\s+[a-zA-Z]+\s+(?:street|st|avenue|ave|road|rd|drive|dr|lane|ln|boulevard|blvd|way|court|ct|circle|cir|place|pl)\b/gi,
      /\b(?:my\s+)?address\s+is\s+.+/gi,
      /\bi\s+live\s+(?:at|on|in)\s+\d+/gi,
      /\bapartment|apt\.?\s*#?\s*\d+/gi,
      /\bflat\s+(?:no\.?|number)?\s*\d+/gi,
      /\bhouse\s+(?:no\.?|number)?\s*\d+/gi,
      /\bbuilding\s+[a-zA-Z0-9]+/gi,
      /\bfloor\s+\d+/gi,
      /\broom\s+(?:no\.?|number)?\s*\d+/gi,
    ]

    for (const pattern of addressPatterns) {
      const matches = message.match(pattern)
      if (matches) {
        if (!detectedTypes.includes('street_address')) {
          detectedTypes.push('street_address')
        }
        matches.forEach(match => {
          flaggedContent.push({
            type: 'street_address',
            text: match,
            startIndex: message.toLowerCase().indexOf(match.toLowerCase()),
            endIndex: message.toLowerCase().indexOf(match.toLowerCase()) + match.length,
            confidence: 0.9
          })
        })
      }
    }

    // ============ GENERAL SUSPICIOUS PATTERNS ============
    const suspiciousKeywords = [
      { pattern: /\bmy\s+number\s+is\b/gi, type: 'phone_number' as PersonalInfoType },
      { pattern: /\bcall\s+me\s+(?:at|on)\b/gi, type: 'phone_number' as PersonalInfoType },
      { pattern: /\btext\s+me\s+(?:at|on)?\b/gi, type: 'phone_number' as PersonalInfoType },
      { pattern: /\breach\s+me\s+(?:at|on)\b/gi, type: 'other_identifier' as PersonalInfoType },
      { pattern: /\bfind\s+me\s+(?:at|on)\b/gi, type: 'social_media' as PersonalInfoType },
      { pattern: /\bcontact\s+me\s+(?:at|on|via)\b/gi, type: 'other_identifier' as PersonalInfoType },
      { pattern: /\bmy\s+(?:real|actual|full)\s+name\b/gi, type: 'full_name' as PersonalInfoType },
      { pattern: /\bfull\s+name\s+is\b/gi, type: 'full_name' as PersonalInfoType },
      { pattern: /\b(?:nick)?name(?:'s|s)?\s+[a-zA-Z]+\b/gi, type: 'nickname' as PersonalInfoType },
      { pattern: /\bpeople\s+call\s+me\b/gi, type: 'nickname' as PersonalInfoType },
      { pattern: /\beveryone\s+calls\s+me\b/gi, type: 'nickname' as PersonalInfoType },
      { pattern: /\bfriends\s+call\s+me\b/gi, type: 'nickname' as PersonalInfoType },
    ]

    for (const { pattern, type } of suspiciousKeywords) {
      const matches = message.match(pattern)
      if (matches) {
        if (!detectedTypes.includes(type)) {
          detectedTypes.push(type)
        }
        matches.forEach(match => {
          // Get more context after the match
          const idx = message.toLowerCase().indexOf(match.toLowerCase())
          const endIdx = Math.min(idx + match.length + 30, message.length)
          const flaggedText = message.substring(idx, endIdx)
          
          flaggedContent.push({
            type,
            text: flaggedText,
            startIndex: idx,
            endIndex: endIdx,
            confidence: 0.8
          })
        })
      }
    }

    // ============ WEBSITE/URL DETECTION ============
    const urlPatterns = [
      /https?:\/\/[^\s]+/gi,
      /www\.[^\s]+/gi,
      /[a-zA-Z0-9-]+\.(?:com|org|net|io|co|me|app|dev|xyz|site|online|website)\b/gi
    ]

    for (const pattern of urlPatterns) {
      const matches = message.match(pattern)
      if (matches) {
        if (!detectedTypes.includes('personal_website')) {
          detectedTypes.push('personal_website')
        }
        matches.forEach(match => {
          flaggedContent.push({
            type: 'personal_website',
            text: match,
            startIndex: message.indexOf(match),
            endIndex: message.indexOf(match) + match.length,
            confidence: 0.85
          })
        })
      }
    }

    const containsPersonalInfo = detectedTypes.length > 0
    const maxConfidence = flaggedContent.length > 0 
      ? Math.max(...flaggedContent.map(f => f.confidence))
      : 0

    return {
      containsPersonalInfo,
      confidence: containsPersonalInfo ? maxConfidence : 1.0,
      detectedTypes,
      flaggedContent
    }
  }

  /**
   * Quick check - returns true if message likely contains personal info
   */
  static quickCheck(message: string): boolean {
    const lowerMessage = message.toLowerCase()
    
    // Quick patterns that almost certainly indicate personal info
    const quickPatterns = [
      // Social media
      /@[a-zA-Z0-9_]{3,}/,
      /instagram|snapchat|whatsapp|facebook|twitter|tiktok|linkedin|discord|telegram/i,
      /\bmy\s+(?:insta|snap|ig|fb)\b/i,
      /add\s+me\s+on/i,
      /find\s+me\s+on/i,
      /dm\s+me/i,
      /follow\s+me/i,
      
      // Phone numbers (digits)
      /\d{10,}/,
      /\d{3}[\s\-\.]\d{3}[\s\-\.]\d{4}/,
      /\+\d{1,3}\s?\d/,
      
      // Phone numbers (words) - at least 7 number words
      /\b(?:zero|one|two|three|four|five|six|seven|eight|nine|oh)\s+(?:zero|one|two|three|four|five|six|seven|eight|nine|oh)\s+(?:zero|one|two|three|four|five|six|seven|eight|nine|oh)/i,
      
      // Email
      /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/i,
      
      // Names
      /\b(?:i am|i'm|my name is|call me|people call me)\s+[a-zA-Z]+/i,
      
      // Work
      /\bi\s+work\s+(?:at|for)\s+[a-zA-Z]/i,
      /\bmy\s+(?:company|office)\b/i,
      
      // Address
      /\bmy\s+address\b/i,
      /\bi\s+live\s+(?:at|on)\s+\d/i,
      /\d+\s+\w+\s+(?:street|st|avenue|ave|road|rd|drive|dr)\b/i,
      
      // School
      /\bi\s+(?:go|went|study)\s+(?:to|at)\s+[a-zA-Z]+\s+(?:university|college)/i,
      
      // Contact requests
      /\bmy\s+number\b/i,
      /\bcall\s+me\b/i,
      /\btext\s+me\b/i,
      /\breach\s+me\b/i,
      /\bcontact\s+me\b/i,
    ]

    for (const pattern of quickPatterns) {
      if (pattern.test(message)) {
        return true
      }
    }

    // Check for common names in context
    for (const name of COMMON_FIRST_NAMES) {
      if (lowerMessage.includes(`i am ${name}`) || 
          lowerMessage.includes(`i'm ${name}`) ||
          lowerMessage.includes(`call me ${name}`) ||
          lowerMessage.includes(`name is ${name}`)) {
        return true
      }
    }

    return false
  }

  /**
   * Sanitize message by removing personal info
   */
  static sanitizeMessage(message: string, analysis: PersonalInfoAnalysis): string {
    if (!analysis.containsPersonalInfo || analysis.flaggedContent.length === 0) {
      return message
    }

    let sanitized = message
    const sortedFlags = [...analysis.flaggedContent].sort((a, b) => b.startIndex - a.startIndex)
    
    for (const flag of sortedFlags) {
      if (flag.startIndex >= 0 && flag.endIndex > flag.startIndex) {
        const replacement = '[Hidden for privacy]'
        sanitized = sanitized.substring(0, flag.startIndex) + replacement + sanitized.substring(flag.endIndex)
      }
    }

    return sanitized
  }

  /**
   * Check if reveal should be offered based on message count
   * Dynamic threshold: check at 30, then every 5 messages
   */
  static shouldOfferReveal(messageCount: number, revealThreshold: number = 30): {
    shouldOffer: boolean
    nextCheck: number
    reason: string
  } {
    if (messageCount < revealThreshold) {
      return {
        shouldOffer: false,
        nextCheck: revealThreshold,
        reason: `Need ${revealThreshold - messageCount} more messages before reveal option`
      }
    }

    // After threshold, check every 5 messages
    const messagesSinceThreshold = messageCount - revealThreshold
    const checkInterval = 5
    const isCheckPoint = messagesSinceThreshold % checkInterval === 0

    if (isCheckPoint) {
      return {
        shouldOffer: true,
        nextCheck: messageCount + checkInterval,
        reason: `Checkpoint reached at ${messageCount} messages - reveal option available`
      }
    }

    const nextCheckpoint = revealThreshold + (Math.floor(messagesSinceThreshold / checkInterval) + 1) * checkInterval
    return {
      shouldOffer: false,
      nextCheck: nextCheckpoint,
      reason: `Next reveal check at ${nextCheckpoint} messages`
    }
  }

  /**
   * Run comprehensive tests
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
      { message: "Hey I am adarsh how are you?", shouldBlock: true },
      { message: "My instagram is @johndoe123", shouldBlock: true },
      { message: "Text me at 555-123-4567", shouldBlock: true },
      { message: "My email is john@example.com", shouldBlock: true },
      { message: "Add me on snapchat: cooluser99", shouldBlock: true },
      { message: "Find me on Facebook, my name is John Smith", shouldBlock: true },
      { message: "My whatsapp number is +1234567890", shouldBlock: true },
      { message: "DM me on twitter @myhandle", shouldBlock: true },
      { message: "I work at Google headquarters in Mountain View", shouldBlock: true },
      { message: "My address is 123 Main Street", shouldBlock: true },
      { message: "nine nine two four six eight seven seven", shouldBlock: true },
      { message: "yes people call me nick", shouldBlock: true },
      { message: "I'm Rahul, nice to meet you", shouldBlock: true },
      { message: "Call me Priya", shouldBlock: true },
      { message: "I go to Stanford University", shouldBlock: true },
      { message: "I work for Microsoft", shouldBlock: true },
      { message: "My number is one two three four five six seven eight nine zero", shouldBlock: true },
      { message: "Friends call me Mike", shouldBlock: true },
      { message: "I live at apartment 5B, Oak Street", shouldBlock: true },
      { message: "Find me on Discord: user#1234", shouldBlock: true },
      
      // Should be ALLOWED (no personal info)
      { message: "Hi! How are you doing today?", shouldBlock: false },
      { message: "I love hiking and photography", shouldBlock: false },
      { message: "What kind of music do you like?", shouldBlock: false },
      { message: "I'm 25 years old and work in tech", shouldBlock: false },
      { message: "I live in a big city", shouldBlock: false },
      { message: "What are your hobbies?", shouldBlock: false },
      { message: "I enjoy cooking Italian food", shouldBlock: false },
      { message: "Do you like traveling?", shouldBlock: false },
      { message: "I have two dogs", shouldBlock: false },
      { message: "What do you do for fun?", shouldBlock: false },
      { message: "I'm an engineer", shouldBlock: false },
      { message: "Nice weather today!", shouldBlock: false },
      { message: "What's your favorite movie?", shouldBlock: false },
      { message: "I like reading books", shouldBlock: false },
      { message: "How was your day?", shouldBlock: false },
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
        logger.warn({
          message: testCase.message,
          expected: testCase.shouldBlock,
          actual: actualBlocked,
          detectedTypes: analysis.detectedTypes
        }, 'Content filter test case failed')
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
        'Aggressive personal information detection',
        'Name detection (first names, nicknames)',
        'Phone number recognition (digits and words)',
        'Social media handle detection (all platforms)',
        'Email and website detection',
        'Workplace/company detection',
        'School/university detection',
        'Address and location detection',
        'AI-powered edge case analysis',
        'Pattern-based fast fallback',
        'Dynamic reveal threshold checking'
      ]
    }
  }
}

export default ContentFilterService
