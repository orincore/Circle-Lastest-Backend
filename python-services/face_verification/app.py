"""
Flask API for Face Verification Service
Receives video, verifies face movements, returns result
"""

from flask import Flask, request, jsonify
import os
import tempfile
import boto3
from werkzeug.utils import secure_filename
from face_verifier import FaceVerifier
from dotenv import load_dotenv

load_dotenv()

app = Flask(__name__)
app.config['MAX_CONTENT_LENGTH'] = 50 * 1024 * 1024  # 50MB max file size

# Initialize face verifier
verifier = FaceVerifier()

# S3 client
s3_client = boto3.client(
    's3',
    aws_access_key_id=os.getenv('AWS_ACCESS_KEY_ID'),
    aws_secret_access_key=os.getenv('AWS_SECRET_ACCESS_KEY'),
    region_name=os.getenv('AWS_REGION', 'ap-south-1')
)

BUCKET_NAME = os.getenv('S3_BUCKET_NAME', 'circle-verification-videos')

@app.route('/health', methods=['GET'])
def health():
    """Health check endpoint"""
    return jsonify({'status': 'healthy', 'service': 'face-verification'}), 200

@app.route('/verify', methods=['POST'])
def verify_face():
    """
    Verify face from uploaded video
    Expects: multipart/form-data with 'video' file and 'user_id'
    """
    try:
        # Check if video file is present
        if 'video' not in request.files:
            return jsonify({
                'error': 'No video file provided'
            }), 400
        
        video_file = request.files['video']
        user_id = request.form.get('user_id')
        
        if not user_id:
            return jsonify({
                'error': 'user_id is required'
            }), 400
        
        if video_file.filename == '':
            return jsonify({
                'error': 'No video file selected'
            }), 400
        
        # Save video temporarily
        with tempfile.NamedTemporaryFile(delete=False, suffix='.mp4') as temp_file:
            video_file.save(temp_file.name)
            temp_path = temp_file.name
        
        try:
            # Upload to S3 first (for backup/audit)
            s3_key = f'verification-videos/{user_id}/{os.path.basename(temp_path)}'
            s3_client.upload_file(temp_path, BUCKET_NAME, s3_key)
            
            # Verify the video
            result = verifier.verify_video(temp_path)
            
            # If verification successful, delete from S3
            if result['verified']:
                try:
                    s3_client.delete_object(Bucket=BUCKET_NAME, Key=s3_key)
                    result['video_deleted'] = True
                except Exception as e:
                    print(f'Failed to delete S3 object: {e}')
                    result['video_deleted'] = False
            else:
                # Keep failed verification videos for review
                result['video_s3_key'] = s3_key
                result['video_deleted'] = False
            
            return jsonify(result), 200
            
        finally:
            # Clean up temp file
            if os.path.exists(temp_path):
                os.unlink(temp_path)
    
    except Exception as e:
        print(f'Error during verification: {str(e)}')
        return jsonify({
            'error': 'Verification failed',
            'details': str(e)
        }), 500

@app.route('/delete-video', methods=['POST'])
def delete_video():
    """
    Delete verification video from S3
    Used when verification is approved by admin
    """
    try:
        data = request.get_json()
        s3_key = data.get('s3_key')
        
        if not s3_key:
            return jsonify({'error': 's3_key is required'}), 400
        
        s3_client.delete_object(Bucket=BUCKET_NAME, Key=s3_key)
        
        return jsonify({
            'success': True,
            'message': 'Video deleted successfully'
        }), 200
    
    except Exception as e:
        return jsonify({
            'error': 'Failed to delete video',
            'details': str(e)
        }), 500

if __name__ == '__main__':
    # Run on port 5000 (internal service)
    app.run(host='0.0.0.0', port=5000, debug=False)
