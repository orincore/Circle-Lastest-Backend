"""
Circle ML Matching Service
FastAPI-based service for intelligent prompt-based user matching
Uses ML/NLP techniques to find optimal matches based on user profiles and preferences
"""

from fastapi import FastAPI, HTTPException, Depends, Header
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from typing import List, Optional, Dict, Any
import os
import numpy as np
from datetime import datetime
import logging
from contextlib import asynccontextmanager
import json
from supabase import create_client, Client
from dotenv import load_dotenv

# Load environment variables
load_dotenv()

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

# Supabase client
supabase_client: Optional[Client] = None

# Environment variables
SUPABASE_URL = os.getenv('SUPABASE_URL', 'https://cwccjihrjmbhyaafwjuf.supabase.co')
SUPABASE_SERVICE_ROLE_KEY = os.getenv('SUPABASE_SERVICE_ROLE_KEY', 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImN3Y2NqaWhyam1iaHlhYWZ3anVmIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc1ODk3MTAyMywiZXhwIjoyMDc0NTQ3MDIzfQ.wjO7Jr2kORr8B_neeK2U8kpgkM-ulmqerlCpqBXnJ3c')
INTERNAL_API_KEY = os.getenv('INTERNAL_API_KEY', 'Orincore7094')
SERVICE_PORT = int(os.getenv('SERVICE_PORT', '8090'))

# Optional: treat users as inactive if last_active is older than N days
INACTIVE_DAYS = int(os.getenv('INACTIVE_DAYS', '45'))

# Pydantic models
class UserPreferences(BaseModel):
    max_distance: Optional[int] = Field(default=50, description="Maximum distance in km")
    age_range: Optional[List[int]] = Field(default=[18, 100], description="Age range [min, max]")
    interests: Optional[List[str]] = Field(default=[], description="User interests")
    needs: Optional[List[str]] = Field(default=[], description="User needs")
    gender_preference: Optional[str] = Field(default=None, description="Gender preference")

class MatchRequest(BaseModel):
    user_id: str = Field(..., description="ID of the user requesting matches")
    prompt: Optional[str] = Field(default=None, description="Natural language search prompt")
    preferences: Optional[UserPreferences] = Field(default=None, description="User preferences")
    latitude: Optional[float] = Field(default=None, description="User's latitude")
    longitude: Optional[float] = Field(default=None, description="User's longitude")
    limit: int = Field(default=10, description="Maximum number of matches to return")
    single_best_match: bool = Field(default=False, description="Return only the single best match")
    candidate_ids: Optional[List[str]] = Field(default=None, description="Optional list of candidate user IDs to restrict search")
    exclude_user_ids: Optional[List[str]] = Field(default=None, description="Optional list of user IDs to exclude from results")

class UserProfile(BaseModel):
    id: str
    name: str
    age: Optional[int]
    bio: Optional[str]
    interests: Optional[List[str]]
    needs: Optional[List[str]]
    latitude: Optional[float]
    longitude: Optional[float]
    gender: Optional[str]
    match_score: float = Field(default=0.0, description="Calculated match score")

class MatchResponse(BaseModel):
    success: bool
    matches: List[UserProfile]
    total_candidates: int
    processing_time_ms: float

class HealthResponse(BaseModel):
    status: str
    service: str
    timestamp: str
    database_connected: bool

# Lifespan context manager for startup/shutdown
@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup
    global supabase_client
    logger.info("Starting ML Matching Service...")
    
    try:
        # Initialize Supabase client
        if SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY:
            supabase_client = create_client(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
            logger.info("Supabase client initialized successfully")
        else:
            logger.warning("SUPABASE credentials not set, running without database")
    except Exception as e:
        logger.error(f"Failed to initialize Supabase client: {e}")
    
    yield
    
    # Shutdown
    logger.info("Shutting down ML Matching Service...")
    supabase_client = None
    logger.info("Supabase client closed")

# Initialize FastAPI app
app = FastAPI(
    title="Circle ML Matching Service",
    description="Machine Learning based user matching service",
    version="1.0.0",
    lifespan=lifespan
)

# CORS middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # In production, specify exact origins
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Authentication dependency
async def verify_api_key(x_api_key: str = Header(...)):
    if x_api_key != INTERNAL_API_KEY:
        raise HTTPException(status_code=401, detail="Invalid API key")
    return x_api_key

# Utility functions
def calculate_distance(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Calculate distance between two points using Haversine formula (in km)"""
    from math import radians, sin, cos, sqrt, atan2
    
    R = 6371  # Earth's radius in km
    
    lat1, lon1, lat2, lon2 = map(radians, [lat1, lon1, lat2, lon2])
    dlat = lat2 - lat1
    dlon = lon2 - lon1
    
    a = sin(dlat/2)**2 + cos(lat1) * cos(lat2) * sin(dlon/2)**2
    c = 2 * atan2(sqrt(a), sqrt(1-a))
    
    return R * c

def parse_prompt_requirements(prompt: str) -> Dict[str, Any]:
    """
    Advanced prompt parser for diverse connection types
    Supports:
    - Gender detection (including LGBTQ+)
    - Age ranges (exact, ranges, min/max)
    - Multiple keywords and interests
    - Location preferences
    - Skill/hobby detection
    - Relationship type (casual, serious, friendship, professional)
    - Purpose detection (emotional support, education, career, health, dating)
    - Intent analysis (hookup, relationship, mentorship, advice)
    """
    if not prompt:
        return {}
    
    import re
    prompt_lower = prompt.lower()
    requirements = {}
    
    # ===== GENDER DETECTION (Including LGBTQ+) =====
    female_terms = ['female', 'woman', 'girl', 'lady', 'she', 'her']
    male_terms = ['male', 'man', 'boy', 'guy', 'he', 'him']
    lgbtq_terms = ['gay', 'lesbian', 'queer', 'lgbt', 'lgbtq', 'non-binary', 'trans']
    
    # Check for LGBTQ+ specific requests
    if any(term in prompt_lower for term in lgbtq_terms):
        requirements['lgbtq_friendly'] = True
        if 'gay' in prompt_lower or 'lesbian' in prompt_lower:
            requirements['lgbtq_specific'] = True
    
    # IMPORTANT: DB stores gender values as lowercase (e.g. "male"/"female")
    if any(word in prompt_lower for word in female_terms):
        requirements['gender'] = 'female'
    elif any(word in prompt_lower for word in male_terms):
        requirements['gender'] = 'male'
    
    # ===== AGE DETECTION (Enhanced) =====
    # Pattern 1: Exact age with range indicators
    age_patterns = [
        (r'age\s+(\d+)', 3),           # "age 23" -> ±3
        (r'(\d+)\s+years?\s+old', 3),  # "23 years old" -> ±3
        (r'around\s+(\d+)', 4),         # "around 25" -> ±4
        (r'near\s+(\d+)', 3),           # "near 30" -> ±3
        (r'about\s+(\d+)', 4),          # "about 28" -> ±4
        (r'exactly\s+(\d+)', 1),        # "exactly 25" -> ±1
    ]
    
    for pattern, tolerance in age_patterns:
        match = re.search(pattern, prompt_lower)
        if match:
            age = int(match.group(1))
            requirements['age_range'] = [max(18, age - tolerance), min(100, age + tolerance)]
            break
    
    # Pattern 2: Age ranges "between X and Y"
    range_match = re.search(r'between\s+(\d+)\s+and\s+(\d+)', prompt_lower)
    if range_match:
        requirements['age_range'] = [int(range_match.group(1)), int(range_match.group(2))]
    
    # Pattern 3: Min/Max age "above 25", "under 30", "over 21"
    if not requirements.get('age_range'):
        min_age_match = re.search(r'(?:above|over|older than)\s+(\d+)', prompt_lower)
        max_age_match = re.search(r'(?:under|below|younger than)\s+(\d+)', prompt_lower)
        
        if min_age_match or max_age_match:
            min_age = int(min_age_match.group(1)) if min_age_match else 18
            max_age = int(max_age_match.group(1)) if max_age_match else 100
            requirements['age_range'] = [min_age, max_age]
    
    # ===== KEYWORD EXTRACTION (Enhanced) =====
    # Expanded stop words
    stop_words = {
        'find', 'me', 'a', 'an', 'the', 'who', 'can', 'help', 'in', 'with', 'at',
        'near', 'around', 'about', 'age', 'years', 'old', 'user', 'person', 'people',
        'someone', 'looking', 'for', 'want', 'need', 'would', 'could', 'should',
        'and', 'or', 'but', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
        'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'shall',
        'may', 'might', 'must', 'can', 'could', 'to', 'from', 'of', 'on', 'by'
    }
    
    # Extract words and clean them
    words = re.findall(r'\b\w+\b', prompt_lower)
    keywords = []
    
    for word in words:
        cleaned = word.strip('.,!?;:')
        if cleaned not in stop_words and len(cleaned) > 2 and not cleaned.isdigit():
            keywords.append(cleaned)
    
    # ===== SKILL/INTEREST DETECTION =====
    # Common skill/interest categories
    tech_skills = ['coding', 'programming', 'developer', 'software', 'tech', 'computer',
                   'web', 'app', 'python', 'java', 'javascript', 'data', 'ai', 'ml']
    creative_skills = ['art', 'design', 'music', 'photography', 'writing', 'creative',
                       'painting', 'drawing', 'singing', 'dancing']
    sports_fitness = ['gym', 'fitness', 'sports', 'running', 'yoga', 'workout',
                      'exercise', 'athletic', 'swimming', 'cycling']
    outdoor_activities = ['hiking', 'trekking', 'camping', 'adventure', 'travel',
                          'nature', 'outdoor', 'mountain', 'beach']
    
    detected_categories = []
    if any(skill in prompt_lower for skill in tech_skills):
        detected_categories.append('technology')
    if any(skill in prompt_lower for skill in creative_skills):
        detected_categories.append('creative')
    if any(skill in prompt_lower for skill in sports_fitness):
        detected_categories.append('fitness')
    if any(skill in prompt_lower for skill in outdoor_activities):
        detected_categories.append('outdoor')
    
    if detected_categories:
        requirements['categories'] = detected_categories
    
    # Remove duplicates and store keywords
    if keywords:
        requirements['keywords'] = list(dict.fromkeys(keywords))  # Preserve order, remove duplicates
    
    # ===== LOCATION PREFERENCES =====
    if any(word in prompt_lower for word in ['nearby', 'near me', 'close', 'local', 'same city', 'near']):
        requirements['prefer_nearby'] = True
    
    # ===== RELATIONSHIP TYPE DETECTION =====
    casual_terms = ['hookup', 'casual', 'no strings', 'fling', 'one night', 'fun', 'no serious']
    serious_terms = ['serious', 'relationship', 'long term', 'committed', 'partner', 'dating']
    friendship_terms = ['friend', 'friendship', 'buddy', 'pal', 'hang out', 'chill']
    professional_terms = ['mentor', 'professional', 'career', 'business', 'networking', 'work']
    
    if any(term in prompt_lower for term in casual_terms):
        requirements['relationship_type'] = 'casual'
        requirements['intent_weight'] = 'high'  # High priority for matching intent
    elif any(term in prompt_lower for term in serious_terms):
        requirements['relationship_type'] = 'serious'
        requirements['intent_weight'] = 'high'
    elif any(term in prompt_lower for term in friendship_terms):
        requirements['relationship_type'] = 'friendship'
    elif any(term in prompt_lower for term in professional_terms):
        requirements['relationship_type'] = 'professional'
    
    # ===== PURPOSE DETECTION =====
    emotional_terms = ['emotion', 'emotional', 'support', 'listen', 'understand', 'empathy', 'comfort']
    education_terms = ['learn', 'teach', 'education', 'study', 'tutor', 'help me in', 'guide']
    career_terms = ['career', 'job', 'professional', 'work', 'business', 'advice']
    health_terms = ['health', 'fitness', 'wellness', 'mental health', 'therapy', 'workout']
    
    purposes = []
    if any(term in prompt_lower for term in emotional_terms):
        purposes.append('emotional_support')
    if any(term in prompt_lower for term in education_terms):
        purposes.append('education')
    if any(term in prompt_lower for term in career_terms):
        purposes.append('career')
    if any(term in prompt_lower for term in health_terms):
        purposes.append('health')
    
    if purposes:
        requirements['purposes'] = purposes
        requirements['purpose_focused'] = True
    
    # ===== INTENT STRENGTH =====
    # Strong intent indicators suggest user wants very specific match
    strong_intent_terms = ['only', 'specifically', 'must', 'need', 'require', 'looking for']
    if any(term in prompt_lower for term in strong_intent_terms):
        requirements['strong_intent'] = True
    
    return requirements


def expand_prompt_keywords(prompt_requirements: Dict[str, Any]) -> List[str]:
    """Expand high-level intents (emotional/career/casual/etc.) into searchable keywords."""
    expanded: List[str] = []
    if not prompt_requirements:
        return expanded

    # Seed from extracted keywords
    expanded.extend(prompt_requirements.get('keywords', []) or [])

    # Map purposes/relationship types to concrete terms likely present in bio/interests/needs
    purpose_terms = {
        'emotional_support': [
            'emotional', 'support', 'listener', 'listening', 'empathy', 'understanding', 'caring',
            'comfort', 'therapy', 'mental', 'talk'
        ],
        'education': [
            'learn', 'teaching', 'teach', 'tutor', 'mentor', 'guide', 'study', 'education',
            'coding', 'programming', 'development'
        ],
        'career': [
            'career', 'job', 'work', 'professional', 'mentor', 'mentorship', 'advice', 'business'
        ],
        'health': [
            'health', 'fitness', 'workout', 'gym', 'wellness', 'mental', 'therapy'
        ],
    }

    rel_terms = {
        'casual': ['casual', 'hookup', 'fun', 'fling', 'no strings'],
        'serious': ['serious', 'relationship', 'long term', 'committed', 'partner', 'dating'],
        'friendship': ['friend', 'friendship', 'buddy', 'hangout', 'chill'],
        'professional': ['professional', 'career', 'mentor', 'networking', 'business'],
    }

    for p in (prompt_requirements.get('purposes') or []):
        expanded.extend(purpose_terms.get(p, []))

    rt = prompt_requirements.get('relationship_type')
    if rt:
        expanded.extend(rel_terms.get(rt, []))

    # Remove duplicates, preserve order
    return list(dict.fromkeys([w for w in expanded if isinstance(w, str) and w.strip()]))


def compute_criteria_coverage(prompt_requirements: Optional[Dict[str, Any]], candidate: Dict[str, Any]) -> float:
    """Return fraction (0..1) of high-level criteria satisfied by candidate."""
    if not prompt_requirements:
        return 0.0

    total = 0
    satisfied = 0

    # Gender criterion
    if prompt_requirements.get('gender'):
        total += 1
        cand_gender = (candidate.get('gender') or '').strip().lower()
        if cand_gender and cand_gender == prompt_requirements['gender']:
            satisfied += 1

    # Age range criterion
    if prompt_requirements.get('age_range'):
        total += 1
        age = candidate.get('age')
        if isinstance(age, int):
            lo, hi = prompt_requirements['age_range']
            if lo <= age <= hi:
                satisfied += 1

    # Keyword criterion (use expanded keywords)
    expanded_keywords = expand_prompt_keywords(prompt_requirements)
    if expanded_keywords:
        total += 1
        km = calculate_keyword_match(expanded_keywords, candidate, prompt_requirements)
        if km >= 0.60:
            satisfied += 1

    if total == 0:
        return 0.0
    return satisfied / total

def calculate_text_similarity(text1: Optional[str], text2: Optional[str]) -> float:
    """Calculate simple text similarity using word overlap (0-1)"""
    if not text1 or not text2:
        return 0.0
    
    words1 = set(text1.lower().split())
    words2 = set(text2.lower().split())
    
    if not words1 or not words2:
        return 0.0
    
    intersection = words1.intersection(words2)
    union = words1.union(words2)
    
    return len(intersection) / len(union) if union else 0.0

def calculate_keyword_match(keywords: List[str], profile: Dict[str, Any], prompt_requirements: Optional[Dict[str, Any]] = None) -> float:
    """
    Highly accurate keyword matching with weighted scoring
    Prioritizes exact matches in interests over bio mentions
    """
    if not keywords:
        return 0.0
    
    interests_text = ' '.join([i.lower() for i in profile.get('interests', [])]) if profile.get('interests') else ''
    needs_text = ' '.join([n.lower() for n in profile.get('needs', [])]) if profile.get('needs') else ''
    bio_text = profile.get('bio', '').lower() if profile.get('bio') else ''
    
    if not (interests_text or needs_text or bio_text):
        return 0.0
    
    # Comprehensive synonym mapping for diverse use cases
    synonyms = {
        # Technical/Education
        'coding': ['programming', 'developer', 'software', 'code', 'development', 'engineer', 'tech'],
        'programming': ['coding', 'developer', 'software', 'development', 'engineer', 'tech'],
        'teaching': ['teacher', 'mentor', 'education', 'tutor', 'instructor', 'guide', 'coach'],
        'learning': ['study', 'education', 'student', 'knowledge', 'training'],
        
        # Fitness/Health
        'gym': ['fitness', 'workout', 'exercise', 'bodybuilding', 'training', 'athletic'],
        'fitness': ['gym', 'workout', 'exercise', 'health', 'training', 'athletic', 'wellness'],
        'health': ['wellness', 'fitness', 'healthy', 'wellbeing', 'medical'],
        
        # Emotional/Support
        'emotional': ['emotion', 'feelings', 'empathy', 'support', 'understanding', 'caring'],
        'support': ['help', 'assist', 'guidance', 'advice', 'counseling', 'listening'],
        'listening': ['listener', 'understanding', 'empathy', 'support', 'caring'],
        
        # Relationship Types
        'casual': ['hookup', 'fun', 'fling', 'no strings', 'relaxed'],
        'serious': ['committed', 'relationship', 'long term', 'partner', 'dating'],
        'friendship': ['friend', 'buddy', 'pal', 'companion', 'hang out'],
        
        # Career/Professional
        'career': ['professional', 'job', 'work', 'business', 'employment'],
        'mentor': ['guide', 'advisor', 'coach', 'teacher', 'counselor'],
        'advice': ['guidance', 'help', 'suggestion', 'recommendation', 'tips'],
        
        # Creative/Arts
        'music': ['musical', 'musician', 'singing', 'songs', 'melody', 'tune', 'performer'],
        'art': ['artistic', 'artist', 'creative', 'painting', 'drawing', 'design'],
        'photography': ['photo', 'photographer', 'pictures', 'camera', 'videography'],
        'design': ['designer', 'creative', 'art', 'graphic', 'ui', 'ux', 'artistic'],
        
        # Activities
        'travel': ['traveling', 'trip', 'vacation', 'adventure', 'explore', 'wanderlust'],
        'hiking': ['trekking', 'mountain', 'outdoor', 'nature', 'trail', 'adventure'],
    }
    
    total_score = 0.0
    max_possible = len(keywords)
    
    for keyword in keywords:
        keyword_score = 0.0
        
        # Priority 1: Exact match in interests (highest weight)
        if keyword in interests_text:
            keyword_score = 1.0
        # Priority 2: Synonym match in interests
        elif keyword in synonyms:
            if any(syn in interests_text for syn in synonyms[keyword]):
                keyword_score = 0.9
        # Priority 3: Exact match in needs
        elif keyword in needs_text:
            keyword_score = 0.8
        # Priority 4: Synonym in needs
        elif keyword in synonyms and any(syn in needs_text for syn in synonyms[keyword]):
            keyword_score = 0.7
        # Priority 5: Exact match in bio
        elif keyword in bio_text:
            keyword_score = 0.6
        # Priority 6: Synonym in bio
        elif keyword in synonyms and any(syn in bio_text for syn in synonyms[keyword]):
            keyword_score = 0.5
        # Priority 7: Partial match (last resort)
        elif any(keyword in word for word in (interests_text + ' ' + needs_text + ' ' + bio_text).split()):
            keyword_score = 0.3
        
        total_score += keyword_score
    
    return min(1.0, total_score / max_possible)

def calculate_list_similarity(list1: Optional[List[str]], list2: Optional[List[str]]) -> float:
    """Calculate similarity between two lists (0-1)"""
    if not list1 or not list2:
        return 0.0
    
    set1 = set([item.lower() for item in list1])
    set2 = set([item.lower() for item in list2])
    
    if not set1 or not set2:
        return 0.0
    
    intersection = set1.intersection(set2)
    union = set1.union(set2)
    
    return len(intersection) / len(union) if union else 0.0

def calculate_match_score(
    user: Dict[str, Any],
    candidate: Dict[str, Any],
    preferences: Optional[UserPreferences],
    prompt: Optional[str],
    prompt_requirements: Optional[Dict[str, Any]] = None
) -> float:
    """
    Calculate comprehensive match score using multiple factors
    Returns score between 0-100
    Enhanced with prompt requirement matching
    """
    score = 0.0
    
    # Adjust weights based on whether we have prompt requirements
    if prompt_requirements and prompt_requirements.get('keywords'):
        # When we have specific requirements from prompt, heavily prioritize keyword matches
        # This ensures users with matching interests get much higher scores
        if prompt_requirements.get('prefer_nearby'):
            weights = {
                'prompt_keywords': 0.50,  # VERY HIGH priority for prompt keywords
                'distance': 0.20,         # Boost for nearby preference
                'interests': 0.15,
                'needs': 0.08,
                'bio': 0.05,
                'age': 0.02
            }
        else:
            weights = {
                'prompt_keywords': 0.55,  # DOMINANT weight for keyword matching
                'interests': 0.20,        # Secondary - general interest compatibility
                'needs': 0.10,
                'age': 0.08,
                'distance': 0.05,
                'bio': 0.02
            }
    else:
        # Standard weights
        weights = {
            'interests': 0.30,
            'needs': 0.25,
            'bio': 0.15,
            'distance': 0.15,
            'age': 0.10,
            'prompt': 0.05
        }
    
    # Prompt keyword matching (highest priority)
    if prompt_requirements:
        expanded_keywords = expand_prompt_keywords(prompt_requirements)
        if expanded_keywords:
            keyword_match = calculate_keyword_match(expanded_keywords, candidate, prompt_requirements)
        else:
            keyword_match = 0.0
        keyword_contribution = keyword_match * weights['prompt_keywords'] * 100
        score += keyword_contribution
        
        # Boost score for users with multiple keyword matches
        if keyword_match >= 0.8:  # 80%+ keywords matched
            score += 15  # Higher bonus for excellent match
        elif keyword_match >= 0.6:  # 60%+ keywords matched
            score += 10  # Good bonus for very good match
        elif keyword_match >= 0.4:  # 40%+ keywords matched
            score += 5   # Bonus for decent match
        
        # Extra boost for strong intent matches (user said "need", "only", "must")
        if prompt_requirements.get('strong_intent') and keyword_match >= 0.6:
            score += 10  # User has strong intent and we found good match
        
        # Boost score for purpose-focused matches (emotional support, education, etc.)
        if prompt_requirements.get('purpose_focused') and keyword_match >= 0.5:
            score += 8  # Purpose-driven connections are important
        
        logger.info(f"Keyword match for {candidate.get('id')}: {keyword_match:.2f} (contribution: {keyword_contribution:.1f})")
    
    # Interest similarity
    if user.get('interests') and candidate.get('interests'):
        interests_sim = calculate_list_similarity(user['interests'], candidate['interests'])
        score += interests_sim * weights['interests'] * 100
    
    # Needs similarity
    if user.get('needs') and candidate.get('needs'):
        needs_sim = calculate_list_similarity(user['needs'], candidate['needs'])
        score += needs_sim * weights['needs'] * 100
    
    # Bio similarity
    if user.get('bio') and candidate.get('bio'):
        bio_sim = calculate_text_similarity(user['bio'], candidate['bio'])
        score += bio_sim * weights['bio'] * 100
    
    # Distance score (closer is better)
    if (user.get('latitude') and user.get('longitude') and 
        candidate.get('latitude') and candidate.get('longitude')):
        distance = calculate_distance(
            user['latitude'], user['longitude'],
            candidate['latitude'], candidate['longitude']
        )
        max_distance = preferences.max_distance if preferences else 50
        distance_score = max(0, 1 - (distance / max_distance))
        score += distance_score * weights['distance'] * 100
    
    # Age compatibility
    if user.get('age') and candidate.get('age'):
        age_diff = abs(user['age'] - candidate['age'])
        age_score = max(0, 1 - (age_diff / 20))  # 20 year difference = 0 score
        score += age_score * weights['age'] * 100
    
    # Legacy prompt matching (if no requirements extracted)
    if prompt and not prompt_requirements and candidate.get('bio'):
        prompt_sim = calculate_text_similarity(prompt, candidate['bio'])
        score += prompt_sim * weights.get('prompt', 0.15) * 100
    
    return min(100.0, score)

async def fetch_user_profile(user_id: str) -> Optional[Dict[str, Any]]:
    """Fetch user profile from database"""
    if not supabase_client:
        return None
    
    try:
        response = supabase_client.table('profiles').select(
            'id, first_name, last_name, age, about, interests, needs, latitude, longitude, gender, created_at'
        ).eq('id', user_id).maybe_single().execute()
        
        if response.data:
            profile = response.data
            # Combine first_name and last_name into name
            profile['name'] = f"{profile.get('first_name', '')} {profile.get('last_name', '')}".strip()
            profile['bio'] = profile.get('about', '')
            return profile
        return None
    except Exception as e:
        logger.error(f"Error fetching user profile {user_id}: {e}")
        return None

async def fetch_candidate_profiles(
    user_id: str,
    preferences: Optional[UserPreferences],
    prompt_requirements: Optional[Dict[str, Any]] = None,
    candidate_ids: Optional[List[str]] = None,
    exclude_user_ids: Optional[List[str]] = None,
    limit: int = 100
) -> List[Dict[str, Any]]:
    """Fetch potential match candidates from database with prompt-based filtering"""
    if not supabase_client:
        return []
    
    try:
        # Build query with filters - exclude deleted and suspended accounts
        query = supabase_client.table('profiles').select(
            'id, first_name, last_name, age, about, interests, needs, latitude, longitude, gender, created_at, is_suspended, deleted_at, last_active'
        ).neq('id', user_id).is_('deleted_at', 'null')

        if candidate_ids:
            # Restrict to Beacon-enabled candidates provided by Node.js
            query = query.in_('id', candidate_ids)
        
        # Apply prompt requirements first (highest priority)
        if prompt_requirements:
            # Gender from prompt
            if prompt_requirements.get('gender'):
                # gender is normalized to lowercase ("male"/"female")
                query = query.eq('gender', prompt_requirements['gender'])
                logger.info(f"Filtering by gender: {prompt_requirements['gender']}")
            
            # Age range from prompt
            if prompt_requirements.get('age_range'):
                query = query.gte('age', prompt_requirements['age_range'][0]).lte('age', prompt_requirements['age_range'][1])
                logger.info(f"Filtering by age: {prompt_requirements['age_range']}")
        
        # Apply user preferences (secondary priority)
        if preferences:
            # Only apply if not already filtered by prompt
            if not prompt_requirements or not prompt_requirements.get('age_range'):
                if preferences.age_range:
                    query = query.gte('age', preferences.age_range[0]).lte('age', preferences.age_range[1])
            
            # Only apply if not already filtered by prompt
            if not prompt_requirements or not prompt_requirements.get('gender'):
                if preferences.gender_preference:
                    query = query.eq('gender', preferences.gender_preference.strip().lower())
        
        # Limit results - fetch many more candidates for better matching
        # Increase from 2x to 10x to ensure we find matches
        query = query.limit(min(limit * 10, 500))  # Cap at 500 for performance
        
        response = query.execute()
        
        # Transform data to match expected format and apply robust filtering
        profiles = []
        for profile in response.data:
            if exclude_user_ids and profile.get('id') in exclude_user_ids:
                continue

            # Exclude deleted/suspended (robust against nulls and varying types)
            if profile.get('deleted_at') is not None:
                continue
            is_suspended = profile.get('is_suspended')
            if is_suspended is True or str(is_suspended).lower() == 'true':
                continue

            # Exclude inactive users if last_active is present and too old
            last_active = profile.get('last_active')
            if last_active:
                try:
                    from datetime import datetime, timezone, timedelta
                    # Supabase typically returns ISO strings
                    if isinstance(last_active, str):
                        # Handle trailing 'Z'
                        la = datetime.fromisoformat(last_active.replace('Z', '+00:00'))
                    elif isinstance(last_active, datetime):
                        la = last_active
                    else:
                        la = None

                    if la is not None:
                        if la.tzinfo is None:
                            la = la.replace(tzinfo=timezone.utc)
                        cutoff = datetime.now(timezone.utc) - timedelta(days=INACTIVE_DAYS)
                        if la < cutoff:
                            continue
                except Exception:
                    # If parsing fails, don't exclude
                    pass

            profile['name'] = f"{profile.get('first_name', '')} {profile.get('last_name', '')}".strip()
            profile['bio'] = profile.get('about', '')
            profiles.append(profile)
        
        logger.info(f"Fetched {len(profiles)} candidate profiles")
        return profiles
            
    except Exception as e:
        logger.error(f"Error fetching candidate profiles: {e}")
        return []

# API Endpoints
@app.get("/health", response_model=HealthResponse)
async def health_check():
    """Health check endpoint"""
    return HealthResponse(
        status="healthy",
        service="ml-matching",
        timestamp=datetime.utcnow().isoformat(),
        database_connected=supabase_client is not None
    )

@app.post("/api/ml/match", response_model=MatchResponse, dependencies=[Depends(verify_api_key)])
async def find_matches(request: MatchRequest):
    """
    Find optimal matches for a user using ML-based scoring
    Supports both preference-based and prompt-based matching
    Enhanced with natural language prompt parsing
    """
    start_time = datetime.now()
    
    try:
        # Parse prompt to extract requirements
        prompt_requirements = None
        if request.prompt:
            prompt_requirements = parse_prompt_requirements(request.prompt)
            logger.info(f"Parsed prompt requirements: {prompt_requirements}")
        
        # Fetch requesting user's profile
        user_profile = await fetch_user_profile(request.user_id)
        if not user_profile:
            raise HTTPException(status_code=404, detail="User profile not found")
        
        # Fetch candidate profiles with prompt-based filtering
        # Fetch many more candidates to ensure we find matches
        candidates = await fetch_candidate_profiles(
            request.user_id,
            request.preferences,
            prompt_requirements,
            candidate_ids=request.candidate_ids,
            exclude_user_ids=request.exclude_user_ids,
            limit=max(request.limit * 20, 100)  # Fetch at least 100 candidates
        )
        
        if not candidates:
            return MatchResponse(
                success=True,
                matches=[],
                total_candidates=0,
                processing_time_ms=0.0
            )
        
        # Calculate match scores for all candidates
        scored_candidates = []
        for candidate in candidates:
            # Apply distance filter if location is available
            if (request.latitude and request.longitude and 
                candidate.get('latitude') and candidate.get('longitude')):
                distance = calculate_distance(
                    request.latitude, request.longitude,
                    candidate['latitude'], candidate['longitude']
                )
                max_dist = request.preferences.max_distance if request.preferences else 50
                if distance > max_dist:
                    continue
            
            # Calculate match score with prompt requirements
            score = calculate_match_score(
                user_profile,
                candidate,
                request.preferences,
                request.prompt,
                prompt_requirements
            )

            # Criteria coverage (how many core constraints are satisfied)
            coverage = compute_criteria_coverage(prompt_requirements, candidate) if prompt_requirements else 0.0
            
            # Filtering logic:
            # - Prefer candidates meeting >=60% of extracted criteria
            # - Otherwise keep best-scoring candidates as fallback (so we never return empty when users exist)
            if prompt_requirements:
                # If we extracted any criteria, prioritize coverage
                if coverage >= 0.60:
                    scored_candidates.append({
                        **candidate,
                        'match_score': score,
                        'criteria_coverage': coverage,
                    })
                else:
                    # Keep weaker candidates only if they have some signal (avoid totally irrelevant)
                    if score >= 10.0:
                        scored_candidates.append({
                            **candidate,
                            'match_score': score,
                            'criteria_coverage': coverage,
                        })
            else:
                if score >= 5.0:
                    scored_candidates.append({
                        **candidate,
                        'match_score': score,
                        'criteria_coverage': coverage,
                    })
        
        # Sort by (coverage desc, score desc)
        scored_candidates.sort(key=lambda x: (x.get('criteria_coverage', 0.0), x['match_score']), reverse=True)

        # If we have prompt requirements, prefer candidates that satisfy >=60% of criteria
        if prompt_requirements:
            strong = [c for c in scored_candidates if c.get('criteria_coverage', 0.0) >= 0.60]
            if strong:
                scored_candidates = strong
        
        # If single best match requested, return only the top match
        if request.single_best_match and scored_candidates:
            top_matches = scored_candidates[:1]
            logger.info(
                f"Single best match mode: Returning best match score {scored_candidates[0]['match_score']:.1f} "
                f"coverage {scored_candidates[0].get('criteria_coverage', 0.0):.2f}"
            )
        else:
            top_matches = scored_candidates[:request.limit]
        
        # Convert to response format
        matches = [
            UserProfile(
                id=m['id'],
                name=m['name'],
                age=m.get('age'),
                bio=m.get('bio'),
                interests=m.get('interests'),
                needs=m.get('needs'),
                latitude=m.get('latitude'),
                longitude=m.get('longitude'),
                gender=m.get('gender'),
                match_score=round(m['match_score'], 2)
            )
            for m in top_matches
        ]
        
        # Calculate processing time
        processing_time = (datetime.now() - start_time).total_seconds() * 1000
        
        logger.info(f"Found {len(matches)} matches for user {request.user_id} in {processing_time:.2f}ms")
        if prompt_requirements:
            logger.info(f"Applied prompt requirements: {prompt_requirements}")
        
        return MatchResponse(
            success=True,
            matches=matches,
            total_candidates=len(candidates),
            processing_time_ms=round(processing_time, 2)
        )
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error in find_matches: {e}")
        raise HTTPException(status_code=500, detail=f"Internal server error: {str(e)}")

@app.get("/")
async def root():
    """Root endpoint"""
    return {
        "service": "Circle ML Matching Service",
        "version": "1.0.0",
        "status": "running",
        "endpoints": {
            "health": "/health",
            "match": "/api/ml/match"
        }
    }

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(
        app,
        host="0.0.0.0",
        port=SERVICE_PORT,
        log_level="info"
    )
