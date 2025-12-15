#!/usr/bin/env python3
"""
Standalone test script for ML Matching Service
Tests the service without requiring database connection
"""

import requests
import json
import time
from typing import Dict, Any

# Configuration
SERVICE_URL = "http://localhost:8090"
API_KEY = "Orincore7094"

def test_health_check():
    """Test health check endpoint"""
    print("\n=== Testing Health Check ===")
    try:
        response = requests.get(f"{SERVICE_URL}/health")
        print(f"Status Code: {response.status_code}")
        print(f"Response: {json.dumps(response.json(), indent=2)}")
        return response.status_code == 200
    except Exception as e:
        print(f"Error: {e}")
        return False

def test_root_endpoint():
    """Test root endpoint"""
    print("\n=== Testing Root Endpoint ===")
    try:
        response = requests.get(f"{SERVICE_URL}/")
        print(f"Status Code: {response.status_code}")
        print(f"Response: {json.dumps(response.json(), indent=2)}")
        return response.status_code == 200
    except Exception as e:
        print(f"Error: {e}")
        return False

def test_match_endpoint_without_auth():
    """Test match endpoint without authentication (should fail)"""
    print("\n=== Testing Match Endpoint (No Auth) ===")
    try:
        payload = {
            "user_id": "test-user-123",
            "prompt": "Looking for someone who loves hiking and photography",
            "limit": 5
        }
        response = requests.post(
            f"{SERVICE_URL}/api/ml/match",
            json=payload
        )
        print(f"Status Code: {response.status_code}")
        print(f"Response: {json.dumps(response.json(), indent=2)}")
        return response.status_code == 401  # Should be unauthorized
    except Exception as e:
        print(f"Error: {e}")
        return False

def test_match_endpoint_with_auth():
    """Test match endpoint with authentication"""
    print("\n=== Testing Match Endpoint (With Auth) ===")
    try:
        payload = {
            "user_id": "test-user-123",
            "prompt": "Looking for someone who loves hiking and photography",
            "preferences": {
                "max_distance": 50,
                "age_range": [25, 35],
                "interests": ["hiking", "photography", "travel"],
                "needs": ["adventure", "creativity"]
            },
            "latitude": 28.6139,
            "longitude": 77.2090,
            "limit": 10
        }
        headers = {
            "X-API-Key": API_KEY,
            "Content-Type": "application/json"
        }
        response = requests.post(
            f"{SERVICE_URL}/api/ml/match",
            json=payload,
            headers=headers
        )
        print(f"Status Code: {response.status_code}")
        print(f"Response: {json.dumps(response.json(), indent=2)}")
        return response.status_code in [200, 404]  # 404 if user not found in DB
    except Exception as e:
        print(f"Error: {e}")
        return False

def test_performance():
    """Test service performance"""
    print("\n=== Testing Performance ===")
    try:
        payload = {
            "user_id": "test-user-123",
            "limit": 10
        }
        headers = {
            "X-API-Key": API_KEY,
            "Content-Type": "application/json"
        }
        
        # Warm-up request
        requests.post(f"{SERVICE_URL}/api/ml/match", json=payload, headers=headers)
        
        # Performance test
        num_requests = 10
        start_time = time.time()
        
        for i in range(num_requests):
            response = requests.post(
                f"{SERVICE_URL}/api/ml/match",
                json=payload,
                headers=headers
            )
        
        end_time = time.time()
        avg_time = ((end_time - start_time) / num_requests) * 1000
        
        print(f"Average response time: {avg_time:.2f}ms ({num_requests} requests)")
        return True
    except Exception as e:
        print(f"Error: {e}")
        return False

def run_all_tests():
    """Run all tests"""
    print("=" * 60)
    print("ML Matching Service - Test Suite")
    print("=" * 60)
    
    tests = [
        ("Health Check", test_health_check),
        ("Root Endpoint", test_root_endpoint),
        ("Match Endpoint (No Auth)", test_match_endpoint_without_auth),
        ("Match Endpoint (With Auth)", test_match_endpoint_with_auth),
        ("Performance Test", test_performance)
    ]
    
    results = []
    for test_name, test_func in tests:
        try:
            result = test_func()
            results.append((test_name, result))
        except Exception as e:
            print(f"Test '{test_name}' crashed: {e}")
            results.append((test_name, False))
    
    # Summary
    print("\n" + "=" * 60)
    print("Test Summary")
    print("=" * 60)
    for test_name, result in results:
        status = "✓ PASS" if result else "✗ FAIL"
        print(f"{status} - {test_name}")
    
    passed = sum(1 for _, result in results if result)
    total = len(results)
    print(f"\nTotal: {passed}/{total} tests passed")
    print("=" * 60)

if __name__ == "__main__":
    print("Make sure the ML Matching Service is running on port 8090")
    print("Start it with: python app.py")
    input("\nPress Enter to start tests...")
    run_all_tests()
