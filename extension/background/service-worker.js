// Background service worker for EyeMouse extension

const BACKEND_URL = 'ws://localhost:8000'; // Change to your cloud URL when deployed
let clientId = null;

// Generate or retrieve client ID
chrome.runtime.onInstalled.addListener(async () => {
  const result = await chrome.storage.local.get(['clientId']);
  if (!result.clientId) {
    clientId = generateClientId();
    await chrome.storage.local.set({ clientId });
  } else {
    clientId = result.clientId;
  }
  console.log('EyeMouse initialized with client ID:', clientId);
});

// Listen for messages from content scripts
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'GET_CLIENT_ID') {
    sendResponse({ clientId });
  }
  return true;
});

function generateClientId() {
  return 'client_' + Math.random().toString(36).substring(2, 15);
}

// Handle extension icon click
chrome.action.onClicked.addListener((tab) => {
  chrome.tabs.sendMessage(tab.id, { type: 'TOGGLE_EYEMOUSE' });
});
