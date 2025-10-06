import { logger } from '../../config/logger.js'

export interface SentimentAnalysis {
  sentiment: 'positive' | 'negative' | 'neutral' | 'frustrated' | 'angry' | 'confused' | 'urgent'
  confidence: number
  emotions: {
    anger: number
    frustration: number
    satisfaction: number
    confusion: number
    urgency: number
    politeness: number
  }
  keywords: string[]
  escalationRisk: 'low' | 'medium' | 'high' | 'critical'
  suggestedResponse: 'empathetic' | 'solution-focused' | 'apologetic' | 'reassuring' | 'urgent'
}

export interface ConversationContext {
  messageHistory: string[]
  issueType: string
  resolutionAttempts: number
  customerTier: 'free' | 'premium' | 'premium_plus'
  previousInteractions: number
}

export class SentimentAnalysisService {
  // Sentiment keywords and patterns
  private static sentimentPatterns = {
    frustrated: [
      'frustrated', 'annoying', 'ridiculous', 'terrible', 'awful', 'horrible',
      'waste of time', 'not working', 'broken', 'useless', 'disappointed',
      'fed up', 'sick of', 'enough', 'this is crazy', 'unacceptable'
    ],
    angry: [
      'angry', 'furious', 'mad', 'pissed', 'outraged', 'livid', 'hate',
      'disgusted', 'appalled', 'scam', 'fraud', 'rip off', 'stealing',
      'lawsuit', 'lawyer', 'sue', 'report', 'complaint', 'demand'
    ],
    urgent: [
      'urgent', 'emergency', 'asap', 'immediately', 'right now', 'critical',
      'important', 'deadline', 'time sensitive', 'hurry', 'quick', 'fast',
      'need help now', 'cant wait', 'losing money', 'business critical'
    ],
    confused: [
      'confused', 'dont understand', 'how do i', 'what does', 'unclear',
      'complicated', 'difficult', 'help me understand', 'explain',
      'not sure', 'lost', 'stuck', 'where is', 'how to', 'why'
    ],
    positive: [
      'great', 'awesome', 'excellent', 'perfect', 'amazing', 'wonderful',
      'fantastic', 'love', 'thank you', 'appreciate', 'helpful', 'good',
      'satisfied', 'happy', 'pleased', 'impressed', 'works well'
    ],
    polite: [
      'please', 'thank you', 'sorry', 'excuse me', 'if possible',
      'would you mind', 'could you', 'appreciate', 'grateful',
      'understand', 'patient', 'kind', 'help', 'assist'
    ]
  }

  // Escalation risk indicators
  private static escalationIndicators = {
    critical: [
      'lawyer', 'lawsuit', 'sue', 'legal action', 'fraud', 'scam',
      'report to authorities', 'better business bureau', 'refund everything',
      'cancel everything', 'never using again', 'telling everyone'
    ],
    high: [
      'manager', 'supervisor', 'complaint', 'unacceptable', 'demand',
      'this is ridiculous', 'waste of money', 'terrible service',
      'losing customers', 'bad review', 'social media'
    ],
    medium: [
      'frustrated', 'disappointed', 'not happy', 'expected better',
      'not working', 'broken', 'issues', 'problems', 'concerns'
    ]
  }

  // Analyze message sentiment and emotions
  static analyzeSentiment(message: string, context?: ConversationContext): SentimentAnalysis {
    const lowerMessage = message.toLowerCase()
    const words = lowerMessage.split(/\s+/)
    
    // Calculate emotion scores
    const emotions = {
      anger: this.calculateEmotionScore(lowerMessage, this.sentimentPatterns.angry),
      frustration: this.calculateEmotionScore(lowerMessage, this.sentimentPatterns.frustrated),
      satisfaction: this.calculateEmotionScore(lowerMessage, this.sentimentPatterns.positive),
      confusion: this.calculateEmotionScore(lowerMessage, this.sentimentPatterns.confused),
      urgency: this.calculateEmotionScore(lowerMessage, this.sentimentPatterns.urgent),
      politeness: this.calculateEmotionScore(lowerMessage, this.sentimentPatterns.polite)
    }

    // Determine primary sentiment
    const sentiment = this.determinePrimarySentiment(emotions, lowerMessage)
    
    // Calculate escalation risk
    const escalationRisk = this.calculateEscalationRisk(lowerMessage, context)
    
    // Extract keywords
    const keywords = this.extractKeywords(lowerMessage)
    
    // Suggest response type
    const suggestedResponse = this.suggestResponseType(sentiment, emotions, escalationRisk)
    
    // Calculate overall confidence
    const confidence = this.calculateConfidence(emotions, keywords.length)

    return {
      sentiment,
      confidence,
      emotions,
      keywords,
      escalationRisk,
      suggestedResponse
    }
  }

  // Calculate emotion score based on keyword matches
  private static calculateEmotionScore(message: string, keywords: string[]): number {
    let score = 0
    let matches = 0
    
    keywords.forEach(keyword => {
      if (message.includes(keyword)) {
        matches++
        // Weight longer phrases higher
        score += keyword.split(' ').length
      }
    })
    
    // Normalize score (0-1)
    return Math.min(score / 10, 1)
  }

  // Determine primary sentiment from emotion scores
  private static determinePrimarySentiment(
    emotions: any, 
    message: string
  ): SentimentAnalysis['sentiment'] {
    const { anger, frustration, satisfaction, confusion, urgency } = emotions
    
    // Check for specific urgent indicators
    if (urgency > 0.3 || message.includes('urgent') || message.includes('emergency')) {
      return 'urgent'
    }
    
    // Check for anger (highest priority negative emotion)
    if (anger > 0.4) {
      return 'angry'
    }
    
    // Check for frustration
    if (frustration > 0.3) {
      return 'frustrated'
    }
    
    // Check for confusion
    if (confusion > 0.3) {
      return 'confused'
    }
    
    // Check for positive sentiment
    if (satisfaction > 0.3) {
      return 'positive'
    }
    
    // Check for negative indicators
    if (anger > 0.1 || frustration > 0.1) {
      return 'negative'
    }
    
    return 'neutral'
  }

  // Calculate escalation risk
  private static calculateEscalationRisk(
    message: string, 
    context?: ConversationContext
  ): SentimentAnalysis['escalationRisk'] {
    // Check for critical escalation indicators
    if (this.escalationIndicators.critical.some(indicator => message.includes(indicator))) {
      return 'critical'
    }
    
    // Check for high escalation indicators
    if (this.escalationIndicators.high.some(indicator => message.includes(indicator))) {
      return 'high'
    }
    
    // Check for medium escalation indicators
    if (this.escalationIndicators.medium.some(indicator => message.includes(indicator))) {
      return 'medium'
    }
    
    // Consider context factors
    if (context) {
      // Multiple resolution attempts increase risk
      if (context.resolutionAttempts >= 3) {
        return 'high'
      }
      
      // Premium customers get higher priority
      if (context.customerTier === 'premium_plus' && context.resolutionAttempts >= 2) {
        return 'high'
      }
      
      // Repeat customers with issues
      if (context.previousInteractions >= 5 && context.resolutionAttempts >= 2) {
        return 'medium'
      }
    }
    
    return 'low'
  }

  // Extract relevant keywords from message
  private static extractKeywords(message: string): string[] {
    const keywords: string[] = []
    
    // Check all sentiment patterns for matches
    Object.values(this.sentimentPatterns).forEach(patternArray => {
      patternArray.forEach(pattern => {
        if (message.includes(pattern)) {
          keywords.push(pattern)
        }
      })
    })
    
    // Check escalation indicators
    Object.values(this.escalationIndicators).forEach(indicatorArray => {
      indicatorArray.forEach(indicator => {
        if (message.includes(indicator)) {
          keywords.push(indicator)
        }
      })
    })
    
    return [...new Set(keywords)] // Remove duplicates
  }

  // Suggest appropriate response type
  private static suggestResponseType(
    sentiment: SentimentAnalysis['sentiment'],
    emotions: any,
    escalationRisk: SentimentAnalysis['escalationRisk']
  ): SentimentAnalysis['suggestedResponse'] {
    // Critical escalation always needs urgent response
    if (escalationRisk === 'critical') {
      return 'urgent'
    }
    
    // High anger or frustration needs apologetic approach
    if (sentiment === 'angry' || (sentiment === 'frustrated' && emotions.anger > 0.2)) {
      return 'apologetic'
    }
    
    // Confusion needs solution-focused approach
    if (sentiment === 'confused') {
      return 'solution-focused'
    }
    
    // Urgent matters need urgent response
    if (sentiment === 'urgent') {
      return 'urgent'
    }
    
    // Frustrated customers need empathy
    if (sentiment === 'frustrated' || sentiment === 'negative') {
      return 'empathetic'
    }
    
    // Default to reassuring for neutral/positive
    return 'reassuring'
  }

  // Calculate confidence score
  private static calculateConfidence(emotions: any, keywordCount: number): number {
    // Base confidence on emotion strength and keyword matches
    const maxEmotion = Math.max(...Object.values(emotions) as number[])
    const keywordFactor = Math.min(keywordCount / 5, 1) // Max factor of 1 for 5+ keywords
    
    return Math.min((maxEmotion + keywordFactor) / 2, 0.95) // Max 95% confidence
  }

  // Generate empathetic response based on sentiment analysis
  static generateEmpathicResponse(analysis: SentimentAnalysis, customerName?: string): string {
    const name = customerName || 'there'
    
    switch (analysis.suggestedResponse) {
      case 'urgent':
        return `I understand this is urgent, ${name}. Let me prioritize your request and get this resolved immediately. I'm escalating this to our senior team right now.`
      
      case 'apologetic':
        return `I sincerely apologize for the frustration you're experiencing, ${name}. This is absolutely not the experience we want for our valued customers. Let me personally ensure we resolve this right away.`
      
      case 'empathetic':
        return `I completely understand how frustrating this must be, ${name}. I can see why you'd feel this way, and I want to help make this right for you.`
      
      case 'solution-focused':
        return `I can help clarify this for you, ${name}. Let me walk you through the solution step by step to make sure everything is clear.`
      
      case 'reassuring':
        return `Thank you for reaching out, ${name}. I'm here to help and I'm confident we can get this sorted out for you quickly.`
      
      default:
        return `Hello ${name}, I'm here to assist you with whatever you need. How can I help make your experience better today?`
    }
  }

  // Analyze conversation trend over multiple messages
  static analyzeConversationTrend(messages: string[]): {
    trend: 'improving' | 'deteriorating' | 'stable'
    riskLevel: 'low' | 'medium' | 'high' | 'critical'
    recommendation: string
  } {
    if (messages.length < 2) {
      return {
        trend: 'stable',
        riskLevel: 'low',
        recommendation: 'Continue with current approach'
      }
    }
    
    // Analyze sentiment progression
    const sentiments = messages.map(msg => this.analyzeSentiment(msg))
    const recentSentiments = sentiments.slice(-3) // Last 3 messages
    
    // Calculate trend
    let positiveCount = 0
    let negativeCount = 0
    
    recentSentiments.forEach(analysis => {
      if (['positive', 'neutral'].includes(analysis.sentiment)) {
        positiveCount++
      } else {
        negativeCount++
      }
    })
    
    let trend: 'improving' | 'deteriorating' | 'stable'
    if (positiveCount > negativeCount) {
      trend = 'improving'
    } else if (negativeCount > positiveCount) {
      trend = 'deteriorating'
    } else {
      trend = 'stable'
    }
    
    // Determine risk level
    const latestAnalysis = sentiments[sentiments.length - 1]
    let riskLevel = latestAnalysis.escalationRisk
    
    // Adjust based on trend
    if (trend === 'deteriorating' && riskLevel === 'low') {
      riskLevel = 'medium'
    }
    
    // Generate recommendation
    let recommendation: string
    if (riskLevel === 'critical') {
      recommendation = 'Immediate escalation to senior support required'
    } else if (riskLevel === 'high') {
      recommendation = 'Consider escalation or offer compensation'
    } else if (trend === 'deteriorating') {
      recommendation = 'Adjust approach - customer satisfaction declining'
    } else if (trend === 'improving') {
      recommendation = 'Continue current approach - customer satisfaction improving'
    } else {
      recommendation = 'Maintain current support level'
    }
    
    return { trend, riskLevel, recommendation }
  }
}

export default SentimentAnalysisService
