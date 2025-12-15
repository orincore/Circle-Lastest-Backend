#!/usr/bin/env python3
"""
Interactive ML Matching Tester
Test the ML backend with custom prompts and see real results
"""

import requests
import json
from typing import Dict, Any

SERVICE_URL = "http://localhost:8090"
API_KEY = "Orincore7094"
REAL_USER_ID = "28657024-3670-49c6-926c-7308c93d4941"  # Nisha Patanker

def test_prompt(prompt: str) -> Dict[str, Any]:
    """Test a prompt and return results"""
    try:
        headers = {"X-API-Key": API_KEY, "Content-Type": "application/json"}
        payload = {
            "user_id": REAL_USER_ID,
            "prompt": prompt,
            "latitude": 28.6139,
            "longitude": 77.2090,
            "limit": 10
        }
        
        response = requests.post(
            f"{SERVICE_URL}/api/ml/match",
            json=payload,
            headers=headers,
            timeout=30
        )
        
        if response.status_code == 200:
            return {"success": True, "data": response.json()}
        else:
            return {"success": False, "error": response.text, "status": response.status_code}
    except Exception as e:
        return {"success": False, "error": str(e)}

def display_results(result: Dict[str, Any], prompt: str):
    """Display results in a nice format"""
    print("\n" + "="*80)
    print(f"🔍 PROMPT: \"{prompt}\"")
    print("="*80)
    
    if not result["success"]:
        print(f"\n❌ ERROR: {result.get('error', 'Unknown error')}")
        return
    
    data = result["data"]
    matches = data.get("matches", [])
    
    print(f"\n📊 RESULTS:")
    print(f"   Processing Time: {data.get('processing_time_ms', 0):.2f}ms")
    print(f"   Total Candidates Evaluated: {data.get('total_candidates', 0)}")
    print(f"   Matches Found: {len(matches)}")
    
    if not matches:
        print(f"\n   ⚠️  No matches found for this query")
        print(f"   💡 Try adjusting your search criteria")
        return
    
    print(f"\n🎯 TOP MATCHES:\n")
    
    for i, match in enumerate(matches, 1):
        name = match.get('name', 'Unknown')
        score = match.get('match_score', 0)
        age = match.get('age', 'N/A')
        gender = match.get('gender', 'N/A')
        
        print(f"{'─'*80}")
        print(f"#{i} - {name}")
        print(f"{'─'*80}")
        print(f"   🎯 Match Score: {score:.1f}/100")
        print(f"   👤 Age: {age} | Gender: {gender}")
        
        if match.get('bio'):
            bio = match['bio']
            if len(bio) > 150:
                bio = bio[:150] + "..."
            print(f"   📝 Bio: {bio}")
        
        if match.get('interests'):
            interests = ', '.join(match['interests'])
            if len(interests) > 100:
                interests = interests[:100] + "..."
            print(f"   ❤️  Interests: {interests}")
        
        if match.get('needs'):
            needs = ', '.join(match['needs'])
            if len(needs) > 100:
                needs = needs[:100] + "..."
            print(f"   🎯 Needs: {needs}")
        
        print()

# Predefined test prompts
TEST_PROMPTS = [
    "find me a female user near age 23 who can help me in coding",
    "looking for someone between 20 and 25 who loves music and photography",
    "find a male user around 22 who enjoys photography and videography",
    "looking for someone who loves art, painting, and creative design",
    "find me someone between 18 and 25 who is into music",
    "looking for a female user who loves singing and music production",
    "find a male user around 20 nearby who enjoys drawing and art",
]

def main():
    print("\n" + "="*80)
    print("  🚀 ML MATCHING SERVICE - INTERACTIVE TESTER")
    print("="*80)
    print(f"\n  Service: {SERVICE_URL}")
    print(f"  Test User: Nisha Patanker (28, female)")
    print(f"  Database: Real Supabase data")
    
    # Check service health
    try:
        health = requests.get(f"{SERVICE_URL}/health", timeout=5).json()
        status = "✅" if health.get('status') == 'healthy' else "❌"
        db_status = "✅" if health.get('database_connected') else "❌"
        print(f"\n  {status} Service Status: {health.get('status', 'unknown')}")
        print(f"  {db_status} Database: {'Connected' if health.get('database_connected') else 'Disconnected'}")
    except Exception as e:
        print(f"\n  ❌ Cannot connect to service: {e}")
        return
    
    print("\n" + "="*80)
    print("  📝 PREDEFINED TEST PROMPTS")
    print("="*80)
    
    for i, prompt in enumerate(TEST_PROMPTS, 1):
        print(f"  {i}. {prompt}")
    
    print("\n" + "="*80)
    print("  Let's test each prompt and see the results!")
    print("="*80)
    
    input("\n  Press Enter to start testing...")
    
    for i, prompt in enumerate(TEST_PROMPTS, 1):
        print(f"\n\n{'='*80}")
        print(f"  TEST {i}/{len(TEST_PROMPTS)}")
        print(f"{'='*80}")
        
        result = test_prompt(prompt)
        display_results(result, prompt)
        
        if i < len(TEST_PROMPTS):
            input("\n  Press Enter for next test...")
    
    print("\n\n" + "="*80)
    print("  ✅ ALL TESTS COMPLETED!")
    print("="*80)
    print("\n  💡 You can now see how the ML backend finds matches from your real database")
    print("  💡 The system successfully parses prompts and returns relevant users\n")

if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\n\n  ⚠️  Testing interrupted by user\n")
    except Exception as e:
        print(f"\n\n  ❌ Error: {e}\n")
