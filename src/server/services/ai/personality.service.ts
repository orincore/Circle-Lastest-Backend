import { logger } from '../../config/logger.js'

export interface AIPersonality {
  name: string
  greeting: string
  empathyLevel: 'high' | 'medium' | 'low'
  responseStyle: 'formal' | 'friendly' | 'casual'
  specialties: string[]
}

export interface TypingBehavior {
  baseDelay: number
  varianceMs: number
  wordsPerMinute: number
  pauseChance: number
  pauseDuration: number
}

export interface ConversationState {
  askedAnythingElse: boolean
  userSaidNo: boolean
  conversationEnded: boolean
  messageCount: number
  lastResponseTime: number
}

export class PersonalityService {
  private static indianNames = [
    'Priya', 'Arjun', 'Kavya', 'Rohan', 'Ananya', 'Vikram', 'Shreya', 'Aditya',
    'Meera', 'Karan', 'Pooja', 'Rahul', 'Divya', 'Amit', 'Riya', 'Sanjay',
    'Neha', 'Rajesh', 'Swati', 'Manish', 'Deepika', 'Suresh', 'Priyanka', 'Ajay',
    'Nisha', 'Varun', 'Simran', 'Gaurav', 'Asha', 'Nikhil', 'Sunita', 'Ravi',
    'Anjali', 'Sachin', 'Rekha', 'Vishal', 'Shweta', 'Manoj', 'Geeta', 'Akash'
  ]

  private static greetings = [
    "Hello! I'm {name} from Circle's customer support team. I'm here to help you with any questions or concerns you might have. How can I assist you today?",
    "Hi there! This is {name} from Circle support. I hope you're having a wonderful day! What can I help you with?",
    "Good day! I'm {name}, your customer support representative at Circle. I'm delighted to assist you. What brings you here today?",
    "Hello! {name} here from Circle's support team. I'm ready to help make your experience with Circle even better. How may I assist you?",
    "Hi! I'm {name} from Circle customer care. Thank you for reaching out to us. I'm here to ensure all your concerns are addressed. What can I do for you?"
  ]

  private static empathyPhrases = {
    understanding: [
      "I completely understand your concern",
      "I can see why this would be frustrating",
      "That sounds really inconvenient",
      "I appreciate you bringing this to my attention",
      "I can imagine how disappointing this must be"
    ],
    apologetic: [
      "I sincerely apologize for any inconvenience",
      "I'm truly sorry you've experienced this issue",
      "Please accept my apologies for this situation",
      "I'm sorry this hasn't met your expectations",
      "I apologize for any confusion this may have caused"
    ],
    reassuring: [
      "I'm here to help resolve this for you",
      "Let me take care of this right away",
      "I'll make sure we get this sorted out",
      "You're in good hands - I'll handle this personally",
      "I'm committed to finding the best solution for you"
    ]
  }

  private static closingPhrases = [
    "Is there anything else I can help you with today?",
    "Would you like assistance with anything else?",
    "Is there any other way I can support you today?",
    "Do you have any other questions or concerns I can address?",
    "Can I help you with anything else while we're connected?"
  ]

  private static thankYouMessages = [
    "Thank you so much for choosing Circle! It's been my pleasure assisting you today. Have a wonderful day ahead! 😊",
    "I'm grateful for the opportunity to help you today. Thank you for being a valued Circle member. Take care! 🌟",
    "Thank you for your patience and for giving me the chance to assist you. Wishing you a fantastic day! ✨",
    "It's been wonderful helping you today! Thank you for trusting Circle with your needs. Have a great day! 💫",
    "Thank you for reaching out to us. I'm so glad I could help! Enjoy the rest of your day with Circle! 🎉"
  ]

  // Generate random AI personality
  static generatePersonality(): AIPersonality {
    const name = this.indianNames[Math.floor(Math.random() * this.indianNames.length)]
    const greeting = this.greetings[Math.floor(Math.random() * this.greetings.length)].replace('{name}', name)
    
    return {
      name,
      greeting,
      empathyLevel: 'high',
      responseStyle: 'friendly',
      specialties: ['subscriptions', 'refunds', 'technical_support', 'account_management']
    }
  }

  // Generate human-like typing behavior
  static generateTypingBehavior(messageLength: number): TypingBehavior {
    const baseWPM = 45 + Math.random() * 25 // 45-70 WPM
    const words = messageLength / 5 // Approximate words
    const baseDelay = (words / baseWPM) * 60 * 1000 // Convert to milliseconds
    
    return {
      baseDelay: Math.max(1000, baseDelay), // Minimum 1 second
      varianceMs: 500 + Math.random() * 1500, // 500-2000ms variance
      wordsPerMinute: baseWPM,
      pauseChance: 0.3, // 30% chance of pause
      pauseDuration: 800 + Math.random() * 1200 // 800-2000ms pause
    }
  }

  // Calculate response delay with human-like variance
  static calculateResponseDelay(messageLength: number, conversationState: ConversationState): number {
    const behavior = this.generateTypingBehavior(messageLength)
    let delay = behavior.baseDelay
    
    // Add variance
    delay += (Math.random() - 0.5) * behavior.varianceMs
    
    // Add pause if random chance
    if (Math.random() < behavior.pauseChance) {
      delay += behavior.pauseDuration
    }
    
    // Longer delay for first message
    if (conversationState.messageCount === 0) {
      delay += 1000 + Math.random() * 2000
    }
    
    // Shorter delay for quick responses
    if (conversationState.messageCount > 3) {
      delay *= 0.7
    }
    
    return Math.max(800, Math.min(8000, delay)) // Between 0.8-8 seconds
  }

  // Generate empathetic response with policy compliance
  static generateEmpathicResponse(
    intent: string, 
    userMessage: string, 
    personality: AIPersonality,
    isSuccess: boolean = true
  ): string {
    const understanding = this.empathyPhrases.understanding[Math.floor(Math.random() * this.empathyPhrases.understanding.length)]
    const reassuring = this.empathyPhrases.reassuring[Math.floor(Math.random() * this.empathyPhrases.reassuring.length)]
    
    let response = `${understanding}. `
    
    if (!isSuccess) {
      const apologetic = this.empathyPhrases.apologetic[Math.floor(Math.random() * this.empathyPhrases.apologetic.length)]
      response += `${apologetic}. `
    }
    
    response += `${reassuring}. `
    
    return response
  }

  // Generate multi-part response
  static generateMultiPartResponse(mainMessage: string, personality: AIPersonality): string[] {
    const messages = []
    
    // Split long messages into parts
    if (mainMessage.length > 200) {
      const parts = mainMessage.split('\n\n')
      if (parts.length > 1) {
        return parts.filter(part => part.trim().length > 0)
      }
      
      // Split by sentences if no paragraphs
      const sentences = mainMessage.split('. ')
      if (sentences.length > 2) {
        const midPoint = Math.ceil(sentences.length / 2)
        messages.push(sentences.slice(0, midPoint).join('. ') + '.')
        messages.push(sentences.slice(midPoint).join('. '))
        return messages
      }
    }
    
    return [mainMessage]
  }

  // Check if user wants to end conversation
  static isConversationEnding(message: string): boolean {
    const endingPhrases = [
      'no', 'nope', 'nothing else', 'that\'s all', 'no thanks', 'no thank you',
      'i\'m good', 'all good', 'nothing more', 'that\'s it', 'no more questions',
      'i\'m done', 'that\'s everything', 'no other questions'
    ]
    
    const lowerMessage = message.toLowerCase().trim()
    return endingPhrases.some(phrase => lowerMessage === phrase || lowerMessage.includes(phrase))
  }

  // Generate closing message
  static generateClosingMessage(personality: AIPersonality): string {
    return this.thankYouMessages[Math.floor(Math.random() * this.thankYouMessages.length)]
  }

  // Generate "anything else" question
  static generateAnythingElseQuestion(): string {
    return this.closingPhrases[Math.floor(Math.random() * this.closingPhrases.length)]
  }

  // Policy compliance checker
  static checkPolicyCompliance(intent: string, action: string): { compliant: boolean; reason?: string } {
    const policies = {
      refund: {
        timeLimit: 7, // days
        conditions: ['within_time_limit', 'valid_subscription']
      },
      cancellation: {
        immediate: true,
        refundEligible: true
      },
      dataAccess: {
        userOnly: true,
        authenticated: true
      }
    }

    // All actions are compliant by default in this implementation
    // Add specific policy checks as needed
    return { compliant: true }
  }

  // Generate professional response with personality
  static formatResponse(
    message: string, 
    personality: AIPersonality, 
    conversationState: ConversationState
  ): string {
    let formattedMessage = message

    // Add personality touches
    if (conversationState.messageCount === 0) {
      formattedMessage = personality.greeting + '\n\n' + formattedMessage
    }

    // Add empathetic language for certain intents
    if (message.includes('refund') || message.includes('cancel')) {
      const empathy = this.empathyPhrases.understanding[Math.floor(Math.random() * this.empathyPhrases.understanding.length)]
      formattedMessage = `${empathy}. ${formattedMessage}`
    }

    return formattedMessage
  }
}

export default PersonalityService
