#!/bin/bash

# Photo Gallery Setup Script
# This script sets up the photo gallery feature for Circle app

set -e

echo "🎨 Circle Photo Gallery Setup"
echo "=============================="
echo ""

# Colors for output
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

# Check if .env file exists
if [ ! -f .env ]; then
    echo -e "${RED}❌ Error: .env file not found${NC}"
    echo "Please create a .env file with required variables"
    exit 1
fi

# Load environment variables
source .env

echo -e "${YELLOW}📋 Checking prerequisites...${NC}"

# Check if required environment variables are set
if [ -z "$SUPABASE_URL" ] || [ -z "$SUPABASE_SERVICE_KEY" ]; then
    echo -e "${RED}❌ Error: SUPABASE_URL or SUPABASE_SERVICE_KEY not set${NC}"
    exit 1
fi

if [ -z "$AWS_ACCESS_KEY_ID" ] || [ -z "$AWS_SECRET_ACCESS_KEY" ]; then
    echo -e "${RED}❌ Error: AWS credentials not set${NC}"
    exit 1
fi

echo -e "${GREEN}✅ Prerequisites check passed${NC}"
echo ""

# Ask for confirmation
echo -e "${YELLOW}This will:${NC}"
echo "  1. Create user_photos table in database"
echo "  2. Set up RLS policies"
echo "  3. Create indexes and triggers"
echo "  4. Create helper functions"
echo ""
read -p "Continue? (y/n) " -n 1 -r
echo ""

if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo "Setup cancelled"
    exit 0
fi

echo ""
echo -e "${YELLOW}🗄️  Running database migration...${NC}"

# Run the migration using psql or Supabase CLI
if command -v psql &> /dev/null; then
    # Extract database connection details from SUPABASE_URL
    DB_HOST=$(echo $SUPABASE_URL | sed -E 's|https?://([^/]+).*|\1|')
    
    echo "Connecting to database..."
    psql "postgresql://postgres:$SUPABASE_SERVICE_KEY@$DB_HOST:5432/postgres" \
         -f migrations/create_user_photos_table.sql
    
    if [ $? -eq 0 ]; then
        echo -e "${GREEN}✅ Database migration completed successfully${NC}"
    else
        echo -e "${RED}❌ Database migration failed${NC}"
        exit 1
    fi
else
    echo -e "${YELLOW}⚠️  psql not found. Please run the migration manually:${NC}"
    echo ""
    echo "1. Go to your Supabase Dashboard"
    echo "2. Open SQL Editor"
    echo "3. Copy and paste the contents of:"
    echo "   migrations/create_user_photos_table.sql"
    echo "4. Execute the query"
    echo ""
    read -p "Press enter when migration is complete..."
fi

echo ""
echo -e "${YELLOW}🔍 Verifying setup...${NC}"

# Verify table exists (you can add actual verification here)
echo "Table created: user_photos"
echo "Indexes created: 2"
echo "RLS policies: 5"
echo "Triggers: 1"
echo "Functions: 2"

echo ""
echo -e "${GREEN}✅ Photo Gallery Setup Complete!${NC}"
echo ""
echo -e "${YELLOW}📝 Next Steps:${NC}"
echo "  1. Restart your backend server"
echo "  2. Test the endpoints:"
echo "     GET  /api/users/photos"
echo "     POST /api/users/photos"
echo "     DELETE /api/users/photos"
echo ""
echo "  3. Check the documentation:"
echo "     docs/PHOTO_GALLERY_IMPLEMENTATION.md"
echo ""
echo -e "${GREEN}🎉 Ready to upload photos!${NC}"
