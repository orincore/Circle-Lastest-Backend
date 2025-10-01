#!/bin/bash

# Circle App - S3 Integration Installation Script
# This script installs required dependencies for S3 file uploads

echo "🚀 Installing S3 Integration Dependencies..."
echo ""

# Check if we're in the Backend directory
if [ ! -f "package.json" ]; then
    echo "❌ Error: package.json not found. Please run this script from the Backend directory."
    exit 1
fi

# Install multer and its types
echo "📦 Installing multer and @types/multer..."
npm install multer @types/multer

# Check if installation was successful
if [ $? -eq 0 ]; then
    echo ""
    echo "✅ Dependencies installed successfully!"
    echo ""
    echo "📋 Next Steps:"
    echo "1. Set up AWS S3 bucket (see S3_SETUP.md for instructions)"
    echo "2. Add AWS credentials to .env file:"
    echo "   AWS_REGION=us-east-1"
    echo "   AWS_S3_BUCKET=your-bucket-name"
    echo "   AWS_ACCESS_KEY_ID=your-access-key"
    echo "   AWS_SECRET_ACCESS_KEY=your-secret-key"
    echo "3. Restart your backend server: npm run dev"
    echo "4. Test upload: curl -X POST http://localhost:8080/api/upload/profile-photo -H 'Authorization: Bearer TOKEN' -F 'photo=@image.jpg'"
    echo ""
    echo "📖 For detailed setup instructions, see: Backend/S3_SETUP.md"
else
    echo ""
    echo "❌ Installation failed. Please check the error messages above."
    exit 1
fi
