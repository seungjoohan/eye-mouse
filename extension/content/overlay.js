// Content script for EyeMouse overlay and interaction

class EyeMouseController {
  constructor() {
    this.isActive = false;
    this.isCalibrated = false;
    this.ws = null;
    this.clientId = null;
    this.videoStream = null;
    this.videoElement = null;
    this.canvas = null;
    this.ctx = null;
    this.calibrationPoints = [];
    this.currentCalibrationIndex = 0;
    this.cursorElement = null;
    this.highlightBox = null;
    this.currentElement = null;
    this.recognition = null;
    this.calibrationInterval = null;

    this.init();
  }

  async init() {
    // Get client ID from background
    const response = await chrome.runtime.sendMessage({ type: 'GET_CLIENT_ID' });
    this.clientId = response.clientId;

    // Create overlay elements
    this.createOverlay();

    // Setup voice recognition
    this.setupVoiceRecognition();

    // Check if EyeMouse was active before and auto-activate
    const storage = await chrome.storage.local.get(['isActive']);
    if (storage.isActive) {
      console.log('[EyeMouse] Auto-activating from previous session...');
      // Small delay to ensure page is fully loaded
      setTimeout(() => {
        this.activate();
      }, 1000);
    }

    // Listen for messages
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      console.log('[EyeMouse] Received message:', message);
      if (message.type === 'TOGGLE_EYEMOUSE') {
        this.toggle();
        sendResponse({ success: true });
      } else if (message.type === 'TUNE') {
        this.startTune();
        sendResponse({ success: true });
      } else if (message.type === 'RECALIBRATE') {
        this.startCalibration();
        sendResponse({ success: true });
      }
      return true; // Keep channel open for async response
    });

    // Setup keyboard shortcut for recalibration
    document.addEventListener('keydown', (e) => {
      if (e.key === 'r' && this.isActive) {
        this.startCalibration();
      }
    });

    // On page unload, just disconnect gracefully (don't cleanup temp directory)
    // Model will be reused when navigating to new page
    window.addEventListener('beforeunload', () => {
      if (this.isActive) {
        console.log('[EyeMouse] Page unloading, disconnecting (keeping model)...');
        // Just close WebSocket, don't send stop command
        if (this.ws) {
          this.ws.close();
        }
      }
    });
  }

  createOverlay() {
    // Virtual cursor
    this.cursorElement = document.createElement('div');
    this.cursorElement.id = 'eyemouse-cursor';
    this.cursorElement.style.cssText = `
      position: fixed;
      width: 20px;
      height: 20px;
      border: 2px solid rgba(0, 150, 255, 0.8);
      border-radius: 50%;
      pointer-events: none;
      z-index: 999999;
      display: none;
      background: radial-gradient(circle, rgba(0, 150, 255, 0.3), transparent);
      box-shadow: 0 0 10px rgba(0, 150, 255, 0.5);
    `;
    document.body.appendChild(this.cursorElement);

    // Element highlighter
    this.highlightBox = document.createElement('div');
    this.highlightBox.id = 'eyemouse-highlight';
    this.highlightBox.style.cssText = `
      position: absolute;
      border: 3px solid rgba(255, 200, 0, 0.8);
      pointer-events: none;
      z-index: 999998;
      display: none;
      background: rgba(255, 200, 0, 0.1);
      transition: all 0.1s ease;
    `;
    document.body.appendChild(this.highlightBox);

    // Calibration overlay
    this.calibrationOverlay = document.createElement('div');
    this.calibrationOverlay.id = 'eyemouse-calibration';
    this.calibrationOverlay.style.cssText = `
      position: fixed;
      top: 0;
      left: 0;
      width: 100vw;
      height: 100vh;
      background: rgba(0, 0, 0, 0.8);
      z-index: 9999999;
      display: none;
    `;
    document.body.appendChild(this.calibrationOverlay);

    // Status indicator
    this.statusElement = document.createElement('div');
    this.statusElement.id = 'eyemouse-status';
    this.statusElement.style.cssText = `
      position: fixed;
      top: 20px;
      right: 20px;
      padding: 10px 20px;
      background: rgba(0, 0, 0, 0.8);
      color: white;
      border-radius: 5px;
      font-family: Arial, sans-serif;
      font-size: 14px;
      z-index: 999999;
      display: none;
    `;
    document.body.appendChild(this.statusElement);
  }

  setupVoiceRecognition() {
    if (!('webkitSpeechRecognition' in window)) {
      console.warn('Voice recognition not supported');
      return;
    }

    this.recognition = new webkitSpeechRecognition();
    this.recognition.continuous = true;
    this.recognition.interimResults = false;
    this.recognition.lang = 'en-US';

    this.recognition.onresult = (event) => {
      const last = event.results.length - 1;
      const command = event.results[last][0].transcript.toLowerCase().trim();

      console.log('Voice command:', command);

      if (command.includes('activate') && command.includes('eyemouse')) {
        this.activate();
      } else if (command.includes('recalibrate')) {
        this.startCalibration();
      } else if (command.includes('deactivate') || command.includes('stop')) {
        this.deactivate();
      }
    };

    this.recognition.onerror = (event) => {
      console.error('Voice recognition error:', event.error);
    };
  }

  async toggle() {
    if (this.isActive) {
      this.deactivate();
    } else {
      this.activate();
    }
  }

  async activate() {
    if (this.isActive) return;

    console.log('[EyeMouse] Activating...');
    this.showStatus('Activating EyeMouse...');

    // Start voice recognition
    if (this.recognition) {
      this.recognition.start();
    }

    // Request webcam access
    try {
      console.log('[EyeMouse] Requesting webcam access...');
      this.videoStream = await navigator.mediaDevices.getUserMedia({
        video: { width: 640, height: 480 }
      });
      console.log('[EyeMouse] Webcam access granted');

      // Create video element for webcam
      this.videoElement = document.createElement('video');
      this.videoElement.srcObject = this.videoStream;
      this.videoElement.autoplay = true;
      this.videoElement.style.display = 'none';
      document.body.appendChild(this.videoElement);

      // Create canvas for frame capture
      this.canvas = document.createElement('canvas');
      this.canvas.width = 640;
      this.canvas.height = 480;
      this.ctx = this.canvas.getContext('2d');

      // Connect to backend
      console.log('[EyeMouse] Connecting to backend...');
      await this.connectWebSocket();
      console.log('[EyeMouse] Connected to backend');

      // Try to load existing model
      console.log('[EyeMouse] Loading model...');
      this.ws.send(JSON.stringify({ command: 'load_model' }));

      this.isActive = true;
      this.cursorElement.style.display = 'block';

      // Save active state
      await chrome.storage.local.set({ isActive: true });
      console.log('[EyeMouse] Activated successfully');

    } catch (error) {
      console.error('[EyeMouse] Failed to activate:', error);
      this.showStatus('Failed: ' + error.message);
      setTimeout(() => this.hideStatus(), 3000);
    }
  }

  async deactivate(cleanup = true) {
    if (!this.isActive) return;

    console.log('[EyeMouse] Deactivating...');
    this.isActive = false;
    this.cursorElement.style.display = 'none';
    this.highlightBox.style.display = 'none';
    this.hideStatus();

    // Save inactive state
    await chrome.storage.local.set({ isActive: false });

    // Only send stop command (cleanup temp directory) if explicitly requested
    // Don't cleanup on page navigation - we want to keep the model
    if (cleanup && this.ws && this.ws.readyState === WebSocket.OPEN) {
      console.log('[EyeMouse] Sending stop command to backend (cleanup temp directory)');
      this.ws.send(JSON.stringify({ command: 'stop' }));
    }

    // Stop voice recognition
    if (this.recognition) {
      this.recognition.stop();
    }

    // Stop webcam
    if (this.videoStream) {
      this.videoStream.getTracks().forEach(track => track.stop());
      this.videoStream = null;
    }

    // Close WebSocket (after a short delay to allow stop command to send)
    if (this.ws) {
      setTimeout(() => {
        if (this.ws) {
          this.ws.close();
          this.ws = null;
        }
      }, 100);
    }

    // Remove video element
    if (this.videoElement) {
      this.videoElement.remove();
      this.videoElement = null;
    }

    console.log('[EyeMouse] Deactivated');
  }

  async connectWebSocket() {
    return new Promise((resolve, reject) => {
      const wsUrl = `ws://localhost:8000/ws/${this.clientId}`; // Change to cloud URL
      this.ws = new WebSocket(wsUrl);

      this.ws.onopen = () => {
        console.log('Connected to EyeMouse backend');
        resolve();
      };

      this.ws.onerror = (error) => {
        console.error('WebSocket error:', error);
        reject(error);
      };

      this.ws.onmessage = (event) => {
        this.handleBackendMessage(JSON.parse(event.data));
      };

      this.ws.onclose = () => {
        console.log('Disconnected from backend');
      };
    });
  }

  handleBackendMessage(data) {
    switch (data.type) {
      case 'calibration_started':
        // New EyeTrax-based calibration started
        this.calibrationPoints = data.points;
        this.showStatus('Look at the screen and hold still...');
        this.calibrationOverlay.style.display = 'block';
        // Start sending frames
        this.startSendingCalibrationFrames();
        break;

      case 'calibration_face_countdown':
        // Face detection countdown
        if (data.message) {
          this.updateCalibrationOverlay(data.message, data.progress);
        } else {
          this.updateCalibrationOverlay(`Detecting face... ${Math.round(data.progress * 100)}%`, data.progress);
        }
        break;

      case 'calibration_point_start':
        // New calibration point started
        this.currentCalibrationIndex = data.index;
        this.showCalibrationPoint(data.index);
        break;

      case 'calibration_pulse':
        // Pulse animation (like EyeTrax)
        this.updateCalibrationPointPulse(data.progress);
        break;

      case 'calibration_capture':
        // Capture phase (like EyeTrax)
        this.updateCalibrationPointCapture(data.progress);
        break;

      case 'calibration_complete':
        if (data.success) {
          this.isCalibrated = true;
          this.hideCalibration();
          const msg = data.is_tune
            ? `Tune complete! Model improved with ${data.samples} total samples`
            : `Calibration complete! (${data.samples} samples)`;
          this.showStatus(msg);
          setTimeout(() => this.hideStatus(), 3000);
          this.startTracking();
        }
        break;

      case 'model_loaded':
        if (data.success) {
          this.isCalibrated = true;
          this.showStatus('Model loaded. Tracking started.');
          setTimeout(() => this.hideStatus(), 2000);
          this.startTracking();
        } else {
          // No saved model, start calibration
          this.startCalibration();
        }
        break;

      case 'gaze_update':
        this.updateGaze(data);
        break;

      case 'error':
        console.error('Backend error:', data.message);
        break;
    }
  }

  startCalibration() {
    console.log('[EyeMouse] Starting full calibration (5 points)...');
    this.showStatus('Starting calibration...');
    this.calibrationOverlay.style.display = 'block';
    this.currentCalibrationIndex = 0;
    this.ws.send(JSON.stringify({ command: 'start_calibration' }));
  }

  startTune() {
    if (!this.isCalibrated) {
      alert('Please calibrate first before tuning!');
      return;
    }

    console.log('[EyeMouse] Starting tune (10 random points)...');
    this.showStatus('Starting tune with 10 random points...');
    this.calibrationOverlay.style.display = 'block';
    this.currentCalibrationIndex = 0;
    this.ws.send(JSON.stringify({ command: 'start_tune' }));
  }

  startSendingCalibrationFrames() {
    // Continuously send frames during calibration
    const sendFrame = () => {
      if (!this.isActive || this.isCalibrated) {
        return;
      }

      const frameData = this.captureFrame();
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({
          command: 'calibration_frame',
          frame: frameData
        }));
      }

      requestAnimationFrame(sendFrame);
    };

    sendFrame();
  }

  updateCalibrationOverlay(message, progress) {
    // Show face detection countdown
    const progressPercent = Math.round(progress * 100);
    this.calibrationOverlay.innerHTML = `
      <div style="
        position: fixed;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
        color: white;
        font-size: 32px;
        font-family: Arial, sans-serif;
        text-align: center;
      ">
        ${message}
        <div style="
          width: 200px;
          height: 10px;
          background: rgba(255,255,255,0.3);
          border-radius: 5px;
          margin-top: 20px;
        ">
          <div style="
            width: ${progressPercent}%;
            height: 100%;
            background: #0f0;
            border-radius: 5px;
            transition: width 0.1s;
          "></div>
        </div>
      </div>
    `;
  }

  updateCalibrationPointPulse(progress) {
    // Pulse animation (like EyeTrax pulsing circle)
    const point = this.calibrationPoints[this.currentCalibrationIndex];
    const x = point.x * window.innerWidth;
    const y = point.y * window.innerHeight;

    // Pulsing radius
    const baseRadius = 15;
    const pulseRadius = 15;
    const radius = baseRadius + pulseRadius * Math.abs(Math.sin(progress * Math.PI * 4));

    this.calibrationOverlay.innerHTML = `
      <div style="
        position: absolute;
        left: ${x}px;
        top: ${y}px;
        transform: translate(-50%, -50%);
        width: ${radius * 2}px;
        height: ${radius * 2}px;
        border-radius: 50%;
        background: #0f0;
      "></div>
      <div style="
        position: fixed;
        top: 50px;
        left: 50%;
        transform: translateX(-50%);
        color: white;
        font-size: 24px;
        font-family: Arial, sans-serif;
      ">Point ${this.currentCalibrationIndex + 1}/5</div>
    `;
  }

  updateCalibrationPointCapture(progress) {
    // Capture animation (like EyeTrax countdown ring)
    const point = this.calibrationPoints[this.currentCalibrationIndex];
    const x = point.x * window.innerWidth;
    const y = point.y * window.innerHeight;

    const angle = 360 * (1 - progress);

    this.calibrationOverlay.innerHTML = `
      <div style="
        position: absolute;
        left: ${x}px;
        top: ${y}px;
        transform: translate(-50%, -50%);
        width: 30px;
        height: 30px;
        border-radius: 50%;
        background: #0f0;
      "></div>
      <div style="
        position: absolute;
        left: ${x}px;
        top: ${y}px;
        transform: translate(-50%, -50%);
        width: 80px;
        height: 80px;
        border-radius: 50%;
        border: 4px solid rgba(255,255,255,0.3);
        background: conic-gradient(white 0deg, white ${360 - angle}deg, transparent ${360 - angle}deg);
        -webkit-mask: radial-gradient(circle, transparent 38px, black 40px);
        mask: radial-gradient(circle, transparent 38px, black 40px);
      "></div>
      <div style="
        position: fixed;
        top: 50px;
        left: 50%;
        transform: translateX(-50%);
        color: white;
        font-size: 24px;
        font-family: Arial, sans-serif;
      ">Capturing... ${this.currentCalibrationIndex + 1}/5</div>
    `;
  }

  showCalibrationPoint(index) {
    // This is now just a placeholder - backend controls the display state
    // The actual display is handled by updateCalibrationPointPulse/Capture
    console.log(`[EyeMouse] Showing calibration point ${index + 1}/5`);
  }

  hideCalibration() {
    // Stop any ongoing calibration frame capture
    if (this.calibrationInterval) {
      clearInterval(this.calibrationInterval);
      this.calibrationInterval = null;
    }
    this.calibrationOverlay.style.display = 'none';
  }

  startTracking() {
    const trackLoop = () => {
      if (!this.isActive || !this.isCalibrated) return;

      const frameData = this.captureFrame();
      this.ws.send(JSON.stringify({
        command: 'track_gaze',
        frame: frameData
      }));

      requestAnimationFrame(trackLoop);
    };

    trackLoop();
  }

  captureFrame() {
    this.ctx.drawImage(this.videoElement, 0, 0, 640, 480);
    return this.canvas.toDataURL('image/jpeg', 0.8);
  }

  updateGaze(data) {
    if (data.x !== null && data.y !== null) {
      const x = data.x * window.innerWidth;
      const y = data.y * window.innerHeight;

      // Update cursor position
      this.cursorElement.style.left = (x - 10) + 'px';
      this.cursorElement.style.top = (y - 10) + 'px';

      // Find element at gaze position
      const element = document.elementFromPoint(x, y);
      if (element && element !== this.currentElement) {
        // Only highlight if it's a clickable element
        if (this.isClickable(element)) {
          this.updateHighlight(element);
          this.currentElement = element;
        } else {
          // Hide highlight if not clickable
          this.highlightBox.style.display = 'none';
          this.currentElement = null;
        }
      }
    }

    // Handle double blink (click)
    if (data.double_blink && this.currentElement) {
      this.clickElement(this.currentElement);
    }
  }

  isClickable(element) {
    // Check if element is clickable
    if (!element) return false;

    // Check tag names
    const clickableTags = ['A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'LABEL'];
    if (clickableTags.includes(element.tagName)) {
      return true;
    }

    // Check if element has click handler
    if (element.onclick || element.getAttribute('onclick')) {
      return true;
    }

    // Check if element has role="button" or similar
    const role = element.getAttribute('role');
    if (role && ['button', 'link', 'menuitem', 'tab', 'checkbox', 'radio'].includes(role)) {
      return true;
    }

    // Check if element has cursor: pointer style
    const cursor = window.getComputedStyle(element).cursor;
    if (cursor === 'pointer') {
      return true;
    }

    // Check if element is contenteditable
    if (element.isContentEditable) {
      return true;
    }

    // Check for common clickable classes
    const className = element.className.toLowerCase();
    if (typeof className === 'string' &&
        (className.includes('btn') ||
         className.includes('button') ||
         className.includes('link') ||
         className.includes('clickable'))) {
      return true;
    }

    return false;
  }

  updateHighlight(element) {
    if (!element || element === document.body || element === document.documentElement) {
      this.highlightBox.style.display = 'none';
      return;
    }

    const rect = element.getBoundingClientRect();
    this.highlightBox.style.display = 'block';
    this.highlightBox.style.left = (rect.left + window.scrollX) + 'px';
    this.highlightBox.style.top = (rect.top + window.scrollY) + 'px';
    this.highlightBox.style.width = rect.width + 'px';
    this.highlightBox.style.height = rect.height + 'px';
  }

  clickElement(element) {
    console.log('Double blink detected, clicking:', element);

    // Visual feedback
    const originalBg = element.style.background;
    element.style.background = 'rgba(0, 255, 0, 0.3)';
    setTimeout(() => {
      element.style.background = originalBg;
    }, 200);

    // Trigger click
    element.click();
  }

  showStatus(message) {
    this.statusElement.textContent = message;
    this.statusElement.style.display = 'block';
  }

  hideStatus() {
    this.statusElement.style.display = 'none';
  }
}

// Initialize EyeMouse controller
const eyeMouse = new EyeMouseController();
console.log('EyeMouse content script loaded');
