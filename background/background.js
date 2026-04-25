// Service worker for FliggyClaim.
// 1. Open side panel when the toolbar icon is clicked.
// 2. Forward open-options messages from popup.

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === "install") {
    chrome.storage.sync.set({
      "fliggy.ocr.enabled": false,
    });
  }
});

// Open the side panel automatically on action click.
if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((err) => console.warn("[FliggyClaim] sidePanel behavior:", err));
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === "FLIGGY_OPEN_OPTIONS") {
    chrome.runtime.openOptionsPage();
    sendResponse({ ok: true });
  }
});
