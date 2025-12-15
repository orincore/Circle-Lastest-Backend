#!/usr/bin/env python3
"""
Fetch real user IDs from database for testing
"""

from supabase import create_client
import os
from dotenv import load_dotenv

load_dotenv()

SUPABASE_URL = os.getenv('SUPABASE_URL')
SUPABASE_SERVICE_ROLE_KEY = os.getenv('SUPABASE_SERVICE_ROLE_KEY')

def get_real_users():
    """Fetch real user IDs from the database"""
    try:
        client = create_client(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
        
        # Fetch a few real users
        response = client.table('profiles').select(
            'id, first_name, last_name, age, gender, about, interests, needs'
        ).is_('deleted_at', 'null').limit(10).execute()
        
        if response.data:
            print(f"\n✅ Found {len(response.data)} users in database\n")
            print("Sample Users:")
            print("-" * 80)
            
            for i, user in enumerate(response.data[:5], 1):
                print(f"\n{i}. User ID: {user['id']}")
                print(f"   Name: {user.get('first_name', '')} {user.get('last_name', '')}")
                print(f"   Age: {user.get('age', 'N/A')}, Gender: {user.get('gender', 'N/A')}")
                if user.get('about'):
                    bio = user['about'][:100] + "..." if len(user['about']) > 100 else user['about']
                    print(f"   Bio: {bio}")
                if user.get('interests'):
                    print(f"   Interests: {', '.join(user['interests'][:3])}")
            
            return response.data
        else:
            print("❌ No users found in database")
            return []
            
    except Exception as e:
        print(f"❌ Error fetching users: {e}")
        return []

if __name__ == "__main__":
    print("\n🔍 Fetching real users from Supabase database...")
    users = get_real_users()
    
    if users:
        print(f"\n\n📝 Use this user ID for testing:")
        print(f"   {users[0]['id']}")
        print(f"\n💡 Total users in database: {len(users)}")
    else:
        print("\n⚠️  Database appears to be empty or connection failed")
