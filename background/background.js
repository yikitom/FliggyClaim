// Service worker for FliggyClaim.
// 1. Open side panel when the toolbar icon is clicked.
// 2. Forward open-options messages from popup.

chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === "install") {
    chrome.storage.sync.set({ "fliggy.ocr.enabled": false });
  }

  // After install or update, re-inject the content script into any
  // already-open expense tabs so users don't have to manually refresh.
  try {
    const tabs = await chrome.tabs.query({
      url: ["https://tae.alibaba-inc.com/expense/*", "https://*.alibaba-inc.com/expense/*"],
    });
    for (const tab of tabs) {
      try {
        await chrome.scripting.insertCSS({
          target: { tabId: tab.id, allFrames: true },
          files: ["content/content.css"],
        });
      } catch {}
      try {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id, allFrames: true },
          files: ["content/content.js"],
        });
        console.log("[FliggyClaim bg] re-injected into tab", tab.id);
      } catch (e) {
        console.log("[FliggyClaim bg] inject skipped for tab", tab.id, e?.message);
      }
    }
  } catch (e) {
    console.log("[FliggyClaim bg] tabs.query skipped:", e?.message || e);
  }
});

// Open the side panel automatically on action click.
if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((err) => console.log("[FliggyClaim] sidePanel behavior skipped:", err?.message || err));
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === "FLIGGY_OPEN_OPTIONS") {
    chrome.runtime.openOptionsPage();
    sendResponse({ ok: true });
  }
});
