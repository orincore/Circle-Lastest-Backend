#!/usr/bin/env python3
"""Test database connection"""
import asyncio
import asyncpg
import os
from dotenv import load_dotenv

load_dotenv()

async def test_connection():
    # Try different connection formats
    urls = [
        os.getenv('DATABASE_URL'),
        'postgresql://postgres.cwccjihrjmbhyaafwjuf:Orincore7094@aws-0-ap-south-1.pooler.supabase.com:5432/postgres',
        'postgresql://postgres:Orincore7094@aws-0-ap-south-1.pooler.supabase.com:6543/postgres?pgbouncer=true',
    ]
    
    for i, url in enumerate(urls, 1):
        print(f"\n{i}. Testing: {url[:50]}...")
        try:
            conn = await asyncpg.connect(url, timeout=10)
            result = await conn.fetchval('SELECT 1')
            print(f"   ✓ SUCCESS! Result: {result}")
            
            # Test profiles table
            count = await conn.fetchval('SELECT COUNT(*) FROM profiles')
            print(f"   ✓ Profiles count: {count}")
            
            await conn.close()
            print(f"   ✓ This connection works!")
            return url
        except Exception as e:
            print(f"   ✗ FAILED: {e}")
    
    return None

if __name__ == "__main__":
    print("Testing Supabase Database Connections...")
    result = asyncio.run(test_connection())
    if result:
        print(f"\n✓ Working connection: {result}")
    else:
        print("\n✗ No working connection found")
