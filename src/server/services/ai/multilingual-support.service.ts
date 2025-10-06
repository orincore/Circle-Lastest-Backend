import { logger } from '../../config/logger.js'

export interface LanguageDetection {
  language: string
  confidence: number
  script: 'latin' | 'devanagari' | 'arabic' | 'chinese' | 'cyrillic' | 'other'
}

export interface TranslationResult {
  originalText: string
  translatedText: string
  sourceLanguage: string
  targetLanguage: string
  confidence: number
}

export interface MultilingualResponse {
  originalLanguage: string
  responseInOriginal: string
  responseInEnglish: string
  supportedLanguage: boolean
}

export class MultilingualSupportService {
  // Supported languages with their codes and native names
  private static supportedLanguages = {
    'en': { name: 'English', native: 'English', rtl: false },
    'hi': { name: 'Hindi', native: 'हिंदी', rtl: false },
    'es': { name: 'Spanish', native: 'Español', rtl: false },
    'fr': { name: 'French', native: 'Français', rtl: false },
    'de': { name: 'German', native: 'Deutsch', rtl: false },
    'pt': { name: 'Portuguese', native: 'Português', rtl: false },
    'ru': { name: 'Russian', native: 'Русский', rtl: false },
    'ja': { name: 'Japanese', native: '日本語', rtl: false },
    'ko': { name: 'Korean', native: '한국어', rtl: false },
    'zh': { name: 'Chinese', native: '中文', rtl: false },
    'ar': { name: 'Arabic', native: 'العربية', rtl: true },
    'bn': { name: 'Bengali', native: 'বাংলা', rtl: false },
    'ur': { name: 'Urdu', native: 'اردو', rtl: true },
    'ta': { name: 'Tamil', native: 'தமிழ்', rtl: false },
    'te': { name: 'Telugu', native: 'తెలుగు', rtl: false },
    'mr': { name: 'Marathi', native: 'मराठी', rtl: false },
    'gu': { name: 'Gujarati', native: 'ગુજરાતી', rtl: false },
    'kn': { name: 'Kannada', native: 'ಕನ್ನಡ', rtl: false },
    'ml': { name: 'Malayalam', native: 'മലയാളം', rtl: false },
    'pa': { name: 'Punjabi', native: 'ਪੰਜਾਬੀ', rtl: false }
  }

  // Language detection patterns
  private static languagePatterns = {
    'hi': /[\u0900-\u097F]/,  // Devanagari script
    'ar': /[\u0600-\u06FF]/,  // Arabic script
    'zh': /[\u4e00-\u9fff]/,  // Chinese characters
    'ja': /[\u3040-\u309f\u30a0-\u30ff]/,  // Hiragana and Katakana
    'ko': /[\uac00-\ud7af]/,  // Hangul
    'ru': /[\u0400-\u04FF]/,  // Cyrillic
    'bn': /[\u0980-\u09FF]/,  // Bengali
    'ta': /[\u0B80-\u0BFF]/,  // Tamil
    'te': /[\u0C00-\u0C7F]/,  // Telugu
    'mr': /[\u0900-\u097F]/,  // Marathi (Devanagari)
    'gu': /[\u0A80-\u0AFF]/,  // Gujarati
    'kn': /[\u0C80-\u0CFF]/,  // Kannada
    'ml': /[\u0D00-\u0D7F]/,  // Malayalam
    'pa': /[\u0A00-\u0A7F]/,  // Punjabi
    'ur': /[\u0600-\u06FF]/   // Urdu (Arabic script)
  }

  // Common phrases for language detection
  private static commonPhrases = {
    'hi': ['नमस्ते', 'धन्यवाद', 'कृपया', 'समस्या', 'सहायता', 'मदद'],
    'es': ['hola', 'gracias', 'por favor', 'problema', 'ayuda', 'necesito'],
    'fr': ['bonjour', 'merci', 's\'il vous plaît', 'problème', 'aide', 'besoin'],
    'de': ['hallo', 'danke', 'bitte', 'problem', 'hilfe', 'brauche'],
    'pt': ['olá', 'obrigado', 'por favor', 'problema', 'ajuda', 'preciso'],
    'ru': ['привет', 'спасибо', 'пожалуйста', 'проблема', 'помощь', 'нужно'],
    'ar': ['مرحبا', 'شكرا', 'من فضلك', 'مشكلة', 'مساعدة', 'أحتاج'],
    'bn': ['হ্যালো', 'ধন্যবাদ', 'দয়া করে', 'সমস্যা', 'সাহায্য', 'প্রয়োজন'],
    'ta': ['வணக்கம்', 'நன்றி', 'தயவுசெய்து', 'பிரச்சனை', 'உதவி', 'வேண்டும்'],
    'te': ['హలో', 'ధన్యవాదాలు', 'దయచేసి', 'సమస్య', 'సహాయం', 'కావాలి'],
    'ur': ['سلام', 'شکریہ', 'برائے کرم', 'مسئلہ', 'مدد', 'ضرورت']
  }

  // Detect language from text
  static detectLanguage(text: string): LanguageDetection {
    const lowerText = text.toLowerCase()
    
    // Check for script patterns first
    for (const [lang, pattern] of Object.entries(this.languagePatterns)) {
      if (pattern.test(text)) {
        return {
          language: lang,
          confidence: 0.9,
          script: this.getScript(lang)
        }
      }
    }
    
    // Check for common phrases
    let bestMatch = { language: 'en', confidence: 0.1 }
    
    for (const [lang, phrases] of Object.entries(this.commonPhrases)) {
      let matches = 0
      phrases.forEach(phrase => {
        if (lowerText.includes(phrase.toLowerCase())) {
          matches++
        }
      })
      
      if (matches > 0) {
        const confidence = Math.min(matches / phrases.length + 0.3, 0.8)
        if (confidence > bestMatch.confidence) {
          bestMatch = { language: lang, confidence }
        }
      }
    }
    
    // Check for English indicators
    const englishWords = ['hello', 'hi', 'help', 'problem', 'issue', 'support', 'please', 'thank', 'need']
    const englishMatches = englishWords.filter(word => lowerText.includes(word)).length
    
    if (englishMatches >= 2) {
      bestMatch = { language: 'en', confidence: 0.8 }
    }
    
    return {
      language: bestMatch.language,
      confidence: bestMatch.confidence,
      script: this.getScript(bestMatch.language)
    }
  }

  // Get script type for language
  private static getScript(language: string): LanguageDetection['script'] {
    const scriptMap: Record<string, LanguageDetection['script']> = {
      'hi': 'devanagari', 'mr': 'devanagari',
      'ar': 'arabic', 'ur': 'arabic',
      'zh': 'chinese', 'ja': 'chinese',
      'ru': 'cyrillic'
    }
    
    return scriptMap[language] || 'latin'
  }

  // Translate text (simplified - would integrate with translation API)
  static async translateText(
    text: string, 
    targetLanguage: string, 
    sourceLanguage?: string
  ): Promise<TranslationResult> {
    try {
      // Auto-detect source language if not provided
      if (!sourceLanguage) {
        const detection = this.detectLanguage(text)
        sourceLanguage = detection.language
      }
      
      // If source and target are the same, return original
      if (sourceLanguage === targetLanguage) {
        return {
          originalText: text,
          translatedText: text,
          sourceLanguage,
          targetLanguage,
          confidence: 1.0
        }
      }
      
      // For demo purposes, return predefined translations for common phrases
      const translatedText = await this.getTranslation(text, sourceLanguage, targetLanguage)
      
      return {
        originalText: text,
        translatedText,
        sourceLanguage,
        targetLanguage,
        confidence: 0.85
      }
    } catch (error) {
      logger.error({ error, text, targetLanguage }, 'Translation error')
      
      // Fallback to original text
      return {
        originalText: text,
        translatedText: text,
        sourceLanguage: sourceLanguage || 'unknown',
        targetLanguage,
        confidence: 0.0
      }
    }
  }

  // Get translation (simplified implementation)
  private static async getTranslation(
    text: string, 
    sourceLanguage: string, 
    targetLanguage: string
  ): Promise<string> {
    // Get the appropriate translation dictionary based on source and target languages
    let translationDict: Record<string, string> = {};
    
    if (sourceLanguage === 'en' && targetLanguage === 'hi') {
      translationDict = this.getEnglishToHindiTranslations();
    } else if (sourceLanguage === 'en' && targetLanguage === 'es') {
      translationDict = this.getEnglishToSpanishTranslations();
    } else if (sourceLanguage === 'en' && targetLanguage === 'fr') {
      translationDict = this.getEnglishToFrenchTranslations();
    } else if (sourceLanguage === 'en' && targetLanguage === 'ar') {
      translationDict = this.getEnglishToArabicTranslations();
    } else if (sourceLanguage === 'hi' && targetLanguage === 'en') {
      translationDict = this.getHindiToEnglishTranslations();
    } else if (sourceLanguage === 'es' && targetLanguage === 'en') {
      translationDict = this.getSpanishToEnglishTranslations();
    } else if (sourceLanguage === 'fr' && targetLanguage === 'en') {
      translationDict = this.getFrenchToEnglishTranslations();
    } else if (sourceLanguage === 'ar' && targetLanguage === 'en') {
      translationDict = this.getArabicToEnglishTranslations();
    }
    
    // Find exact or partial matches in the translation dictionary
    if (Object.keys(translationDict).length > 0) {
      const lowerText = text.toLowerCase();
      for (const [original, translated] of Object.entries(translationDict)) {
        if (lowerText.includes(original.toLowerCase())) {
          return translated;
        }
      }
    }
    
    // If no translation found, return original with language indicator
    return `[${targetLanguage.toUpperCase()}] ${text}`;
  }

  // Translation dictionaries (simplified)
  private static getEnglishToHindiTranslations(): Record<string, string> {
    return {
      'hello': 'नमस्ते',
      'thank you': 'धन्यवाद',
      'please': 'कृपया',
      'help': 'मदद',
      'problem': 'समस्या',
      'issue': 'मुद्दा',
      'support': 'सहायता',
      'subscription': 'सदस्यता',
      'refund': 'वापसी',
      'cancel': 'रद्द करें',
      'I understand your concern': 'मैं आपकी चिंता समझता हूं',
      'I can help you with that': 'मैं इसमें आपकी मदद कर सकता हूं',
      'Is there anything else I can help you with?': 'क्या कोई और चीज़ है जिसमें मैं आपकी मदद कर सकूं?'
    }
  }

  private static getEnglishToSpanishTranslations(): Record<string, string> {
    return {
      'hello': 'hola',
      'thank you': 'gracias',
      'please': 'por favor',
      'help': 'ayuda',
      'problem': 'problema',
      'issue': 'problema',
      'support': 'soporte',
      'subscription': 'suscripción',
      'refund': 'reembolso',
      'cancel': 'cancelar',
      'I understand your concern': 'Entiendo tu preocupación',
      'I can help you with that': 'Puedo ayudarte con eso',
      'Is there anything else I can help you with?': '¿Hay algo más en lo que pueda ayudarte?'
    }
  }

  private static getEnglishToFrenchTranslations(): Record<string, string> {
    return {
      'hello': 'bonjour',
      'thank you': 'merci',
      'please': 's\'il vous plaît',
      'help': 'aide',
      'problem': 'problème',
      'issue': 'problème',
      'support': 'support',
      'subscription': 'abonnement',
      'refund': 'remboursement',
      'cancel': 'annuler',
      'I understand your concern': 'Je comprends votre préoccupation',
      'I can help you with that': 'Je peux vous aider avec ça',
      'Is there anything else I can help you with?': 'Y a-t-il autre chose avec quoi je peux vous aider?'
    }
  }

  private static getEnglishToArabicTranslations(): Record<string, string> {
    return {
      'hello': 'مرحبا',
      'thank you': 'شكرا لك',
      'please': 'من فضلك',
      'help': 'مساعدة',
      'problem': 'مشكلة',
      'issue': 'قضية',
      'support': 'الدعم',
      'subscription': 'اشتراك',
      'refund': 'استرداد',
      'cancel': 'إلغاء',
      'I understand your concern': 'أفهم قلقك',
      'I can help you with that': 'يمكنني مساعدتك في ذلك',
      'Is there anything else I can help you with?': 'هل هناك أي شيء آخر يمكنني مساعدتك فيه؟'
    }
  }

  // Reverse translation dictionaries
  private static getHindiToEnglishTranslations(): Record<string, string> {
    const hindiToEn: Record<string, string> = {}
    const enToHi = this.getEnglishToHindiTranslations()
    Object.entries(enToHi).forEach(([en, hi]) => {
      hindiToEn[hi] = en
    })
    return hindiToEn
  }

  private static getSpanishToEnglishTranslations(): Record<string, string> {
    const spanishToEn: Record<string, string> = {}
    const enToEs = this.getEnglishToSpanishTranslations()
    Object.entries(enToEs).forEach(([en, es]) => {
      spanishToEn[es] = en
    })
    return spanishToEn
  }

  private static getFrenchToEnglishTranslations(): Record<string, string> {
    const frenchToEn: Record<string, string> = {}
    const enToFr = this.getEnglishToFrenchTranslations()
    Object.entries(enToFr).forEach(([en, fr]) => {
      frenchToEn[fr] = en
    })
    return frenchToEn
  }

  private static getArabicToEnglishTranslations(): Record<string, string> {
    const arabicToEn: Record<string, string> = {}
    const enToAr = this.getEnglishToArabicTranslations()
    Object.entries(enToAr).forEach(([en, ar]) => {
      arabicToEn[ar] = en
    })
    return arabicToEn
  }

  // Generate multilingual response
  static async generateMultilingualResponse(
    userMessage: string,
    aiResponse: string,
    detectedLanguage?: string
  ): Promise<MultilingualResponse> {
    try {
      // Detect user's language if not provided
      if (!detectedLanguage) {
        const detection = this.detectLanguage(userMessage)
        detectedLanguage = detection.language
      }
      
      const isSupported = detectedLanguage in this.supportedLanguages
      
      // If user wrote in English or unsupported language, respond in English
      if (detectedLanguage === 'en' || !isSupported) {
        return {
          originalLanguage: detectedLanguage,
          responseInOriginal: aiResponse,
          responseInEnglish: aiResponse,
          supportedLanguage: detectedLanguage === 'en' || isSupported
        }
      }
      
      // Translate response to user's language
      const translation = await this.translateText(aiResponse, detectedLanguage, 'en')
      
      return {
        originalLanguage: detectedLanguage,
        responseInOriginal: translation.translatedText,
        responseInEnglish: aiResponse,
        supportedLanguage: true
      }
    } catch (error) {
      logger.error({ error, userMessage, detectedLanguage }, 'Error generating multilingual response')
      
      // Fallback to English
      return {
        originalLanguage: detectedLanguage || 'unknown',
        responseInOriginal: aiResponse,
        responseInEnglish: aiResponse,
        supportedLanguage: false
      }
    }
  }

  // Get greeting in user's language
  static getLocalizedGreeting(language: string, agentName: string): string {
    const greetings: Record<string, string> = {
      'en': `Hello! I'm ${agentName} from Circle's customer support team. How can I assist you today?`,
      'hi': `नमस्ते! मैं ${agentName} हूं Circle की ग्राहक सहायता टीम से। आज मैं आपकी कैसे सहायता कर सकता हूं?`,
      'es': `¡Hola! Soy ${agentName} del equipo de soporte al cliente de Circle. ¿Cómo puedo ayudarte hoy?`,
      'fr': `Bonjour! Je suis ${agentName} de l'équipe de support client de Circle. Comment puis-je vous aider aujourd'hui?`,
      'de': `Hallo! Ich bin ${agentName} vom Circle Kundensupport-Team. Wie kann ich Ihnen heute helfen?`,
      'pt': `Olá! Eu sou ${agentName} da equipe de suporte ao cliente do Circle. Como posso ajudá-lo hoje?`,
      'ru': `Привет! Я ${agentName} из команды поддержки клиентов Circle. Как я могу помочь вам сегодня?`,
      'ar': `مرحبا! أنا ${agentName} من فريق دعم العملاء في Circle. كيف يمكنني مساعدتك اليوم؟`,
      'ja': `こんにちは！私はCircleのカスタマーサポートチームの${agentName}です。今日はどのようにお手伝いできますか？`,
      'ko': `안녕하세요! 저는 Circle 고객 지원팀의 ${agentName}입니다. 오늘 어떻게 도와드릴까요?`,
      'zh': `你好！我是Circle客户支持团队的${agentName}。今天我可以为您提供什么帮助？`
    }
    
    return greetings[language] || greetings['en']
  }

  // Check if language is supported
  static isLanguageSupported(language: string): boolean {
    return language in this.supportedLanguages
  }

  // Get all supported languages
  static getSupportedLanguages(): typeof MultilingualSupportService.supportedLanguages {
    return this.supportedLanguages
  }

  // Format text for RTL languages
  static formatForRTL(text: string, language: string): string {
    const langInfo = this.supportedLanguages[language as keyof typeof this.supportedLanguages]
    
    if (langInfo?.rtl) {
      // Add RTL markers for proper text direction
      return `\u202B${text}\u202C`
    }
    
    return text
  }
}

export default MultilingualSupportService
