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
        
        # Head pose thresholds
        self.TURN_LEFT_THRESHOLD = -15
        self.TURN_RIGHT_THRESHOLD = 15
        self.TURN_UP_THRESHOLD = -10
        self.TURN_DOWN_THRESHOLD = 10
        
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
        """
        cap = cv2.VideoCapture(video_path)
        
        if not cap.isOpened():
            return {
                'verified': False,
                'reason': 'Could not open video file',
                'movements_detected': [],
                'confidence': 0.0
            }
        
        detected_movements = set()
        frame_count = 0
        face_detected_frames = 0
        movement_frames = {movement: 0 for movement in self.required_movements}
        
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
                
                # Detect movement
                movement = self.detect_movement(yaw, pitch)
                
                if movement in self.required_movements:
                    detected_movements.add(movement)
                    movement_frames[movement] += 1
        
        cap.release()
        
        # Calculate confidence based on:
        # 1. Face detection rate
        # 2. All movements detected
        # 3. Sufficient frames for each movement
        
        face_detection_rate = face_detected_frames / max(frame_count, 1)
        all_movements_detected = len(detected_movements) == len(self.required_movements)
        
        # Check if each movement was held for at least 5 frames
        sufficient_movement_frames = all(
            movement_frames[m] >= 5 for m in self.required_movements
        )
        
        confidence = 0.0
        if face_detection_rate > 0.5:
            confidence += 0.3
        if all_movements_detected:
            confidence += 0.4
        if sufficient_movement_frames:
            confidence += 0.3
        
        verified = (
            face_detection_rate > 0.5 and
            all_movements_detected and
            sufficient_movement_frames
        )
        
        return {
            'verified': verified,
            'confidence': round(confidence, 2),
            'movements_detected': list(detected_movements),
            'movements_required': self.required_movements,
            'face_detection_rate': round(face_detection_rate, 2),
            'total_frames': frame_count,
            'face_frames': face_detected_frames,
            'movement_frame_counts': movement_frames,
            'reason': self._get_failure_reason(
                face_detection_rate,
                all_movements_detected,
                sufficient_movement_frames,
                detected_movements
            )
        }
    
    def _get_failure_reason(
        self,
        face_detection_rate: float,
        all_movements: bool,
        sufficient_frames: bool,
        detected: set
    ) -> str:
        """
        Generate human-readable failure reason
        """
        if face_detection_rate <= 0.5:
            return 'Face not clearly visible in video'
        
        if not all_movements:
            missing = set(self.required_movements) - detected
            return f'Missing movements: {", ".join(missing)}'
        
        if not sufficient_frames:
            return 'Movements too quick - hold each position longer'
        
        return 'Verification successful'
