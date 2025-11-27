import { logger } from '../../config/logger.js'

/**
 * Together AI Content Filter Service for Personal Information Detection
 * Smart filtering for blind dating - blocks ONLY identifying info
 * 
 * IMPORTANT: This is a DATING APP - the following are ALWAYS ALLOWED:
 * - Flirting, romantic messages, compliments
 * - Adult conversations, sexting, explicit content
 * - Profanity, swear words, crude language
 * - Any sexual or intimate discussions
 * 
 * We ONLY block personal IDENTIFYING information (names, phone numbers, addresses, etc.)
 * The CONTENT of the conversation is NOT moderated - only identity protection matters.
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

// Common first names database
const COMMON_FIRST_NAMES = new Set([
  // Male names
  'james', 'john', 'robert', 'michael', 'david', 'william', 'richard', 'joseph', 'thomas', 'charles',
  'daniel', 'matthew', 'anthony', 'mark', 'donald', 'steven', 'paul', 'andrew', 'joshua', 'kenneth',
  'kevin', 'brian', 'george', 'timothy', 'ronald', 'edward', 'jason', 'jeffrey', 'ryan', 'jacob',
  'gary', 'nicholas', 'eric', 'jonathan', 'stephen', 'larry', 'justin', 'scott', 'brandon', 'benjamin',
  'samuel', 'raymond', 'gregory', 'frank', 'alexander', 'patrick', 'jack', 'dennis', 'jerry', 'tyler',
  'aaron', 'jose', 'adam', 'nathan', 'henry', 'zachary', 'douglas', 'peter', 'kyle', 'noah',
  // Female names
  'mary', 'patricia', 'jennifer', 'linda', 'barbara', 'elizabeth', 'susan', 'jessica', 'sarah', 'karen',
  'lisa', 'nancy', 'betty', 'margaret', 'sandra', 'ashley', 'kimberly', 'emily', 'donna', 'michelle',
  'dorothy', 'carol', 'amanda', 'melissa', 'deborah', 'stephanie', 'rebecca', 'sharon', 'laura', 'cynthia',
  'kathleen', 'amy', 'angela', 'shirley', 'anna', 'brenda', 'pamela', 'emma', 'nicole', 'helen',
  'samantha', 'katherine', 'christine', 'debra', 'rachel', 'carolyn', 'janet', 'catherine', 'maria', 'heather',
  // Indian names
  'adarsh', 'rahul', 'priya', 'amit', 'pooja', 'raj', 'neha', 'vikram', 'anita', 'sanjay',
  'deepika', 'arjun', 'sneha', 'karan', 'kavita', 'rohit', 'anjali', 'vijay', 'divya', 'ravi',
  'sunita', 'manish', 'rekha', 'suresh', 'meera', 'ashok', 'lakshmi', 'anil', 'geeta', 'mukesh',
  'aarav', 'aanya', 'vivaan', 'aditi', 'vihaan', 'ananya', 'ishaan', 'aisha', 'aryan', 'kiara',
  // Common nicknames
  'nick', 'mike', 'sam', 'alex', 'chris', 'pat', 'kim', 'lee', 'jamie', 'taylor',
  'tony', 'joe', 'bob', 'bill', 'jim', 'tom', 'dan', 'dave', 'steve', 'matt',
  'jake', 'ben', 'max', 'luke', 'kate', 'jen', 'meg', 'beth', 'sue', 'amy'
])

// Number words mapping (English + Hindi)
const NUMBER_WORDS: Record<string, string> = {
  // English
  'zero': '0', 'one': '1', 'two': '2', 'three': '3', 'four': '4',
  'five': '5', 'six': '6', 'seven': '7', 'eight': '8', 'nine': '9',
  'oh': '0', 'o': '0',
  // Hindi numbers (romanized)
  'shunya': '0', 'ek': '1', 'do': '2', 'teen': '3', 'char': '4',
  'paanch': '5', 'panch': '5', 'chhah': '6', 'chhe': '6', 'che': '6',
  'saat': '7', 'sat': '7', 'aath': '8', 'aat': '8', 'nau': '9', 'no': '9',
  // Variations
  'das': '10', 'gyarah': '11', 'barah': '12',
  // Common Hindi number variations
  'aek': '1', 'doo': '2', 'theen': '3', 'chaar': '4', 'paach': '5',
  'cheh': '6', 'saath': '7', 'aatth': '8', 'nao': '9'
}

// Hindi/Hinglish patterns for sharing personal info
const HINDI_NAME_PATTERNS = [
  /\b(?:mera|meri)\s+(?:naam|name)\s+(?:hai|h|he)?\s*([a-zA-Z]+)/gi,
  /\bmujhe\s+(?:log|sab|sabhi)?\s*(?:bulaate|bolte|kehte)\s+(?:hain|hai|h)?\s*([a-zA-Z]+)/gi,
  /\bmai\s+(?:hu|hoon|hun)\s+([a-zA-Z]{2,15})\b/gi,
  /\bmain\s+(?:hu|hoon|hun)\s+([a-zA-Z]{2,15})\b/gi,
  /\bmai\s+([a-zA-Z]{2,15})\s+(?:hu|hoon|hun)\b/gi,
  /\byeh\s+([a-zA-Z]{2,15})\s+(?:hai|h|bol\s*raha|bol\s*rahi)/gi,
]

const HINDI_PHONE_PATTERNS = [
  /\b(?:mera|meri)\s+(?:number|no|phone|mobile|cell)\s+(?:hai|h|he)?\s*:?\s*[\d\s\-]+/gi,
  /\b(?:call|msg|message|whatsapp|text)\s+(?:karo|kar|karna|kariye)\s*:?\s*[\d\s\-]+/gi,
  /\bmujhe\s+(?:call|msg|message|text)\s+(?:karo|kar|karna)\s+(?:is|yeh|ye)\s+(?:number|no)\s+(?:pe|par|pr)\s*:?\s*[\d\s\-]+/gi,
  /\b(?:is|yeh|ye)\s+(?:number|no)\s+(?:pe|par|pr)\s+(?:call|msg|message|text)\s+(?:karo|kar|karna)/gi,
]

const HINDI_SOCIAL_PATTERNS = [
  /\b(?:mera|meri)\s+(?:insta|instagram|snap|snapchat|fb|facebook)\s+(?:hai|h|he)?\s*:?\s*@?[a-zA-Z0-9_\.]+/gi,
  /\b(?:insta|instagram|snap|snapchat|fb|facebook)\s+(?:pe|par|pr)\s+(?:add|follow)\s+(?:karo|kar|karna|karlo)/gi,
  /\b(?:add|follow)\s+(?:karo|kar|karna|karlo)\s+(?:insta|instagram|snap|snapchat|fb|facebook)\s+(?:pe|par|pr)/gi,
  /\bmujhe\s+(?:insta|instagram|snap|snapchat|fb|facebook)\s+(?:pe|par|pr)\s+(?:add|follow|dhundho|dhundo|find)\s+(?:karo|kar|karna)/gi,
]

const HINDI_LOCATION_PATTERNS = [
  /\bmai\s+(?:rehta|rehti|rahta|rahti)\s+(?:hu|hoon|hun)\s+[\d]+\s+[a-zA-Z]+\s+(?:street|road|gali|mohalla|lane)/gi,
  /\b(?:mera|meri)\s+(?:ghar|home|address|pata)\s+(?:hai|h|he)?\s*:?\s*[\d]+/gi,
  /\b(?:mera|meri)\s+(?:flat|apartment|apt)\s+(?:number|no|no\.?)\s*:?\s*[\d]+/gi,
]

const HINDI_WORK_PATTERNS = [
  /\bmai\s+(?:kaam|job|naukri)\s+(?:karta|karti)\s+(?:hu|hoon|hun)\s+(?:google|apple|microsoft|amazon|meta|facebook|tcs|infosys|wipro|reliance|tata)/gi,
  /\b(?:mera|meri)\s+(?:company|office)\s+(?:hai|h|he)?\s*(?:google|apple|microsoft|amazon|meta|facebook|tcs|infosys|wipro|reliance|tata)/gi,
  /\bmai\s+(?:google|apple|microsoft|amazon|meta|facebook|tcs|infosys|wipro|reliance|tata)\s+(?:mein|me|mai)\s+(?:kaam|job|naukri)\s+(?:karta|karti)/gi,
]

// Major companies that should be blocked when mentioned with work context
const MAJOR_COMPANIES = [
  'google', 'apple', 'microsoft', 'amazon', 'meta', 'facebook', 'netflix', 'tesla', 'uber', 'lyft',
  'airbnb', 'twitter', 'snapchat', 'tiktok', 'linkedin', 'spotify', 'adobe', 'oracle',
  'salesforce', 'ibm', 'intel', 'nvidia', 'amd', 'cisco', 'samsung', 'sony',
  'walmart', 'target', 'costco', 'starbucks', 'mcdonalds', 'nike', 'adidas', 'disney',
  'jpmorgan', 'goldman sachs', 'morgan stanley', 'deloitte', 'pwc', 'kpmg', 'accenture',
  'mckinsey', 'infosys', 'tcs', 'wipro', 'cognizant',
  'flipkart', 'swiggy', 'zomato', 'ola', 'paytm', 'razorpay',
  'reliance', 'tata', 'hdfc', 'icici', 'airtel', 'jio'
]

// Universities
const UNIVERSITIES = [
  'harvard', 'stanford', 'mit', 'yale', 'princeton', 'columbia', 'berkeley', 'ucla', 'nyu',
  'oxford', 'cambridge', 'iit', 'iim', 'bits', 'nit', 'vit', 'manipal'
]

// SAFE PHRASES - Generic descriptions that should NEVER be blocked (English + Hindi/Hinglish)
const SAFE_PHRASES = [
  // Generic location descriptions (English)
  'big city', 'small town', 'small city', 'large city', 'metropolitan area', 'suburb', 'suburbs',
  'downtown', 'city center', 'urban area', 'rural area', 'near the beach', 'near the mountains',
  'in the city', 'in a city', 'in town', 'in a town', 'in the suburbs',
  
  // Generic location descriptions (Hindi/Hinglish)
  'bade sheher', 'bade city', 'chhote sheher', 'chhote gaon', 'metro city',
  
  // Generic job descriptions (English)
  'an engineer', 'a doctor', 'a teacher', 'a nurse', 'a developer', 'a designer', 'a manager',
  'a lawyer', 'a student', 'a consultant', 'a writer', 'a chef', 'an artist', 'a musician',
  'in tech', 'in finance', 'in healthcare', 'in education', 'in marketing', 'in sales',
  'work in tech', 'work in finance', 'work in healthcare', 'work in education',
  'software engineer', 'data scientist', 'product manager', 'project manager',
  'work from home', 'remote work', 'office job', 'freelance', 'self-employed',
  
  // Generic job descriptions (Hindi/Hinglish)
  'ek engineer', 'ek doctor', 'ek teacher', 'mai engineer', 'mai doctor',
  'tech mein kaam', 'office mein kaam', 'ghar se kaam', 'work from home karta',
  'software engineer hu', 'developer hu', 'job karta', 'naukri karta',
  
  // Generic descriptors (English)
  'i\'m an', 'i am an', 'i\'m a', 'i am a', 'i work as', 'i work in',
  'my job is', 'my work is', 'my profession', 'my career',
  
  // Generic descriptors (Hindi/Hinglish)
  'mai ek', 'main ek', 'mai hu ek', 'kaam karta hu', 'kaam karti hu',
  'mera kaam', 'meri job', 'meri naukri',
  
  // Safe Hindi greetings and phrases
  'kaise ho', 'kaisi ho', 'kya haal', 'theek hu', 'badhiya hu', 'mast hu',
  'kya kar rahe', 'kya kar rahi', 'aaj mausam', 'bahut acha', 'bahut sundar',
]

// Words that indicate GENERIC job titles (not specific companies)
const GENERIC_JOB_INDICATORS = [
  'engineer', 'developer', 'designer', 'manager', 'analyst', 'consultant', 'specialist',
  'coordinator', 'assistant', 'director', 'executive', 'officer', 'lead', 'senior', 'junior',
  'intern', 'trainee', 'associate', 'professional', 'expert', 'technician', 'administrator',
  'doctor', 'nurse', 'teacher', 'professor', 'lawyer', 'accountant', 'architect', 'scientist',
  'researcher', 'writer', 'editor', 'journalist', 'photographer', 'artist', 'musician',
  'chef', 'driver', 'pilot', 'agent', 'broker', 'therapist', 'counselor', 'coach'
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
   * Check if message contains only safe/generic content
   */
  private static isSafeGenericMessage(message: string): boolean {
    const lowerMessage = message.toLowerCase()
    
    // Check if message contains safe phrases
    for (const phrase of SAFE_PHRASES) {
      if (lowerMessage.includes(phrase)) {
        // Make sure it's not followed by specific identifying info
        const phraseIndex = lowerMessage.indexOf(phrase)
        const afterPhrase = lowerMessage.substring(phraseIndex + phrase.length, phraseIndex + phrase.length + 50)
        
        // Check if what follows contains specific identifiers
        const hasSpecificInfo = /@|\.com|\.org|\d{5,}|street|avenue|road/i.test(afterPhrase)
        
        if (!hasSpecificInfo) {
          return true
        }
      }
    }

    // Check for generic job descriptions
    for (const job of GENERIC_JOB_INDICATORS) {
      const jobPattern = new RegExp(`\\b(i'm|i am|work as|working as)\\s+(a|an)?\\s*${job}\\b`, 'i')
      if (jobPattern.test(lowerMessage)) {
        // Make sure no specific company is mentioned
        const hasCompany = MAJOR_COMPANIES.some(c => lowerMessage.includes(c))
        if (!hasCompany) {
          return true
        }
      }
    }

    // Generic "I live in" patterns without specific addresses
    if (/\bi\s+live\s+in\s+(a|the)?\s*(big|small|large|medium|coastal|mountain|busy|quiet)\s*(city|town|area)/i.test(lowerMessage)) {
      return true
    }

    return false
  }

  /**
   * Analyze a message for personal information
   * Smart detection - blocks specific info, allows generic descriptions
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

      // First check: Is this a safe generic message?
      if (this.isSafeGenericMessage(message)) {
        return {
          containsPersonalInfo: false,
          confidence: 0.95,
          detectedTypes: [],
          flaggedContent: [],
          rawAnalysis: 'Safe generic message - no specific personal info'
        }
      }

      // Second check: Quick pattern detection for obvious personal info
      const patternResult = this.smartPatternDetection(message)
      
      // If pattern detection found something with HIGH confidence, block
      if (patternResult.containsPersonalInfo && patternResult.confidence >= 0.85) {
        return patternResult
      }

      // Third check: Use AI for edge cases
      // Only call AI if quickCheck suggests potential issues but pattern detection is unsure
      if (this.quickCheck(message) && (!patternResult.containsPersonalInfo || patternResult.confidence < 0.85)) {
        try {
          const aiResult = await this.analyzeWithAI(message, context)
          
          // Merge results - AI has final say on edge cases
          if (aiResult.containsPersonalInfo) {
            return aiResult
          }
        } catch (error) {
          logger.warn({ error }, 'AI analysis failed, using pattern detection only')
        }
      }

      // Return pattern detection result
      return patternResult
    } catch (error) {
      logger.error({ error, message: message.substring(0, 50) }, 'Failed to analyze message')
      return this.smartPatternDetection(message)
    }
  }

  /**
   * Call Together AI for nuanced analysis
   */
  private static async analyzeWithAI(message: string, context?: {
    senderGender?: string
    receiverGender?: string
    messageCount?: number
  }): Promise<PersonalInfoAnalysis> {
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
          { role: 'user', content: this.buildAnalysisPrompt(message, context) }
        ],
        max_tokens: this.MAX_TOKENS,
        temperature: this.TEMPERATURE,
        stream: false
      })
    })

    if (!response.ok) {
      throw new Error(`AI API error: ${response.status}`)
    }

    const data = await response.json()
    const aiResponse = data.choices?.[0]?.message?.content || ''
    
    return this.parseAnalysisResponse(aiResponse, message)
  }

  /**
   * System prompt - ONLY blocks identifying info, allows ALL conversation content
   * Supports English AND Hindi/Hinglish
   */
  private static getSystemPrompt(): string {
    return `You are a content moderator for an anonymous blind DATING app. Your ONLY job is to detect SPECIFIC personal identifying information in ENGLISH and HINDI/HINGLISH.

CRITICAL: This is an ADULT DATING APP. You must NEVER block or flag:
- Flirting, romantic messages, love talk (English or Hindi)
- Sexual content, sexting, explicit messages
- Profanity, swear words, crude language (any language)
- Adult conversations of any kind
- Compliments about appearance or body

You ONLY care about IDENTITY PROTECTION - not content moderation!

BLOCK these in ENGLISH:
- Names: "My name is John", "Call me Sarah", "I'm Mike"
- Phone numbers: "555-123-4567", "nine one two three..."
- Social media: @handles, "my instagram is", "add me on snapchat"
- Email, addresses, specific companies/schools

BLOCK these in HINDI/HINGLISH:
- Names: "Mera naam Rahul hai", "Mai Priya hu", "Mujhe log Raju bulaate hain"
- Phone numbers: "Mera number 9876543210", "ek do teen char paanch chhah saat aath nau"
- Social media: "Mera insta @xyz", "Insta pe add karo", "Snap pe follow karo"
- Work: "Mai Google mein kaam karta hu", "Meri company TCS hai"
- Address: "Mera flat 302", "Mai rehta hu MG Road pe"

ALWAYS ALLOW (any language):
- Generic job: "Mai engineer hu", "I work in tech", "Tech mein kaam karta hu"
- Generic location: "Bade sheher mein rehta hu", "I live in a big city"
- Flirting: "Tum bahut sundar ho", "You're beautiful", any romantic content
- Adult content: ANY explicit or sexual content in any language
- Greetings: "Kaise ho?", "Kya haal?", "How are you?"

Respond with ONLY valid JSON:
{
  "containsPersonalInfo": true/false,
  "confidence": 0.0-1.0,
  "detectedTypes": ["type1"],
  "flaggedContent": [{"type": "type", "text": "flagged text", "confidence": 0.9}],
  "explanation": "brief reason"
}

Remember: Adult content allowed in ALL languages. ONLY block identity info.`
  }

  /**
   * Build analysis prompt
   */
  private static buildAnalysisPrompt(message: string, context?: {
    senderGender?: string
    receiverGender?: string
    messageCount?: number
  }): string {
    return `Analyze this dating app message for IDENTITY-REVEALING info only:

MESSAGE: "${message}"

IGNORE: Adult content, flirting, profanity, sexual content - these are ALL ALLOWED.

ONLY check for identity-revealing info:
- Names shared: "I'm John", "Call me Sarah" = BLOCK
- Phone numbers, emails = BLOCK  
- Social media handles = BLOCK
- Specific addresses/workplaces = BLOCK

Generic info is ALLOWED: "I'm an engineer", "I live in a big city", any adult content.

Does this message reveal the person's real-world identity?`
  }

  /**
   * Parse AI response
   */
  private static parseAnalysisResponse(response: string, originalMessage: string): PersonalInfoAnalysis {
    try {
      const jsonMatch = response.match(/\{[\s\S]*\}/)
      if (!jsonMatch) {
        return this.smartPatternDetection(originalMessage)
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
      return this.smartPatternDetection(originalMessage)
    }
  }

  /**
   * Smart pattern-based detection - distinguishes specific vs generic info
   */
  private static smartPatternDetection(message: string): PersonalInfoAnalysis {
    const detectedTypes: PersonalInfoType[] = []
    const flaggedContent: FlaggedContent[] = []
    const lowerMessage = message.toLowerCase()

    // Skip if message is clearly safe/generic
    if (this.isSafeGenericMessage(message)) {
      return {
        containsPersonalInfo: false,
        confidence: 0.95,
        detectedTypes: [],
        flaggedContent: []
      }
    }

    // ============ NAME DETECTION (Specific patterns only) ============
    // Only flag when someone is explicitly sharing their name
    const namePatterns = [
      /\b(?:my name is|i'm called|i am called|call me|people call me|everyone calls me|friends call me|they call me)\s+([a-zA-Z]{2,15})\b/gi,
      /\bhey,?\s+(?:i am|i'm)\s+([a-zA-Z]{2,15})(?:\s|,|!|\.|\?|$)/gi,
      /\b(?:this is)\s+([a-zA-Z]{2,15})(?:\s+here|\s+speaking)?/gi,
    ]
    
    for (const pattern of namePatterns) {
      let match
      while ((match = pattern.exec(message)) !== null) {
        const potentialName = match[1]?.toLowerCase()
        if (potentialName && COMMON_FIRST_NAMES.has(potentialName)) {
          if (!detectedTypes.includes('first_name')) {
            detectedTypes.push('first_name')
          }
          flaggedContent.push({
            type: 'first_name',
            text: match[0],
            startIndex: match.index,
            endIndex: match.index + match[0].length,
            confidence: 0.95
          })
        }
      }
    }

    // "I am/I'm [Name]" pattern - but be careful with generic phrases
    const iAmPattern = /\b(?:i am|i'm|im)\s+([a-zA-Z]{2,15})(?:\s|,|!|\.|\?|$)/gi
    let match
    while ((match = iAmPattern.exec(message)) !== null) {
      const word = match[1]?.toLowerCase()
      // Skip if it's a job title or adjective
      const isJobOrAdjective = GENERIC_JOB_INDICATORS.some(j => word === j || word === `an ${j}` || word === `a ${j}`) ||
        ['good', 'fine', 'great', 'okay', 'ok', 'well', 'happy', 'sad', 'tired', 'busy', 'free', 'here', 'back', 'home', 'sorry', 'sure', 'ready', 'excited', 'nervous', 'curious', 'interested'].includes(word)
      
      if (!isJobOrAdjective && COMMON_FIRST_NAMES.has(word)) {
        if (!detectedTypes.includes('first_name')) {
          detectedTypes.push('first_name')
        }
        flaggedContent.push({
          type: 'first_name',
          text: match[0],
          startIndex: match.index,
          endIndex: match.index + match[0].length,
          confidence: 0.9
        })
      }
    }

    // ============ HINDI/HINGLISH NAME DETECTION ============
    for (const pattern of HINDI_NAME_PATTERNS) {
      let hindiMatch
      while ((hindiMatch = pattern.exec(message)) !== null) {
        const potentialName = hindiMatch[1]?.toLowerCase()
        if (potentialName && (COMMON_FIRST_NAMES.has(potentialName) || potentialName.length >= 3)) {
          if (!detectedTypes.includes('first_name')) {
            detectedTypes.push('first_name')
          }
          flaggedContent.push({
            type: 'first_name',
            text: hindiMatch[0],
            startIndex: hindiMatch.index,
            endIndex: hindiMatch.index + hindiMatch[0].length,
            confidence: 0.9
          })
        }
      }
    }

    // ============ HINDI/HINGLISH PHONE PATTERNS ============
    for (const pattern of HINDI_PHONE_PATTERNS) {
      const hindiMatches = message.match(pattern)
      if (hindiMatches) {
        if (!detectedTypes.includes('phone_number')) {
          detectedTypes.push('phone_number')
        }
        hindiMatches.forEach(m => {
          flaggedContent.push({
            type: 'phone_number',
            text: m,
            startIndex: lowerMessage.indexOf(m.toLowerCase()),
            endIndex: lowerMessage.indexOf(m.toLowerCase()) + m.length,
            confidence: 0.9
          })
        })
      }
    }

    // ============ HINDI/HINGLISH SOCIAL MEDIA PATTERNS ============
    for (const pattern of HINDI_SOCIAL_PATTERNS) {
      const hindiMatches = message.match(pattern)
      if (hindiMatches) {
        if (!detectedTypes.includes('social_media')) {
          detectedTypes.push('social_media')
        }
        hindiMatches.forEach(m => {
          flaggedContent.push({
            type: 'social_media',
            text: m,
            startIndex: lowerMessage.indexOf(m.toLowerCase()),
            endIndex: lowerMessage.indexOf(m.toLowerCase()) + m.length,
            confidence: 0.9
          })
        })
      }
    }

    // ============ HINDI/HINGLISH LOCATION PATTERNS ============
    for (const pattern of HINDI_LOCATION_PATTERNS) {
      const hindiMatches = message.match(pattern)
      if (hindiMatches) {
        if (!detectedTypes.includes('street_address')) {
          detectedTypes.push('street_address')
        }
        hindiMatches.forEach(m => {
          flaggedContent.push({
            type: 'street_address',
            text: m,
            startIndex: lowerMessage.indexOf(m.toLowerCase()),
            endIndex: lowerMessage.indexOf(m.toLowerCase()) + m.length,
            confidence: 0.9
          })
        })
      }
    }

    // ============ HINDI/HINGLISH WORK PATTERNS ============
    for (const pattern of HINDI_WORK_PATTERNS) {
      const hindiMatches = message.match(pattern)
      if (hindiMatches) {
        if (!detectedTypes.includes('company_name')) {
          detectedTypes.push('company_name')
        }
        hindiMatches.forEach(m => {
          flaggedContent.push({
            type: 'company_name',
            text: m,
            startIndex: lowerMessage.indexOf(m.toLowerCase()),
            endIndex: lowerMessage.indexOf(m.toLowerCase()) + m.length,
            confidence: 0.9
          })
        })
      }
    }

    // ============ PHONE NUMBER DETECTION ============
    const phonePatterns = [
      /\+?[\d\s\-\(\)\.]{10,}/g,
      /\d{3}[\s\-\.]?\d{3}[\s\-\.]?\d{4}/g,
      /\(\d{3}\)\s*\d{3}[\s\-]?\d{4}/g,
      /\d{10,}/g
    ]
    
    for (const pattern of phonePatterns) {
      const matches = message.match(pattern)
      if (matches) {
        for (const m of matches) {
          const digitsOnly = m.replace(/\D/g, '')
          if (digitsOnly.length >= 10) {
            if (!detectedTypes.includes('phone_number')) {
              detectedTypes.push('phone_number')
            }
            flaggedContent.push({
              type: 'phone_number',
              text: m,
              startIndex: message.indexOf(m),
              endIndex: message.indexOf(m) + m.length,
              confidence: 0.95
            })
          }
        }
      }
    }

    // Phone in words (7+ number words in sequence)
    const numberWordPattern = /\b(zero|one|two|three|four|five|six|seven|eight|nine|oh)(\s+(zero|one|two|three|four|five|six|seven|eight|nine|oh)){6,}/gi
    const wordMatches = message.match(numberWordPattern)
    if (wordMatches) {
      for (const m of wordMatches) {
        const words = m.toLowerCase().split(/\s+/)
        const digits = words.map(w => NUMBER_WORDS[w] || '').join('')
        if (digits.length >= 7) {
          if (!detectedTypes.includes('phone_words')) {
            detectedTypes.push('phone_words')
          }
          flaggedContent.push({
            type: 'phone_words',
            text: m,
            startIndex: lowerMessage.indexOf(m.toLowerCase()),
            endIndex: lowerMessage.indexOf(m.toLowerCase()) + m.length,
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
    const socialPatterns: Array<{ pattern: RegExp; type: PersonalInfoType }> = [
      { pattern: /@[a-zA-Z0-9_\.]{3,30}/g, type: 'social_media' },
      { pattern: /\b(?:my\s+)?(?:instagram|insta|ig)\s*(?:is|:)?\s*@?[a-zA-Z0-9_\.]+/gi, type: 'instagram' },
      { pattern: /\b(?:my\s+)?(?:snapchat|snap)\s*(?:is|:)?\s*@?[a-zA-Z0-9_\.]+/gi, type: 'snapchat' },
      { pattern: /\badd\s+me\s+on\s+(?:snap|snapchat|insta|instagram)/gi, type: 'social_media' },
      { pattern: /\b(?:whatsapp|whats\s*app)\s*(?:is|:)?\s*\+?[\d\s]+/gi, type: 'whatsapp' },
      { pattern: /\b(?:my\s+)?(?:facebook|fb)\s*(?:is|:)?\s*@?[a-zA-Z0-9_\.]+/gi, type: 'facebook' },
      { pattern: /facebook\.com\/[a-zA-Z0-9.]+/gi, type: 'facebook' },
      { pattern: /\b(?:my\s+)?(?:twitter)\s*(?:is|:)?\s*@?[a-zA-Z0-9_]+/gi, type: 'twitter' },
      { pattern: /\b(?:my\s+)?(?:tiktok)\s*(?:is|:)?\s*@?[a-zA-Z0-9_\.]+/gi, type: 'tiktok' },
      { pattern: /\b(?:my\s+)?(?:discord)\s*(?:is|:)?\s*[a-zA-Z0-9_#]+/gi, type: 'discord' },
      { pattern: /\b(?:my\s+)?(?:telegram|tg)\s*(?:is|:)?\s*@?[a-zA-Z0-9_]+/gi, type: 'telegram' },
      { pattern: /\b(?:dm|message|text|find|follow)\s+me\s+(?:on|at)\s+\w+/gi, type: 'social_media' },
      { pattern: /linkedin\.com\/in\/[a-zA-Z0-9-]+/gi, type: 'linkedin' },
    ]

    for (const { pattern, type } of socialPatterns) {
      const matches = message.match(pattern)
      if (matches) {
        if (!detectedTypes.includes(type)) {
          detectedTypes.push(type)
        }
        matches.forEach(m => {
          if (!flaggedContent.some(f => f.text.toLowerCase() === m.toLowerCase())) {
            flaggedContent.push({
              type,
              text: m,
              startIndex: lowerMessage.indexOf(m.toLowerCase()),
              endIndex: lowerMessage.indexOf(m.toLowerCase()) + m.length,
              confidence: 0.9
            })
          }
        })
      }
    }

    // ============ SPECIFIC WORKPLACE DETECTION ============
    // Only flag when specific company is mentioned with work context
    for (const company of MAJOR_COMPANIES) {
      const companyPattern = new RegExp(`\\b(?:i\\s+)?(?:work|job|employed|office|working)\\s+(?:at|for|in|with)\\s+${company}\\b`, 'gi')
      if (companyPattern.test(message)) {
        if (!detectedTypes.includes('company_name')) {
          detectedTypes.push('company_name')
        }
        const idx = lowerMessage.indexOf(company)
        flaggedContent.push({
          type: 'company_name',
          text: message.substring(Math.max(0, idx - 20), idx + company.length + 10),
          startIndex: Math.max(0, idx - 20),
          endIndex: idx + company.length + 10,
          confidence: 0.9
        })
      }
    }

    // ============ SPECIFIC SCHOOL DETECTION ============
    for (const uni of UNIVERSITIES) {
      const uniPattern = new RegExp(`\\b(?:i\\s+)?(?:go|went|study|studied|attend|student|graduate)\\s+(?:at|to|from)\\s+${uni}\\b`, 'gi')
      if (uniPattern.test(message)) {
        if (!detectedTypes.includes('university')) {
          detectedTypes.push('university')
        }
        const idx = lowerMessage.indexOf(uni)
        flaggedContent.push({
          type: 'university',
          text: message.substring(Math.max(0, idx - 20), idx + uni.length + 10),
          startIndex: Math.max(0, idx - 20),
          endIndex: idx + uni.length + 10,
          confidence: 0.9
        })
      }
    }

    // ============ SPECIFIC ADDRESS DETECTION ============
    const addressPatterns = [
      /\b\d+\s+[a-zA-Z]+\s+(?:street|st|avenue|ave|road|rd|drive|dr|lane|ln|boulevard|blvd|way|court|ct|circle|cir|place|pl)\b/gi,
      /\bapartment\s*#?\s*\d+[a-zA-Z]?\b/gi,
      /\bapt\.?\s*#?\s*\d+[a-zA-Z]?\b/gi,
      /\bflat\s+(?:no\.?|number)?\s*\d+[a-zA-Z]?\b/gi,
      /\bunit\s*#?\s*\d+[a-zA-Z]?\b/gi,
      /\bi\s+live\s+(?:at|on)\s+\d+\s+[a-zA-Z]/gi,
      /\bmy\s+address\s+is\b/gi,
    ]

    for (const pattern of addressPatterns) {
      const matches = message.match(pattern)
      if (matches) {
        if (!detectedTypes.includes('street_address')) {
          detectedTypes.push('street_address')
        }
        matches.forEach(m => {
          flaggedContent.push({
            type: 'street_address',
            text: m,
            startIndex: lowerMessage.indexOf(m.toLowerCase()),
            endIndex: lowerMessage.indexOf(m.toLowerCase()) + m.length,
            confidence: 0.9
          })
        })
      }
    }

    // ============ URL/WEBSITE DETECTION ============
    const urlPatterns = [
      /https?:\/\/[^\s]+/gi,
      /www\.[^\s]+/gi,
      /[a-zA-Z0-9-]+\.(?:com|org|net|io|co|me|app|dev)\b/gi
    ]

    for (const pattern of urlPatterns) {
      const matches = message.match(pattern)
      if (matches) {
        if (!detectedTypes.includes('personal_website')) {
          detectedTypes.push('personal_website')
        }
        matches.forEach(m => {
          flaggedContent.push({
            type: 'personal_website',
            text: m,
            startIndex: message.indexOf(m),
            endIndex: message.indexOf(m) + m.length,
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
   * Quick check - for fast screening (includes Hindi/Hinglish patterns)
   */
  static quickCheck(message: string): boolean {
    const lowerMessage = message.toLowerCase()
    
    // First check if it's a safe generic message
    if (this.isSafeGenericMessage(message)) {
      return false
    }
    
    // Quick patterns for obvious personal info (English + Hindi/Hinglish)
    const quickPatterns = [
      /@[a-zA-Z0-9_]{3,}/,
      /\d{10,}/,
      /\d{3}[\s\-]\d{3}[\s\-]\d{4}/,
      /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/i,
      // English name patterns
      /\b(?:my name is|call me|i'm called)\s+[a-zA-Z]/i,
      // Hindi/Hinglish name patterns
      /\b(?:mera|meri)\s+(?:naam|name)\s+(?:hai|h|he)?/i,
      /\bmujhe\s+(?:log|sab)?\s*(?:bulaate|bolte|kehte)/i,
      /\bmai\s+(?:hu|hoon|hun)\s+[a-zA-Z]/i,
      /\bmain\s+(?:hu|hoon|hun)\s+[a-zA-Z]/i,
      // Social media (English)
      /\b(?:my|add me on)\s+(?:instagram|insta|ig|snap|snapchat|facebook|fb|twitter|tiktok|whatsapp|discord|telegram)\b/i,
      // Social media (Hindi/Hinglish)
      /\b(?:mera|meri)\s+(?:insta|instagram|snap|snapchat|fb|facebook)/i,
      /\b(?:insta|snap|fb)\s+(?:pe|par|pr)\s+(?:add|follow)\s+(?:karo|kar)/i,
      // Phone (English)
      /\bmy\s+(?:number|phone|cell|mobile)\s+is\b/i,
      // Phone (Hindi/Hinglish)
      /\b(?:mera|meri)\s+(?:number|no|phone|mobile)\s+(?:hai|h|he)?/i,
      /\b(?:call|msg|text)\s+(?:karo|kar|karna)\b/i,
      /\b\d+\s+\w+\s+(?:street|st|avenue|ave|road|rd|drive|dr)\b/i,
    ]

    for (const pattern of quickPatterns) {
      if (pattern.test(message)) {
        return true
      }
    }

    return false
  }

  /**
   * Sanitize message
   */
  static sanitizeMessage(message: string, analysis: PersonalInfoAnalysis): string {
    if (!analysis.containsPersonalInfo || analysis.flaggedContent.length === 0) {
      return message
    }

    let sanitized = message
    const sortedFlags = [...analysis.flaggedContent].sort((a, b) => b.startIndex - a.startIndex)
    
    for (const flag of sortedFlags) {
      if (flag.startIndex >= 0 && flag.endIndex > flag.startIndex) {
        sanitized = sanitized.substring(0, flag.startIndex) + '[Hidden]' + sanitized.substring(flag.endIndex)
      }
    }

    return sanitized
  }

  /**
   * Run comprehensive tests - 40 test cases
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
      // ============ SHOULD BE BLOCKED ============
      { message: "Hey I am Adarsh, how are you?", shouldBlock: true },
      { message: "My name is John Smith", shouldBlock: true },
      { message: "Call me Sarah", shouldBlock: true },
      { message: "People call me Nick", shouldBlock: true },
      { message: "Friends call me Mike", shouldBlock: true },
      { message: "I'm Rahul, nice to meet you", shouldBlock: true },
      { message: "This is Priya here", shouldBlock: true },
      { message: "My instagram is @johndoe123", shouldBlock: true },
      { message: "Add me on snap: cooluser99", shouldBlock: true },
      { message: "My snapchat is funperson", shouldBlock: true },
      { message: "Find me on Facebook, search John Smith", shouldBlock: true },
      { message: "DM me on twitter @myhandle", shouldBlock: true },
      { message: "My discord is user#1234", shouldBlock: true },
      { message: "Text me at 555-123-4567", shouldBlock: true },
      { message: "My number is 9876543210", shouldBlock: true },
      { message: "Call me on +1 234 567 8900", shouldBlock: true },
      { message: "nine nine two four six eight seven seven", shouldBlock: true },
      { message: "My email is john@example.com", shouldBlock: true },
      { message: "I work at Google headquarters", shouldBlock: true },
      { message: "My job is at Microsoft", shouldBlock: true },
      { message: "I work for Amazon in Seattle", shouldBlock: true },
      { message: "I'm a developer at Meta", shouldBlock: true },
      { message: "I go to Harvard University", shouldBlock: true },
      { message: "I study at Stanford", shouldBlock: true },
      { message: "I graduated from MIT", shouldBlock: true },
      { message: "My address is 123 Main Street", shouldBlock: true },
      { message: "I live at 456 Oak Avenue, Apt 5B", shouldBlock: true },
      { message: "I live on Maple Drive", shouldBlock: true },
      { message: "My apartment number is 302", shouldBlock: true },
      { message: "Check out my website johndoe.com", shouldBlock: true },
      
      // ============ SHOULD BE BLOCKED (Hindi/Hinglish) ============
      { message: "Mera naam Rahul hai", shouldBlock: true },
      { message: "Mera naam hai Priya", shouldBlock: true },
      { message: "Mai Adarsh hu", shouldBlock: true },
      { message: "Main Vikram hoon", shouldBlock: true },
      { message: "Mujhe log Raju bulaate hain", shouldBlock: true },
      { message: "Sab mujhe Neha bolte hain", shouldBlock: true },
      { message: "Mera number hai 9876543210", shouldBlock: true },
      { message: "Call karo mujhe 9988776655 pe", shouldBlock: true },
      { message: "Mera phone number note karo - nau nau do char chhe aath saat saat", shouldBlock: true },
      { message: "ek do teen char paanch chhah saat aath nau zero", shouldBlock: true },
      { message: "Mera insta hai @coolrahul", shouldBlock: true },
      { message: "Mera instagram id @priya_sharma hai", shouldBlock: true },
      { message: "Insta pe add karo mujhe - funuser99", shouldBlock: true },
      { message: "Snap pe follow karo @mysnap", shouldBlock: true },
      { message: "Facebook pe dhundho mujhe - Raj Kumar", shouldBlock: true },
      { message: "Whatsapp karo is number pe 9876543210", shouldBlock: true },
      { message: "Mai Google mein kaam karta hu", shouldBlock: true },
      { message: "Meri company TCS hai", shouldBlock: true },
      { message: "Mai Infosys mein job karta hoon", shouldBlock: true },
      { message: "Mera flat number 302 hai", shouldBlock: true },
      { message: "Mai rehta hu 45 MG Road pe", shouldBlock: true },
      
      // ============ SHOULD BE ALLOWED (Hindi/Hinglish Generic) ============
      { message: "Kaise ho?", shouldBlock: false },
      { message: "Mai theek hu", shouldBlock: false },
      { message: "Kya kar rahe ho?", shouldBlock: false },
      { message: "Mai ek engineer hu", shouldBlock: false },
      { message: "Mai doctor hoon", shouldBlock: false },
      { message: "Mai tech mein kaam karta hu", shouldBlock: false },
      { message: "Mujhe music bahut pasand hai", shouldBlock: false },
      { message: "Tum bahut sundar ho", shouldBlock: false },
      { message: "Mai tumse milna chahta hu", shouldBlock: false },
      { message: "Tum mujhe bahut ache lagte ho", shouldBlock: false },
      { message: "Aaj mausam bahut acha hai", shouldBlock: false },
      { message: "Tumhari favorite movie kaun si hai?", shouldBlock: false },
      { message: "Mai bade sheher mein rehta hu", shouldBlock: false },
      { message: "Office mein kaam karta hu", shouldBlock: false },
      { message: "Work from home karta hu", shouldBlock: false },
      
      // ============ SHOULD BE ALLOWED (Generic Info) ============
      { message: "Hi! How are you doing today?", shouldBlock: false },
      { message: "I love hiking and photography", shouldBlock: false },
      { message: "What kind of music do you like?", shouldBlock: false },
      { message: "I'm 25 years old", shouldBlock: false },
      { message: "I live in a big city", shouldBlock: false },
      { message: "I'm from a small town", shouldBlock: false },
      { message: "I live in the suburbs", shouldBlock: false },
      { message: "I'm an engineer", shouldBlock: false },
      { message: "I work as a doctor", shouldBlock: false },
      { message: "I'm a software developer", shouldBlock: false },
      { message: "I work in tech", shouldBlock: false },
      { message: "I work in the finance industry", shouldBlock: false },
      { message: "I'm in healthcare", shouldBlock: false },
      { message: "I work from home", shouldBlock: false },
      { message: "I have an office job", shouldBlock: false },
      { message: "I'm a freelancer", shouldBlock: false },
      { message: "What are your hobbies?", shouldBlock: false },
      { message: "I enjoy cooking Italian food", shouldBlock: false },
      { message: "Do you like traveling?", shouldBlock: false },
      { message: "I have two dogs", shouldBlock: false },
      { message: "What do you do for fun?", shouldBlock: false },
      { message: "Nice weather today!", shouldBlock: false },
      { message: "What's your favorite movie?", shouldBlock: false },
      { message: "I like reading books", shouldBlock: false },
      { message: "How was your day?", shouldBlock: false },
      { message: "I'm feeling happy today", shouldBlock: false },
      { message: "I'm an introvert", shouldBlock: false },
      { message: "I love going to the beach", shouldBlock: false },
      { message: "I'm into fitness", shouldBlock: false },
      { message: "What kind of food do you like?", shouldBlock: false },
      
      // ============ SHOULD BE ALLOWED (Flirting & Adult Content) ============
      { message: "You're really attractive", shouldBlock: false },
      { message: "I think you're hot", shouldBlock: false },
      { message: "You have beautiful eyes", shouldBlock: false },
      { message: "I'd love to take you out sometime", shouldBlock: false },
      { message: "You're making me blush", shouldBlock: false },
      { message: "I can't stop thinking about you", shouldBlock: false },
      { message: "You're so sexy", shouldBlock: false },
      { message: "I want to kiss you", shouldBlock: false },
      { message: "You turn me on", shouldBlock: false },
      { message: "I'm really attracted to you", shouldBlock: false },
      { message: "What are you wearing?", shouldBlock: false },
      { message: "I wish you were here with me", shouldBlock: false },
      { message: "You're driving me crazy", shouldBlock: false },
      { message: "I want to see more of you", shouldBlock: false },
      { message: "Let's have some fun tonight", shouldBlock: false },
      
      // ============ SHOULD BE ALLOWED (Profanity) ============
      { message: "That's fucking awesome!", shouldBlock: false },
      { message: "Holy shit, really?", shouldBlock: false },
      { message: "What the hell happened?", shouldBlock: false },
      { message: "Damn, you're cute", shouldBlock: false },
      { message: "That's badass!", shouldBlock: false },
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
          expected: testCase.shouldBlock ? 'BLOCK' : 'ALLOW',
          actual: actualBlocked ? 'BLOCKED' : 'ALLOWED',
          detectedTypes: analysis.detectedTypes
        }, 'Test case failed')
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
        'Identity-only filtering (no content moderation)',
        'Allows flirting, adult content, profanity',
        'HINDI/HINGLISH language support',
        'Hindi number words detection (ek, do, teen...)',
        'Hindi name patterns (mera naam, mai hu...)',
        'Hindi social media patterns (insta pe add karo)',
        'Smart personal information detection',
        'Distinguishes specific vs generic info',
        'Name detection (with context awareness)',
        'Phone number recognition (digits and words)',
        'Social media handle detection',
        'Email and website detection',
        'Workplace detection (specific companies only)',
        'School/university detection',
        'Address detection (specific addresses only)',
        'AI-powered edge case analysis',
        'Bilingual safe phrase allowlist',
        '100+ comprehensive test cases (English + Hindi)'
      ]
    }
  }

  /**
   * Check reveal availability
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
        reason: `Need ${revealThreshold - messageCount} more messages`
      }
    }

    const messagesSinceThreshold = messageCount - revealThreshold
    const checkInterval = 5
    const isCheckPoint = messagesSinceThreshold === 0 || messagesSinceThreshold % checkInterval === 0

    if (isCheckPoint) {
      return {
        shouldOffer: true,
        nextCheck: messageCount + checkInterval,
        reason: `Reveal available at ${messageCount} messages`
      }
    }

    const nextCheckpoint = revealThreshold + (Math.floor(messagesSinceThreshold / checkInterval) + 1) * checkInterval
    return {
      shouldOffer: false,
      nextCheck: nextCheckpoint,
      reason: `Next check at ${nextCheckpoint} messages`
    }
  }
}

export default ContentFilterService
