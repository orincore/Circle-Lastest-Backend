import { logger } from '../../config/logger.js'

export interface AIMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
  timestamp?: Date
}

export interface AIResponse {
  message: string
  confidence: number
  intent: string
  requiresEscalation: boolean
  conversationEnded: boolean
}

export class TogetherAIService {
  private static readonly API_BASE_URL = 'https://api.together.xyz/v1'
  // Using Llama-3.2-3B-Instruct-Turbo - cheapest serverless model with excellent performance
  private static readonly MODEL = 'meta-llama/Llama-3.2-3B-Instruct-Turbo'
  private static readonly MAX_TOKENS = 400 // Reduced for cost optimization
  private static readonly TEMPERATURE = 0.3 // Lower for more consistent, policy-compliant responses

  private static getApiKey(): string {
    const apiKey = process.env.TOGETHER_AI_API_KEY
    if (!apiKey) {
      throw new Error('TOGETHER_AI_API_KEY environment variable is required')
    }
    return apiKey
  }

  static async generateResponse(
    messages: AIMessage[],
    userContext?: any
  ): Promise<AIResponse> {
    try {
      const systemPrompt = this.buildSystemPrompt(userContext)
      const conversationHistory = this.formatMessages([
        { role: 'system', content: systemPrompt },
        ...messages
      ])

      const response = await fetch(`${this.API_BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.getApiKey()}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: this.MODEL,
          messages: conversationHistory,
          max_tokens: this.MAX_TOKENS,
          temperature: this.TEMPERATURE,
          stream: false
        })
      })

      if (!response.ok) {
        const errorData = await response.text()
        throw new Error(`Together AI API error: ${response.status} - ${errorData}`)
      }

      const data = await response.json()
      const aiMessage = data.choices[0]?.message?.content || 'I apologize, but I encountered an error. Please contact support at contact@orincore.com'

      // Analyze the response for intent and escalation needs
      const analysis = this.analyzeResponse(aiMessage, messages)

      return {
        message: aiMessage,
        confidence: this.calculateConfidence(data),
        intent: analysis.intent,
        requiresEscalation: analysis.requiresEscalation,
        conversationEnded: analysis.conversationEnded
      }
    } catch (error) {
      logger.error({ error }, 'Error generating AI response')
      
      // Fallback response
      return {
        message: 'I apologize, but I\'m experiencing technical difficulties. Please contact our support team at contact@orincore.com for immediate assistance.',
        confidence: 0,
        intent: 'error',
        requiresEscalation: true,
        conversationEnded: false
      }
    }
  }

  private static buildSystemPrompt(userContext?: any): string {
    const basePrompt = `You are Circle's AI support assistant. Be helpful, empathetic, and brief.

RULES:
1. NO LIVE SUPPORT: Escalations go to contact@orincore.com only
2. REFUNDS: 7-day window only. Explain max 3 times, then politely deny
3. BE EMPATHETIC: Acknowledge feelings, stay understanding
4. BE CONCISE: Brief but helpful responses

CIRCLE APP:
- Dating app: Free, Premium ($9.99), Premium Plus ($19.99)
- 7-day refund policy from subscription start
- Features: Matching, chat, profiles, filters

REFUND PROCESS:
- Within 7 days: Guide through refund
- Outside 7 days: Explain policy empathetically (max 3x)
- Final denial: "I understand your frustration. Our 7-day policy maintains fair pricing. Contact contact@orincore.com for review."

ESCALATION: "Our support team at contact@orincore.com can review your situation (24hr response)."

${userContext ? `USER: ${userContext.profile?.username || 'User'}, Plan: ${userContext.latestSubscription?.plan_type || 'none'}, Started: ${userContext.latestSubscription?.started_at || 'n/a'}` : ''}`

    return basePrompt
  }

  private static formatMessages(messages: AIMessage[]): any[] {
    return messages.map(msg => ({
      role: msg.role,
      content: msg.content
    }))
  }

  private static analyzeResponse(response: string, conversationHistory: AIMessage[]): {
    intent: string
    requiresEscalation: boolean
    conversationEnded: boolean
  } {
    const lowerResponse = response.toLowerCase()
    
    // Detect intent
    let intent = 'general'
    if (lowerResponse.includes('refund')) intent = 'refund'
    else if (lowerResponse.includes('subscription') || lowerResponse.includes('billing')) intent = 'subscription'
    else if (lowerResponse.includes('technical') || lowerResponse.includes('login')) intent = 'technical'
    else if (lowerResponse.includes('cancel')) intent = 'cancellation'

    // Check for escalation needs
    const requiresEscalation = lowerResponse.includes('contact@orincore.com') || 
                              lowerResponse.includes('support team') ||
                              this.countRefundExplanations(conversationHistory) >= 3

    // Check if conversation should end
    const conversationEnded = lowerResponse.includes('goodbye') || 
                             lowerResponse.includes('thank you') ||
                             lowerResponse.includes('that helps') ||
                             requiresEscalation

    return { intent, requiresEscalation, conversationEnded }
  }

  private static countRefundExplanations(messages: AIMessage[]): number {
    return messages.filter(msg => 
      msg.role === 'assistant' && 
      msg.content.toLowerCase().includes('refund policy') &&
      msg.content.toLowerCase().includes('7 days')
    ).length
  }

  private static calculateConfidence(apiResponse: any): number {
    // Simple confidence calculation based on response quality
    const choice = apiResponse.choices[0]
    if (!choice) return 0

    const finishReason = choice.finish_reason
    if (finishReason === 'stop') return 0.9
    if (finishReason === 'length') return 0.7
    return 0.5
  }

  // Validate API key and connection
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

  // Get available models with cost information
  static async getAvailableModels(): Promise<any[]> {
    try {
      const response = await fetch(`${this.API_BASE_URL}/models`, {
        headers: {
          'Authorization': `Bearer ${this.getApiKey()}`
        }
      })

      if (!response.ok) return []

      const data = await response.json()
      
      // Filter for cost-effective serverless models
      const costEffectiveModels = data.data?.filter((model: any) => 
        model.id.includes('Turbo') || 
        model.id.includes('3B') || 
        model.id.includes('7B')
      ).map((model: any) => ({
        id: model.id,
        name: model.display_name || model.id,
        pricing: model.pricing || 'Unknown',
        type: model.type || 'Unknown'
      })) || []

      return costEffectiveModels
    } catch (error) {
      logger.error({ error }, 'Failed to get available models')
      return []
    }
  }

  // Get current model info and estimated cost
  static getModelInfo(): {
    model: string
    estimatedCostPer1kTokens: number
    maxTokens: number
    temperature: number
  } {
    return {
      model: this.MODEL,
      estimatedCostPer1kTokens: 0.0001, // Llama-3.2-3B-Instruct-Turbo is ~$0.0001/1k tokens
      maxTokens: this.MAX_TOKENS,
      temperature: this.TEMPERATURE
    }
  }

  // Estimate conversation cost
  static estimateConversationCost(messageCount: number, avgTokensPerMessage: number = 50): number {
    const totalTokens = messageCount * avgTokensPerMessage
    const costPer1k = this.getModelInfo().estimatedCostPer1kTokens
    return (totalTokens / 1000) * costPer1k
  }
}
