import asyncio
import base64
import io
import json
import os
import shutil
import warnings
from typing import Optional
from pathlib import Path

# Suppress protobuf warnings
warnings.filterwarnings('ignore', message='.*SymbolDatabase.GetPrototype.*')

import cv2
import numpy as np
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from PIL import Image

from eyetrax.gaze import GazeEstimator
from eyetrax.utils.screen import get_screen_size
from eyetrax.calibration.common import compute_grid_points

app = FastAPI()

# CORS middleware for Chrome extension
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Temporary model directory
TEMP_MODEL_DIR = Path("eyemouse_temp")

# Global state for each client
class ClientSession:
    def __init__(self, client_id: str):
        self.client_id = client_id
        self.gaze_estimator = None
        self.calibration_points = []
        self.calibration_features = []
        self.is_calibrated = False
        self.screen_width, self.screen_height = get_screen_size()
        self.blink_history = []
        self.last_blink_time = 0
        self.model_path = None
        self.temp_dir = None

        # Calibration state (following EyeTrax logic)
        self.calibration_state = "idle"  # idle, wait_face, pulse, capture
        self.current_point_index = 0
        self.face_detected_start = None
        self.pulse_start = None
        self.capture_start = None
        self.is_tune_mode = False  # Track if in tune mode

        # Calibration timing (from EyeTrax)
        self.face_wait_duration = 2.0  # seconds
        self.pulse_duration = 1.0  # seconds
        self.capture_duration = 1.0  # seconds

        # Create temp directory for this client
        self.create_temp_dir()

    def create_temp_dir(self):
        """Create temporary directory for this client's models"""
        self.temp_dir = TEMP_MODEL_DIR / self.client_id
        self.temp_dir.mkdir(parents=True, exist_ok=True)
        self.model_path = self.temp_dir / "gaze_model.pkl"
        print(f"[{self.client_id}] Created temp directory: {self.temp_dir}")

    def save_model(self):
        """Save model to temp directory"""
        if self.gaze_estimator and self.is_calibrated:
            self.gaze_estimator.save_model(str(self.model_path))
            print(f"[{self.client_id}] Model saved to: {self.model_path}")
            return True
        return False

    def load_model(self):
        """Load model from temp directory"""
        if self.model_path.exists():
            self.gaze_estimator.load_model(str(self.model_path))
            self.is_calibrated = True
            print(f"[{self.client_id}] Model loaded from: {self.model_path}")
            return True
        return False

    def cleanup(self):
        """Remove temp directory and all files"""
        if self.temp_dir and self.temp_dir.exists():
            shutil.rmtree(self.temp_dir)
            print(f"[{self.client_id}] Removed temp directory: {self.temp_dir}")

            # Check if parent directory is empty and remove it
            if TEMP_MODEL_DIR.exists() and not any(TEMP_MODEL_DIR.iterdir()):
                TEMP_MODEL_DIR.rmdir()
                print(f"[Global] Removed empty temp directory: {TEMP_MODEL_DIR}")

sessions = {}

async def handle_calibration_complete(client_id: str, session: ClientSession, websocket: WebSocket, is_tune: bool = False):
    """Handle calibration/tune completion and model training"""
    min_samples = 5 if not is_tune else 10

    if len(session.calibration_features) >= min_samples:
        mode = "Tuning" if is_tune else "Training"
        print(f"[{client_id}] {mode} model with {len(session.calibration_features)} samples...")
        X = np.array(session.calibration_features)
        y = np.array(session.calibration_points)

        session.gaze_estimator.train(X, y)
        session.is_calibrated = True

        # Save model to temp directory
        session.save_model()

        result_msg = "Tune complete!" if is_tune else "Calibration complete!"
        print(f"[{client_id}] {result_msg}")
        await websocket.send_json({
            "type": "calibration_complete",
            "success": True,
            "samples": len(session.calibration_features),
            "is_tune": is_tune
        })
    else:
        mode = "tune" if is_tune else "calibration"
        print(f"[{client_id}] {mode.capitalize()} failed: not enough data")
        await websocket.send_json({
            "type": "calibration_complete",
            "success": False,
            "error": f"Not enough {mode} data"
        })

@app.get("/")
async def root():
    return {"message": "EyeMouse Backend Server"}

@app.websocket("/ws/{client_id}")
async def websocket_endpoint(websocket: WebSocket, client_id: str):
    await websocket.accept()
    print(f"[{client_id}] WebSocket connection accepted")

    # Initialize session for this client
    if client_id not in sessions:
        sessions[client_id] = ClientSession(client_id)
        sessions[client_id].gaze_estimator = GazeEstimator(model_name="ridge")
        print(f"[{client_id}] Session initialized with Ridge model")

    session = sessions[client_id]

    try:
        while True:
            data = await websocket.receive_json()
            command = data.get("command")

            if command == "start_calibration":
                print(f"[{client_id}] Starting calibration (EyeTrax 5-point method)...")
                # Reset calibration
                session.calibration_points = []
                session.calibration_features = []
                session.is_calibrated = False
                session.current_point_index = 0
                session.is_tune_mode = False

                # Generate 5 calibration points using EyeTrax logic
                # Order: center, top-left, top-right, bottom-left, bottom-right (from five_point.py)
                order = [(1, 1), (0, 0), (2, 0), (0, 2), (2, 2)]
                points = compute_grid_points(order, session.screen_width, session.screen_height)
                session.calibration_points_px = points  # Store in pixels for training

                # Convert to normalized coordinates for frontend
                points_normalized = [
                    {"x": p[0] / session.screen_width, "y": p[1] / session.screen_height}
                    for p in points
                ]

                print(f"[{client_id}] Generated {len(points_normalized)} calibration points")

                # Start with face detection phase (like wait_for_face_and_countdown)
                session.calibration_state = "wait_face"
                session.face_detected_start = None

                await websocket.send_json({
                    "type": "calibration_started",
                    "points": points_normalized,
                    "message": "Waiting for face detection...",
                    "is_tune": False
                })

            elif command == "calibration_frame":
                # Only accept calibration frames if not yet calibrated
                if session.is_calibrated or session.calibration_state == "idle":
                    continue

                # Receive webcam frame
                frame_data = data.get("frame")
                frame = decode_frame(frame_data)

                # Extract features
                features, blink_detected = session.gaze_estimator.extract_features(frame)
                face_detected = features is not None and not blink_detected

                import time
                current_time = time.time()

                # State machine following EyeTrax calibration logic
                if session.calibration_state == "wait_face":
                    # Wait for face detection and countdown (like wait_for_face_and_countdown)
                    if face_detected:
                        if session.face_detected_start is None:
                            session.face_detected_start = current_time
                            print(f"[{client_id}] Face detected, starting countdown...")

                        elapsed = current_time - session.face_detected_start
                        progress = min(elapsed / session.face_wait_duration, 1.0)

                        await websocket.send_json({
                            "type": "calibration_face_countdown",
                            "progress": progress
                        })

                        if elapsed >= session.face_wait_duration:
                            # Countdown complete, start first calibration point
                            session.calibration_state = "pulse"
                            session.current_point_index = 0
                            session.pulse_start = current_time
                            print(f"[{client_id}] Face countdown complete, starting point 1/5")

                            await websocket.send_json({
                                "type": "calibration_point_start",
                                "index": 0,
                                "total": len(session.calibration_points_px)
                            })
                    else:
                        # No face detected, reset countdown
                        session.face_detected_start = None
                        await websocket.send_json({
                            "type": "calibration_face_countdown",
                            "progress": 0,
                            "message": "Face not detected"
                        })

                elif session.calibration_state == "pulse":
                    # Pulse phase (like _pulse_and_capture pulse stage)
                    if session.pulse_start is None:
                        session.pulse_start = current_time

                    elapsed = current_time - session.pulse_start

                    await websocket.send_json({
                        "type": "calibration_pulse",
                        "progress": min(elapsed / session.pulse_duration, 1.0)
                    })

                    if elapsed >= session.pulse_duration:
                        # Move to capture phase
                        session.calibration_state = "capture"
                        session.capture_start = current_time
                        print(f"[{client_id}] Point {session.current_point_index + 1}/5 pulse complete, capturing...")

                elif session.calibration_state == "capture":
                    # Capture phase (like _pulse_and_capture capture stage)
                    if session.capture_start is None:
                        session.capture_start = current_time

                    elapsed = current_time - session.capture_start
                    progress = min(elapsed / session.capture_duration, 1.0)

                    await websocket.send_json({
                        "type": "calibration_capture",
                        "progress": progress
                    })

                    # Capture features during this phase
                    if face_detected:
                        px, py = session.calibration_points_px[session.current_point_index]
                        session.calibration_features.append(features)
                        session.calibration_points.append([px, py])

                    if elapsed >= session.capture_duration:
                        # Capture complete for this point
                        point_num = session.current_point_index + 1
                        samples_count = len(session.calibration_features)
                        print(f"[{client_id}] Point {point_num}/5 complete (captured {samples_count} samples)")

                        session.current_point_index += 1

                        if session.current_point_index < len(session.calibration_points_px):
                            # Move to next point
                            session.calibration_state = "pulse"
                            session.pulse_start = current_time

                            await websocket.send_json({
                                "type": "calibration_point_start",
                                "index": session.current_point_index,
                                "total": len(session.calibration_points_px)
                            })
                        else:
                            # All points complete, train model
                            session.calibration_state = "idle"
                            await handle_calibration_complete(client_id, session, websocket, session.is_tune_mode)

            elif command == "start_tune":
                # Start tune mode with 10 random points
                if not session.is_calibrated:
                    await websocket.send_json({
                        "type": "error",
                        "message": "No model to tune. Please calibrate first."
                    })
                    continue

                print(f"[{client_id}] Starting tune mode (10 random points)...")

                # Don't reset features - we want to ADD to existing data
                # session.calibration_points = []  # Keep existing
                # session.calibration_features = []  # Keep existing
                session.current_point_index = 0
                session.is_tune_mode = True

                # Generate 10 random calibration points
                import random
                random_points = []
                margin = 0.15  # 15% margin from edges
                for _ in range(10):
                    x = random.uniform(margin, 1 - margin)
                    y = random.uniform(margin, 1 - margin)
                    px = int(x * session.screen_width)
                    py = int(y * session.screen_height)
                    random_points.append((px, py))

                session.calibration_points_px = random_points

                # Convert to normalized coordinates for frontend
                points_normalized = [
                    {"x": p[0] / session.screen_width, "y": p[1] / session.screen_height}
                    for p in random_points
                ]

                print(f"[{client_id}] Generated {len(points_normalized)} random tune points")

                # Start with face detection phase
                session.calibration_state = "wait_face"
                session.face_detected_start = None

                await websocket.send_json({
                    "type": "calibration_started",
                    "points": points_normalized,
                    "message": "Tune mode: Waiting for face detection...",
                    "is_tune": True
                })

            elif command == "track_gaze":
                # Real-time gaze tracking
                frame_data = data.get("frame")
                frame = decode_frame(frame_data)

                if not session.is_calibrated:
                    await websocket.send_json({
                        "type": "error",
                        "message": "Not calibrated yet"
                    })
                    continue

                features, blink_detected = session.gaze_estimator.extract_features(frame)

                # Detect double blink
                double_blink = detect_double_blink(session, blink_detected)

                if features is not None and not blink_detected:
                    gaze_point = session.gaze_estimator.predict(np.array([features]))[0]
                    x, y = map(int, gaze_point)

                    # Normalize to 0-1 range for extension
                    x_norm = float(x / session.screen_width)
                    y_norm = float(y / session.screen_height)

                    await websocket.send_json({
                        "type": "gaze_update",
                        "x": x_norm,
                        "y": y_norm,
                        "blink": False,
                        "double_blink": bool(double_blink)
                    })
                else:
                    await websocket.send_json({
                        "type": "gaze_update",
                        "x": None,
                        "y": None,
                        "blink": bool(blink_detected),
                        "double_blink": bool(double_blink)
                    })

            elif command == "load_model":
                # Try to load existing model from temp directory
                if session.load_model():
                    print(f"[{client_id}] Loaded existing model")
                    await websocket.send_json({
                        "type": "model_loaded",
                        "success": True
                    })
                else:
                    print(f"[{client_id}] No existing model found")
                    await websocket.send_json({
                        "type": "model_loaded",
                        "success": False,
                        "error": "No saved model found"
                    })

            elif command == "stop":
                # Stop EyeMouse and cleanup
                print(f"[{client_id}] Stopping EyeMouse...")
                session.cleanup()
                await websocket.send_json({
                    "type": "stopped",
                    "success": True
                })

    except WebSocketDisconnect:
        print(f"[{client_id}] WebSocket disconnected")
        if client_id in sessions:
            sessions[client_id].cleanup()
            del sessions[client_id]
    except Exception as e:
        print(f"[{client_id}] Error: {e}")
        if client_id in sessions:
            sessions[client_id].cleanup()
            del sessions[client_id]

def decode_frame(frame_data: str) -> np.ndarray:
    """Decode base64 image to numpy array"""
    # Remove data URL prefix if present
    if "base64," in frame_data:
        frame_data = frame_data.split("base64,")[1]

    img_bytes = base64.b64decode(frame_data)
    img = Image.open(io.BytesIO(img_bytes))
    frame = cv2.cvtColor(np.array(img), cv2.COLOR_RGB2BGR)
    return frame

def detect_double_blink(session: ClientSession, blink_detected: bool) -> bool:
    """Detect double blink within 500ms window"""
    import time

    current_time = time.time()

    if blink_detected:
        session.blink_history.append(current_time)

    # Keep only blinks within last 1 second
    session.blink_history = [
        t for t in session.blink_history
        if current_time - t < 1.0
    ]

    # Check for double blink (2 blinks within 500ms)
    if len(session.blink_history) >= 2:
        if session.blink_history[-1] - session.blink_history[-2] < 0.5:
            # Clear history to avoid multiple triggers
            session.blink_history = []
            return True

    return False

if __name__ == "__main__":
    import uvicorn
    print("=" * 50)
    print("EyeMouse Backend Server")
    print("=" * 50)
    print(f"Temporary models directory: {TEMP_MODEL_DIR.absolute()}")
    print("=" * 50)
    uvicorn.run(app, host="0.0.0.0", port=8000)
