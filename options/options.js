const KEYS = {
  enabled: "fliggy.ocr.enabled",
  endpoint: "fliggy.ocr.endpoint",
  key: "fliggy.ocr.apiKey",
};

const $ = (s) => document.querySelector(s);

document.addEventListener("DOMContentLoaded", async () => {
  const cfg = await chrome.storage.sync.get(Object.values(KEYS));
  $("#ocrEnabled").checked = !!cfg[KEYS.enabled];
  $("#ocrEndpoint").value = cfg[KEYS.endpoint] || "";
  $("#ocrKey").value = cfg[KEYS.key] || "";

  $("#saveBtn").addEventListener("click", async () => {
    await chrome.storage.sync.set({
      [KEYS.enabled]: $("#ocrEnabled").checked,
      [KEYS.endpoint]: $("#ocrEndpoint").value.trim(),
      [KEYS.key]: $("#ocrKey").value.trim(),
    });
    const hint = $("#hint");
    hint.textContent = "已保存";
    setTimeout(() => (hint.textContent = ""), 1500);
  });
});
