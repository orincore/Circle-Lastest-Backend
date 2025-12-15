#!/usr/bin/env python3
"""Expanded prompt tests (10-15 cases) against real DB, single best match mode."""

import requests

SERVICE_URL = "http://localhost:8090"
API_KEY = "Orincore7094"
REAL_USER_ID = "28657024-3670-49c6-926c-7308c93d4941"

PROMPTS = [
  ("music", "Find someone who loves music and singing"),
  ("music+photo", "Looking for someone between 20 and 25 who loves music and photography"),
  ("art+painting", "Find someone who is into art and painting"),
  ("drawing", "Find a person who enjoys drawing and sketching"),
  ("videography", "Find someone who is into videography and photography"),
  ("coding", "I need someone near age 21 who can help me in coding"),
  ("webdev", "Looking for someone who does web development or app development"),
  ("career", "I need someone who can give me career advice and mentorship"),
  ("emotional", "I need someone who can help me in an emotional way and listen"),
  ("casual", "I need someone only for hookup no serious relationship"),
  ("friendship", "I want a friend to hang out and chill"),
  ("fitness", "Find a gym or fitness workout partner"),
  ("travel", "Find someone who loves travel and adventure"),
]


def call(prompt: str):
  payload = {
    "user_id": REAL_USER_ID,
    "prompt": prompt,
    "latitude": 28.6139,
    "longitude": 77.2090,
    "limit": 1,
    "single_best_match": True,
  }
  r = requests.post(
    f"{SERVICE_URL}/api/ml/match",
    json=payload,
    headers={"X-API-Key": API_KEY, "Content-Type": "application/json"},
    timeout=30,
  )
  return r.status_code, r.json() if r.headers.get('content-type','').startswith('application/json') else r.text


print("\n== Expanded Prompt Tests ==\n")
passed = 0
for key, prompt in PROMPTS:
  status, data = call(prompt)
  ok = status == 200
  print(f"\n[{key}] {prompt}")
  if not ok:
    print(f"  ERROR {status}: {data}")
    continue
  matches = data.get('matches', [])
  if not matches:
    print("  No match returned")
    continue
  m = matches[0]
  passed += 1
  print(f"  -> {m.get('name')} | age={m.get('age')} gender={m.get('gender')} score={m.get('match_score')}")
  if m.get('interests'):
    print(f"     interests: {', '.join(m.get('interests')[:6])}")

print(f"\nReturned a best match for {passed}/{len(PROMPTS)} prompts")
