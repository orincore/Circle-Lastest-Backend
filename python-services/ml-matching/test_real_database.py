#!/usr/bin/env python3
"""
Comprehensive Test Suite for ML Matching Service
Tests with real database queries to verify functionality
"""

import requests
import json
import time
from typing import Dict, List, Any

# Configuration
SERVICE_URL = "http://localhost:8090"
API_KEY = "Orincore7094"

def print_section(title: str):
    """Print a formatted section header"""
    print("\n" + "="*80)
    print(f"  {title}")
    print("="*80)

def print_test(test_num: int, prompt: str):
    """Print test information"""
    print(f"\n🧪 TEST {test_num}: {prompt}")
    print("-" * 80)

def test_ml_match(prompt: str, user_id: str = "test-user-123", limit: int = 5) -> Dict[str, Any]:
    """Send a match request to the ML service"""
    try:
        headers = {
            "X-API-Key": API_KEY,
            "Content-Type": "application/json"
        }
        
        payload = {
            "user_id": user_id,
            "prompt": prompt,
            "latitude": 28.6139,
            "longitude": 77.2090,
            "limit": limit
        }
        
        start_time = time.time()
        response = requests.post(
            f"{SERVICE_URL}/api/ml/match",
            json=payload,
            headers=headers,
            timeout=30
        )
        elapsed = (time.time() - start_time) * 1000
        
        if response.status_code == 200:
            data = response.json()
            return {
                "success": True,
                "data": data,
                "elapsed_ms": elapsed,
                "status_code": 200
            }
        else:
            return {
                "success": False,
                "error": response.text,
                "status_code": response.status_code,
                "elapsed_ms": elapsed
            }
    except Exception as e:
        return {
            "success": False,
            "error": str(e),
            "status_code": 0
        }

def analyze_results(result: Dict[str, Any], test_num: int):
    """Analyze and display test results"""
    if not result["success"]:
        print(f"❌ TEST {test_num} FAILED")
        print(f"   Error: {result.get('error', 'Unknown error')}")
        print(f"   Status Code: {result.get('status_code', 'N/A')}")
        return False
    
    data = result["data"]
    matches = data.get("matches", [])
    
    print(f"✅ TEST {test_num} PASSED")
    print(f"   Response Time: {result['elapsed_ms']:.2f}ms")
    print(f"   Total Candidates: {data.get('total_candidates', 0)}")
    print(f"   Matches Found: {len(matches)}")
    print(f"   Processing Time: {data.get('processing_time_ms', 0):.2f}ms")
    
    if matches:
        print(f"\n   📊 Top Matches:")
        for i, match in enumerate(matches[:3], 1):
            print(f"   {i}. {match.get('name', 'Unknown')} (Score: {match.get('match_score', 0):.1f})")
            print(f"      Age: {match.get('age', 'N/A')}, Gender: {match.get('gender', 'N/A')}")
            if match.get('bio'):
                bio_preview = match['bio'][:80] + "..." if len(match['bio']) > 80 else match['bio']
                print(f"      Bio: {bio_preview}")
            if match.get('interests'):
                print(f"      Interests: {', '.join(match['interests'][:3])}")
    else:
        print(f"   ⚠️  No matches found (this might be expected if database is empty)")
    
    return True

def run_comprehensive_tests():
    """Run 5 comprehensive tests with different complexity levels"""
    
    print_section("ML MATCHING SERVICE - COMPREHENSIVE TEST SUITE")
    print("Testing with real database queries...")
    print(f"Service URL: {SERVICE_URL}")
    print(f"API Key: {API_KEY[:10]}...")
    
    # Check service health first
    try:
        health = requests.get(f"{SERVICE_URL}/health", timeout=5)
        if health.status_code == 200:
            health_data = health.json()
            print(f"\n✅ Service Status: {health_data.get('status', 'unknown')}")
            print(f"   Database Connected: {health_data.get('database_connected', False)}")
        else:
            print(f"\n❌ Service health check failed: {health.status_code}")
            return
    except Exception as e:
        print(f"\n❌ Cannot connect to service: {e}")
        return
    
    results = []
    
    # ========== TEST 1: Simple Gender + Age + Skill ==========
    print_test(1, "Simple: Gender + Age + Skill")
    prompt1 = "find me a female user near age 23 who can help me in coding"
    result1 = test_ml_match(prompt1)
    results.append(analyze_results(result1, 1))
    
    time.sleep(0.5)
    
    # ========== TEST 2: Age Range + Multiple Interests ==========
    print_test(2, "Complex: Age Range + Multiple Interests")
    prompt2 = "looking for someone between 25 and 30 who loves hiking and photography"
    result2 = test_ml_match(prompt2)
    results.append(analyze_results(result2, 2))
    
    time.sleep(0.5)
    
    # ========== TEST 3: Gender + Age + Location + Interest ==========
    print_test(3, "Complex: Gender + Age + Location + Interest")
    prompt3 = "find a male user around 28 nearby who enjoys fitness and gym"
    result3 = test_ml_match(prompt3)
    results.append(analyze_results(result3, 3))
    
    time.sleep(0.5)
    
    # ========== TEST 4: Multiple Skills + Creative Category ==========
    print_test(4, "Advanced: Multiple Skills + Creative")
    prompt4 = "looking for someone who loves music, art, and creative design around age 26"
    result4 = test_ml_match(prompt4)
    results.append(analyze_results(result4, 4))
    
    time.sleep(0.5)
    
    # ========== TEST 5: Very Complex Query ==========
    print_test(5, "Very Complex: Multiple Conditions")
    prompt5 = "find me a female user between 22 and 27 who is into technology, coding, and teaching, preferably nearby"
    result5 = test_ml_match(prompt5, limit=10)
    results.append(analyze_results(result5, 5))
    
    # ========== SUMMARY ==========
    print_section("TEST SUMMARY")
    passed = sum(results)
    total = len(results)
    
    print(f"\n📊 Results: {passed}/{total} tests passed")
    print(f"   Success Rate: {(passed/total*100):.1f}%")
    
    if passed == total:
        print("\n🎉 ALL TESTS PASSED! ML Matching Service is working perfectly!")
    elif passed > 0:
        print(f"\n⚠️  {total - passed} test(s) failed. Check logs for details.")
    else:
        print("\n❌ ALL TESTS FAILED. Service may not be working correctly.")
    
    # ========== PERFORMANCE ANALYSIS ==========
    if result1["success"]:
        print_section("PERFORMANCE ANALYSIS")
        avg_response = (result1["elapsed_ms"] + result2["elapsed_ms"] + 
                       result3["elapsed_ms"] + result4["elapsed_ms"] + 
                       result5["elapsed_ms"]) / 5
        print(f"\n⚡ Average Response Time: {avg_response:.2f}ms")
        
        if avg_response < 100:
            print("   ✅ Excellent performance!")
        elif avg_response < 200:
            print("   ✅ Good performance")
        else:
            print("   ⚠️  Performance could be improved")
    
    print("\n" + "="*80)
    print("Test suite completed!")
    print("="*80 + "\n")

if __name__ == "__main__":
    print("\n🚀 Starting ML Matching Service Test Suite...")
    print("Make sure the service is running on port 8090\n")
    
    try:
        run_comprehensive_tests()
    except KeyboardInterrupt:
        print("\n\n⚠️  Tests interrupted by user")
    except Exception as e:
        print(f"\n\n❌ Test suite error: {e}")
