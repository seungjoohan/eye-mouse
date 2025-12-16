// Popup script for EyeMouse extension

document.addEventListener('DOMContentLoaded', () => {
  const statusDiv = document.getElementById('status');
  const activateBtn = document.getElementById('activateBtn');
  const tuneBtn = document.getElementById('tuneBtn');
  const recalibrateBtn = document.getElementById('recalibrateBtn');
  const deactivateBtn = document.getElementById('deactivateBtn');

  // Get current tab and send messages
  async function sendMessageToCurrentTab(message) {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      console.log('[Popup] Sending message to tab:', tab.id, message);
      const response = await chrome.tabs.sendMessage(tab.id, message);
      console.log('[Popup] Response:', response);
      return response;
    } catch (error) {
      console.error('[Popup] Error sending message:', error);
      alert('Failed to communicate with page. Please refresh the page and try again.');
      throw error;
    }
  }

  activateBtn.addEventListener('click', async () => {
    console.log('[Popup] Activate button clicked');
    try {
      await sendMessageToCurrentTab({ type: 'TOGGLE_EYEMOUSE' });
      updateUI(true);
    } catch (error) {
      console.error('[Popup] Failed to activate:', error);
    }
  });

  tuneBtn.addEventListener('click', async () => {
    await sendMessageToCurrentTab({ type: 'TUNE' });
  });

  recalibrateBtn.addEventListener('click', async () => {
    await sendMessageToCurrentTab({ type: 'RECALIBRATE' });
  });

  deactivateBtn.addEventListener('click', async () => {
    await sendMessageToCurrentTab({ type: 'TOGGLE_EYEMOUSE' });
    updateUI(false);
  });

  function updateUI(active) {
    if (active) {
      statusDiv.className = 'status active';
      statusDiv.textContent = 'Status: Active';
      activateBtn.style.display = 'none';
      tuneBtn.style.display = 'block';
      recalibrateBtn.style.display = 'block';
      deactivateBtn.style.display = 'block';
    } else {
      statusDiv.className = 'status inactive';
      statusDiv.textContent = 'Status: Inactive';
      activateBtn.style.display = 'block';
      tuneBtn.style.display = 'none';
      recalibrateBtn.style.display = 'none';
      deactivateBtn.style.display = 'none';
    }
  }

  // Check initial status
  chrome.storage.local.get(['isActive'], (result) => {
    updateUI(result.isActive || false);
  });
});
