#!/usr/bin/env python3
"""
Test ML Matching with Diverse Real-World Prompts
Tests emotional support, casual relationships, education, career, health, etc.
"""

import requests
import json

SERVICE_URL = "http://localhost:8090"
API_KEY = "Orincore7094"
REAL_USER_ID = "28657024-3670-49c6-926c-7308c93d4941"

def test_single_best_match(prompt: str, description: str):
    """Test with single best match mode"""
    print(f"\n{'='*80}")
    print(f"TEST: {description}")
    print(f"{'='*80}")
    print(f"📝 Prompt: \"{prompt}\"")
    print("-" * 80)
    
    try:
        headers = {"X-API-Key": API_KEY, "Content-Type": "application/json"}
        payload = {
            "user_id": REAL_USER_ID,
            "prompt": prompt,
            "latitude": 28.6139,
            "longitude": 77.2090,
            "limit": 1,
            "single_best_match": True
        }
        
        response = requests.post(f"{SERVICE_URL}/api/ml/match", json=payload, headers=headers, timeout=30)
        
        if response.status_code == 200:
            data = response.json()
            matches = data.get("matches", [])
            
            print(f"✅ SUCCESS")
            print(f"   Processing Time: {data.get('processing_time_ms', 0):.2f}ms")
            print(f"   Candidates Evaluated: {data.get('total_candidates', 0)}")
            
            if matches:
                match = matches[0]
                score = match.get('match_score', 0)
                
                # Determine match quality
                if score >= 70:
                    quality = "⭐ EXCELLENT MATCH"
                elif score >= 50:
                    quality = "✅ VERY GOOD MATCH"
                elif score >= 30:
                    quality = "👍 GOOD MATCH"
                else:
                    quality = "⚠️ FAIR MATCH"
                
                print(f"\n🎯 BEST MATCH FOUND: {quality}")
                print(f"{'─'*80}")
                print(f"   Name: {match.get('name', 'Unknown')}")
                print(f"   Score: {score:.1f}/100")
                print(f"   Age: {match.get('age', 'N/A')} | Gender: {match.get('gender', 'N/A')}")
                
                if match.get('bio'):
                    bio = match['bio'][:150] + "..." if len(match['bio']) > 150 else match['bio']
                    print(f"   Bio: {bio}")
                
                if match.get('interests'):
                    print(f"   Interests: {', '.join(match['interests'][:5])}")
                
                if match.get('needs'):
                    print(f"   Needs: {', '.join(match['needs'][:3])}")
                
                return True
            else:
                print(f"\n   ⚠️ No confident match found")
                print(f"   💡 Try adjusting your search criteria")
                return False
        else:
            print(f"❌ ERROR: {response.status_code}")
            print(f"   {response.text}")
            return False
    except Exception as e:
        print(f"❌ ERROR: {e}")
        return False

# Run diverse tests
print("\n" + "="*80)
print("  🚀 ML MATCHING - DIVERSE USE CASE TESTING")
print("  Testing: Emotional Support, Casual, Education, Career, Health, LGBTQ+")
print("="*80)

results = []

# Test 1: Emotional Support
results.append(test_single_best_match(
    "I need someone who can help me in emotion way",
    "Emotional Support"
))

# Test 2: Casual Relationship
results.append(test_single_best_match(
    "I need someone only for hookup no serious relationship",
    "Casual/Hookup"
))

# Test 3: Education - Coding Help
results.append(test_single_best_match(
    "I need someone from age 21 near who can help me in coding",
    "Education - Coding Help"
))

# Test 4: LGBTQ+ Casual
results.append(test_single_best_match(
    "I need a gay gender person who can have casual relationship with me",
    "LGBTQ+ Casual Relationship"
))

# Test 5: Music Interest
results.append(test_single_best_match(
    "looking for someone who loves music and can jam with me",
    "Music Interest"
))

# Test 6: Art & Creative
results.append(test_single_best_match(
    "find someone who is into art and painting",
    "Art & Creative"
))

# Test 7: Career Advice
results.append(test_single_best_match(
    "I need someone who can give me career advice and mentorship",
    "Career Mentorship"
))

# Summary
print(f"\n{'='*80}")
print("  📊 TEST SUMMARY")
print(f"{'='*80}")

passed = sum(results)
total = len(results)

print(f"\n   Tests Passed: {passed}/{total}")
print(f"   Success Rate: {(passed/total*100):.1f}%")

if passed >= total * 0.7:
    print(f"\n   ✅ System is working well for diverse use cases!")
else:
    print(f"\n   ⚠️ Some use cases need improvement")

print(f"\n{'='*80}")
print("  ✅ TESTING COMPLETE")
print(f"{'='*80}\n")
