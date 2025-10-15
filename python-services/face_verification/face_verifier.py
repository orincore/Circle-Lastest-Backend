"""
Face Verification Service
Analyzes video for head movements (left, right, up, down) to verify real person
"""

import cv2
import mediapipe as mp
import numpy as np
from typing import Dict, List, Tuple
import tempfile
import os

class FaceVerifier:
    def __init__(self):
        self.mp_face_mesh = mp.solutions.face_mesh
        self.face_mesh = self.mp_face_mesh.FaceMesh(
            max_num_faces=1,
            refine_landmarks=True,
            min_detection_confidence=0.5,
            min_tracking_confidence=0.5
        )
        
        # Head pose thresholds (more sensitive)
        self.TURN_LEFT_THRESHOLD = -10  # Reduced from -15 for easier detection
        self.TURN_RIGHT_THRESHOLD = 10  # Reduced from 15 for easier detection
        self.TURN_UP_THRESHOLD = -8     # Reduced from -10 for easier detection
        self.TURN_DOWN_THRESHOLD = 8    # Reduced from 10 for easier detection
        
        # Required movements
        self.required_movements = ['left', 'right', 'up', 'down']
        
    def get_head_pose(self, landmarks, image_shape) -> Tuple[float, float, float]:
        """
        Calculate head pose (yaw, pitch, roll) from facial landmarks
        """
        img_h, img_w = image_shape[:2]
        
        # Key facial landmarks for pose estimation
        # Nose tip, chin, left eye corner, right eye corner, left mouth, right mouth
        face_3d = []
        face_2d = []
        
        # Indices for key landmarks
        key_indices = [1, 33, 61, 199, 263, 291]
        
        for idx in key_indices:
            lm = landmarks[idx]
            x, y = int(lm.x * img_w), int(lm.y * img_h)
            face_2d.append([x, y])
            face_3d.append([x, y, lm.z])
        
        face_2d = np.array(face_2d, dtype=np.float64)
        face_3d = np.array(face_3d, dtype=np.float64)
        
        # Camera matrix
        focal_length = 1 * img_w
        cam_matrix = np.array([
            [focal_length, 0, img_w / 2],
            [0, focal_length, img_h / 2],
            [0, 0, 1]
        ])
        
        # Distortion coefficients
        dist_matrix = np.zeros((4, 1), dtype=np.float64)
        
        # Solve PnP
        success, rot_vec, trans_vec = cv2.solvePnP(
            face_3d, face_2d, cam_matrix, dist_matrix
        )
        
        # Get rotational matrix
        rmat, jac = cv2.Rodrigues(rot_vec)
        
        # Get angles
        angles, mtxR, mtxQ, Qx, Qy, Qz = cv2.RQDecomp3x3(rmat)
        
        # Get the y rotation degree (yaw)
        yaw = angles[1] * 360
        pitch = angles[0] * 360
        roll = angles[2] * 360
        
        return yaw, pitch, roll
    
    def detect_movement(self, yaw: float, pitch: float) -> str:
        """
        Detect which direction the head is turned
        """
        if yaw < self.TURN_LEFT_THRESHOLD:
            return 'left'
        elif yaw > self.TURN_RIGHT_THRESHOLD:
            return 'right'
        elif pitch < self.TURN_UP_THRESHOLD:
            return 'up'
        elif pitch > self.TURN_DOWN_THRESHOLD:
            return 'down'
        return 'center'
    
    def verify_video(self, video_path: str) -> Dict:
        """
        Analyze video for required head movements
        Returns verification result with details
        Processes the ENTIRE video before making a decision
        """
        cap = cv2.VideoCapture(video_path)
        
        if not cap.isOpened():
            return {
                'verified': False,
                'reason': 'Could not open video file',
                'movements_detected': [],
                'confidence': 0.0
            }
        
        # Get video properties
        fps = cap.get(cv2.CAP_PROP_FPS)
        total_frames_in_video = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
        video_duration = total_frames_in_video / fps if fps > 0 else 0
        
        print(f"📹 Starting video analysis...")
        print(f"   Duration: {video_duration:.1f}s, FPS: {fps:.1f}, Total frames: {total_frames_in_video}")
        
        detected_movements = set()
        frame_count = 0
        face_detected_frames = 0
        movement_frames = {movement: 0 for movement in self.required_movements}
        yaw_values = []
        pitch_values = []
        
        while cap.isOpened():
            ret, frame = cap.read()
            if not ret:
                break
            
            frame_count += 1
            
            # Convert to RGB
            rgb_frame = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
            results = self.face_mesh.process(rgb_frame)
            
            if results.multi_face_landmarks:
                face_detected_frames += 1
                landmarks = results.multi_face_landmarks[0].landmark
                
                # Get head pose
                yaw, pitch, roll = self.get_head_pose(landmarks, frame.shape)
                
                # Store values for analysis
                yaw_values.append(yaw)
                pitch_values.append(pitch)
                
                # Detect movement
                movement = self.detect_movement(yaw, pitch)
                
                # Debug: Print pose values every 30 frames
                if frame_count % 30 == 0:
                    print(f"   Frame {frame_count}/{total_frames_in_video}: yaw={yaw:.1f}°, pitch={pitch:.1f}°, movement={movement}")
                
                if movement in self.required_movements:
                    detected_movements.add(movement)
                    movement_frames[movement] += 1
        
        cap.release()
        
        # Log completion
        print(f"✅ Video analysis complete!")
        print(f"   Processed: {frame_count}/{total_frames_in_video} frames ({frame_count/total_frames_in_video*100:.1f}%)")
        print(f"   Face detected: {face_detected_frames} frames ({face_detection_rate*100:.1f}%)")
        print(f"   Movements detected: {list(detected_movements)}")
        print(f"   Movement frame counts: {movement_frames}")
        
        # Calculate yaw/pitch ranges to verify movements
        if yaw_values and pitch_values:
            yaw_range = max(yaw_values) - min(yaw_values)
            pitch_range = max(pitch_values) - min(pitch_values)
            print(f"   Yaw range: {yaw_range:.1f}° (min: {min(yaw_values):.1f}°, max: {max(yaw_values):.1f}°)")
            print(f"   Pitch range: {pitch_range:.1f}° (min: {min(pitch_values):.1f}°, max: {max(pitch_values):.1f}°)")
        
        # Ensure we processed the complete video
        frames_processed_percentage = (frame_count / total_frames_in_video * 100) if total_frames_in_video > 0 else 0
        
        # Check minimum video duration (at least 5 seconds)
        if video_duration < 5:
            print(f"❌ Video too short: {video_duration:.1f}s (minimum 5s required)")
            return {
                'verified': False,
                'confidence': 0.0,
                'movements_detected': list(detected_movements),
                'movements_required': self.required_movements,
                'face_detection_rate': round(face_detection_rate, 2),
                'total_frames': frame_count,
                'face_frames': face_detected_frames,
                'movement_frame_counts': movement_frames,
                'reason': f'Video too short: {video_duration:.1f}s (minimum 5s required)',
                'video_duration': round(video_duration, 1)
            }
        
        # Calculate confidence based on:
        # 1. Face detection rate
        # 2. All movements detected
        # 3. Sufficient frames for each movement
        # 4. Complete video processed
        
        face_detection_rate = face_detected_frames / max(frame_count, 1)
        all_movements_detected = len(detected_movements) == len(self.required_movements)
        
        # Check if each movement was held for at least 3 frames
        sufficient_movement_frames = all(
            movement_frames[m] >= 3 for m in self.required_movements
        )
        
        # Ensure we processed at least 90% of the video
        complete_video_processed = frames_processed_percentage >= 90
        
        confidence = 0.0
        if face_detection_rate > 0.5:
            confidence += 0.3
        if all_movements_detected:
            confidence += 0.4
        if sufficient_movement_frames:
            confidence += 0.2
        if complete_video_processed:
            confidence += 0.1
        
        verified = (
            face_detection_rate > 0.5 and
            all_movements_detected and
            sufficient_movement_frames and
            complete_video_processed
        )
        
        # Get failure reason
        failure_reason = self._get_failure_reason(
            face_detection_rate,
            all_movements_detected,
            sufficient_movement_frames,
            complete_video_processed,
            detected_movements,
            movement_frames
        )
        
        # Log decision
        print(f"\n{'✅ VERIFIED' if verified else '❌ REJECTED'}")
        print(f"   Confidence: {confidence:.2f}")
        print(f"   Reason: {failure_reason if not verified else 'All checks passed'}")
        
        return {
            'verified': verified,
            'confidence': round(confidence, 2),
            'movements_detected': list(detected_movements),
            'movements_required': self.required_movements,
            'face_detection_rate': round(face_detection_rate, 2),
            'total_frames': frame_count,
            'face_frames': face_detected_frames,
            'movement_frame_counts': movement_frames,
            'reason': failure_reason,
            'video_duration': round(video_duration, 1),
            'frames_processed_percentage': round(frames_processed_percentage, 1)
        }
    
    def _get_failure_reason(
        self,
        face_detection_rate: float,
        all_movements: bool,
        sufficient_frames: bool,
        complete_video: bool,
        detected: set,
        movement_frames: dict
    ) -> str:
        """
        Generate human-readable failure reason
        """
        reasons = []
        
        if face_detection_rate < 0.5:
            reasons.append(f"Poor face detection: {face_detection_rate*100:.0f}% (need >50%)")
        
        if not all_movements:
            missing = set(self.required_movements) - detected
            reasons.append(f"Missing movements: {', '.join(missing)}")
        
        if not sufficient_frames:
            insufficient = [m for m in self.required_movements if movement_frames[m] < 3]
            reasons.append(f"Movements not held long enough: {', '.join(insufficient)}")
        
        if not complete_video:
            reasons.append("Video processing incomplete")
        
        if not reasons:
            return "Verification successful"
        
        return "; ".join(reasons)
