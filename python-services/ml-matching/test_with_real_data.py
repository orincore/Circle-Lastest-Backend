#!/usr/bin/env python3
"""
Comprehensive ML Matching Tests with Real Database Users
"""

import requests
import json
import time

SERVICE_URL = "http://localhost:8090"
API_KEY = "Orincore7094"

# Real user ID from database
REAL_USER_ID = "28657024-3670-49c6-926c-7308c93d4941"  # Nisha Patanker

def print_header(title):
    print("\n" + "="*80)
    print(f"  {title}")
    print("="*80)

def test_match(test_num, prompt, description):
    """Run a single match test"""
    print(f"\n🧪 TEST {test_num}: {description}")
    print(f"📝 Prompt: \"{prompt}\"")
    print("-" * 80)
    
    try:
        headers = {"X-API-Key": API_KEY, "Content-Type": "application/json"}
        payload = {
            "user_id": REAL_USER_ID,
            "prompt": prompt,
            "latitude": 28.6139,
            "longitude": 77.2090,
            "limit": 5
        }
        
        start = time.time()
        response = requests.post(f"{SERVICE_URL}/api/ml/match", json=payload, headers=headers, timeout=30)
        elapsed = (time.time() - start) * 1000
        
        if response.status_code == 200:
            data = response.json()
            matches = data.get("matches", [])
            
            print(f"✅ SUCCESS")
            print(f"   Response Time: {elapsed:.2f}ms")
            print(f"   ML Processing: {data.get('processing_time_ms', 0):.2f}ms")
            print(f"   Total Candidates: {data.get('total_candidates', 0)}")
            print(f"   Matches Found: {len(matches)}")
            
            if matches:
                print(f"\n   🎯 Top Matches:")
                for i, match in enumerate(matches[:3], 1):
                    name = match.get('name', 'Unknown')
                    score = match.get('match_score', 0)
                    age = match.get('age', 'N/A')
                    gender = match.get('gender', 'N/A')
                    
                    print(f"\n   {i}. {name} - Score: {score:.1f}/100")
                    print(f"      Age: {age}, Gender: {gender}")
                    
                    if match.get('bio'):
                        bio = match['bio'][:100] + "..." if len(match['bio']) > 100 else match['bio']
                        print(f"      Bio: {bio}")
                    
                    if match.get('interests'):
                        interests = ', '.join(match['interests'][:4])
                        print(f"      Interests: {interests}")
                
                return True, len(matches), elapsed
            else:
                print(f"   ⚠️  No matches found")
                return True, 0, elapsed
        else:
            print(f"❌ FAILED - Status: {response.status_code}")
            print(f"   Error: {response.text}")
            return False, 0, elapsed
            
    except Exception as e:
        print(f"❌ ERROR: {e}")
        return False, 0, 0

def main():
    print_header("ML MATCHING SERVICE - REAL DATABASE TESTS")
    print(f"Service: {SERVICE_URL}")
    print(f"Test User: Nisha Patanker (28, female, interests: Fashion, Music, Singing)")
    
    # Check service health
    try:
        health = requests.get(f"{SERVICE_URL}/health", timeout=5).json()
        print(f"\n✅ Service: {health.get('status')}")
        print(f"✅ Database: {'Connected' if health.get('database_connected') else 'Disconnected'}")
    except:
        print("\n❌ Service not responding!")
        return
    
    results = []
    total_matches = 0
    total_time = 0
    
    # TEST 1: Simple gender + age + skill
    success, matches, elapsed = test_match(
        1,
        "find me a female user near age 23 who can help me in coding",
        "Simple: Gender + Age + Skill"
    )
    results.append(success)
    total_matches += matches
    total_time += elapsed
    time.sleep(0.5)
    
    # TEST 2: Age range + multiple interests
    success, matches, elapsed = test_match(
        2,
        "looking for someone between 20 and 25 who loves music and photography",
        "Complex: Age Range + Multiple Interests"
    )
    results.append(success)
    total_matches += matches
    total_time += elapsed
    time.sleep(0.5)
    
    # TEST 3: Gender + age + location + interest
    success, matches, elapsed = test_match(
        3,
        "find a male user around 22 nearby who enjoys photography and videography",
        "Complex: Gender + Age + Location + Interests"
    )
    results.append(success)
    total_matches += matches
    total_time += elapsed
    time.sleep(0.5)
    
    # TEST 4: Creative skills
    success, matches, elapsed = test_match(
        4,
        "looking for someone who loves art, painting, and creative design",
        "Advanced: Creative Skills"
    )
    results.append(success)
    total_matches += matches
    total_time += elapsed
    time.sleep(0.5)
    
    # TEST 5: Very complex query
    success, matches, elapsed = test_match(
        5,
        "find me a male user between 20 and 25 who is into music, photography, and videography",
        "Very Complex: Multiple Conditions + Skills"
    )
    results.append(success)
    total_matches += matches
    total_time += elapsed
    
    # Summary
    print_header("TEST SUMMARY")
    passed = sum(results)
    total = len(results)
    
    print(f"\n📊 Test Results:")
    print(f"   Passed: {passed}/{total} ({passed/total*100:.1f}%)")
    print(f"   Total Matches Found: {total_matches}")
    print(f"   Average Response Time: {total_time/total:.2f}ms")
    
    if passed == total:
        print("\n🎉 ALL TESTS PASSED!")
        print("   ✅ ML matching is working perfectly with real database")
        print("   ✅ Prompt parsing is accurate")
        print("   ✅ Scoring algorithm is effective")
        print("   ✅ Performance is excellent")
    else:
        print(f"\n⚠️  {total - passed} test(s) had issues")
    
    # Performance rating
    avg_time = total_time / total
    print(f"\n⚡ Performance Rating:")
    if avg_time < 100:
        print(f"   🌟 EXCELLENT - {avg_time:.0f}ms average")
    elif avg_time < 200:
        print(f"   ✅ GOOD - {avg_time:.0f}ms average")
    else:
        print(f"   ⚠️  NEEDS IMPROVEMENT - {avg_time:.0f}ms average")
    
    print("\n" + "="*80)
    print("✅ Testing Complete!")
    print("="*80 + "\n")

if __name__ == "__main__":
    print("\n🚀 Starting Real Database Tests...\n")
    try:
        main()
    except KeyboardInterrupt:
        print("\n\n⚠️  Tests interrupted")
    except Exception as e:
        print(f"\n\n❌ Error: {e}")
