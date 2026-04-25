// Service worker for FliggyClaim.
// The popup talks to the content script directly via tabs.sendMessage,
// so this worker only handles housekeeping for now.

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === "install") {
    chrome.storage.sync.set({
      "fliggy.ocr.enabled": false,
    });
  }
});

// Allow opening options page via the popup's gear button.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === "FLIGGY_OPEN_OPTIONS") {
    chrome.runtime.openOptionsPage();
    sendResponse({ ok: true });
  }
});
