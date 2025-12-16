# 👁️ EyeMouse

**Control your mouse with your eyes using a Chrome extension**

Track eye movements through your webcam to control the mouse cursor and click with a double blink. Calibration and blink detection are powered by [EyeTrax](https://github.com/ck-zhang/eyetrax).

## ✨ Features

- **Eye-Tracking Cursor Control**: Move the cursor by moving your eyes
- **Smart Element Snapping**: To reduce hassle, eye cursor glides along HTML UI elements
- **Double Blink Click**: Quickly blink twice to click
- **5-Point Calibration**: Personalized model training by looking at 5 screen points
- **10-Point Tuning**: Improve accuracy with 10 additional random points
- **Voice Commands**: Control with "Activate EyeMouse", "Recalibrate", etc.
- **Session Persistence**: Calibration model persists across page navigation

## 🚀 Getting Started

### 1. Install and Run Backend

```bash
# Install dependencies
pip install -r requirements.txt

# Run backend server
cd backend
python main.py
```

Server runs at `http://localhost:8000`.

### 2. Install Chrome Extension

1. Go to `chrome://extensions` in Chrome
2. Enable **Developer mode**
3. Click **Load unpacked**
4. Select the `extension` folder

### 3. Usage

1. Click extension icon → **Activate EyeMouse**
2. Allow webcam permission
3. **Calibration**: Look at 5 green points appearing on screen in order
4. After calibration, control cursor with your eyes
5. **Click**: Blink twice quickly (double blink)

### Shortcuts and Commands

| Function                  | Method                                              |
| ------------------------- | --------------------------------------------------- |
| Recalibration             | `R` key or "Recalibrate" voice command              |
| Tuning (improve accuracy) | Click "Tune Model" in popup                         |
| Deactivate                | Click "Deactivate" in popup or "Stop" voice command |

## 🛠️ Tech Stack

### Backend

- **FastAPI** - WebSocket server
- **[EyeTrax](https://github.com/ck-zhang/eyetrax)** - Eye tracking, calibration, and blink detection
- **OpenCV** / **MediaPipe** - Face and eye detection
- **NumPy** - Numerical computation

### Frontend (Chrome Extension)

- **Manifest V3** - Chrome Extension API
- **WebSocket** - Real-time communication
- **Web Speech API** - Voice recognition

## 📝 How It Works

1. **Frame Capture**: Capture frames from webcam in real-time
2. **Feature Extraction**: Detect facial landmarks with MediaPipe, extract eye region features
3. **Gaze Prediction**: Predict screen coordinates using Ridge regression model
4. **Cursor Movement**: Move virtual cursor to predicted coordinates
5. **Blink Detection**: Analyze blink patterns to trigger click on double blink

## 📄 License

MIT License
