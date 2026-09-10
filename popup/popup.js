/* global FliggyParser */

const ACCEPTED_EXT = [
  "pdf",
  "png",
  "jpg",
  "jpeg",
  "webp",
  "heic",
  "heif",
  "bmp",
  "gif",
  "tif",
  "tiff",
];

const STORAGE_KEY_PARSED = "fliggy.parsedRecords";

const state = {
  files: new Map(), // id -> File
  records: [], // parsed records
  parsing: false,
};

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

document.addEventListener("DOMContentLoaded", init);

async function init() {
  bindTabs();
  bindUpload();
  bindParsedActions();
  bindSettings();
  await restoreParsed();
  renderParsed();
}

/* ---------- Tabs ---------- */
function bindTabs() {
  $$(".seg-btn").forEach((btn) => {
    btn.addEventListener("click", () => switchTab(btn.dataset.tab));
  });
}

function switchTab(name) {
  $$(".seg-btn").forEach((b) =>
    b.classList.toggle("is-active", b.dataset.tab === name),
  );
  $$(".panel").forEach((p) =>
    p.classList.toggle("is-active", p.id === `panel${cap(name)}`),
  );
}

function cap(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/* ---------- Upload ---------- */
function bindUpload() {
  const dz = $("#dropzone");
  const input = $("#fileInput");

  dz.addEventListener("click", (e) => {
    if (e.target.closest("#browseBtn")) return; // handled below
    input.click();
  });
  $("#browseBtn").addEventListener("click", (e) => {
    e.stopPropagation();
    input.click();
  });

  dz.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      input.click();
    }
  });

  ["dragenter", "dragover"].forEach((ev) =>
    dz.addEventListener(ev, (e) => {
      e.preventDefault();
      dz.classList.add("is-drag");
    }),
  );
  ["dragleave", "drop"].forEach((ev) =>
    dz.addEventListener(ev, (e) => {
      e.preventDefault();
      if (ev === "dragleave" && dz.contains(e.relatedTarget)) return;
      dz.classList.remove("is-drag");
    }),
  );

  dz.addEventListener("drop", (e) => {
    const files = collectDroppedFiles(e.dataTransfer);
    addFiles(files);
  });

  input.addEventListener("change", () => {
    addFiles(Array.from(input.files || []));
    input.value = "";
  });

  $("#clearAllBtn").addEventListener("click", () => {
    state.files.clear();
    renderFileList();
  });

  $("#confirmParseBtn").addEventListener("click", parseAll);
}

function collectDroppedFiles(dt) {
  const out = [];
  if (!dt) return out;
  if (dt.items && dt.items.length) {
    for (const item of dt.items) {
      if (item.kind === "file") {
        const f = item.getAsFile();
        if (f) out.push(f);
      }
    }
  } else if (dt.files) {
    for (const f of dt.files) out.push(f);
  }
  return out;
}

function addFiles(files) {
  let added = 0;
  let skipped = 0;
  for (const f of files) {
    const ext = (f.name.split(".").pop() || "").toLowerCase();
    if (!ACCEPTED_EXT.includes(ext)) {
      skipped++;
      continue;
    }
    const id = `${f.name}::${f.size}::${f.lastModified}`;
    if (state.files.has(id)) {
      skipped++;
      continue;
    }
    state.files.set(id, f);
    added++;
  }
  renderFileList();
  if (added) toast(`已添加 ${added} 个文件${skipped ? `，跳过 ${skipped} 个` : ""}`);
  else if (skipped) toast(`跳过 ${skipped} 个不支持/重复的文件`, "error");
}

function renderFileList() {
  const list = $("#fileList");
  const tpl = $("#fileItemTpl");
  list.innerHTML = "";
  let total = 0;
  for (const [id, f] of state.files) {
    total += f.size;
    const node = tpl.content.firstElementChild.cloneNode(true);
    const ext = (f.name.split(".").pop() || "").toLowerCase();
    const iconEl = node.querySelector(".file-icon");
    iconEl.textContent = ext.slice(0, 3);
    iconEl.classList.add(ext === "pdf" ? "pdf" : "img");
    node.querySelector(".file-name").textContent = f.name;
    node.querySelector(".file-name").title = f.name;
    node.querySelector(".file-size").textContent = humanSize(f.size);
    node.querySelector(".remove").addEventListener("click", () => {
      state.files.delete(id);
      renderFileList();
    });
    list.appendChild(node);
  }
  $("#statCount").textContent = state.files.size;
  $("#statSize").textContent = humanSize(total);
  $("#clearAllBtn").hidden = state.files.size === 0;
  $("#confirmParseBtn").disabled = state.files.size === 0 || state.parsing;
}

function humanSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/* ---------- Parsing ---------- */
async function parseAll() {
  if (state.parsing) return;
  if (state.files.size === 0) return;
  state.parsing = true;
  $("#confirmParseBtn").disabled = true;
  $("#parseProgress").hidden = false;
  const fill = $("#progressFill");
  const label = $("#progressLabel");

  const files = Array.from(state.files.values());
  const total = files.length;
  let done = 0;
  label.textContent = `0 / ${total}`;
  fill.style.width = "0%";

  const newRecords = [];
  for (const f of files) {
    try {
      const rec = await FliggyParser.parseFile(f);
      newRecords.push(rec);
    } catch (err) {
      console.error("parse error", f.name, err);
      newRecords.push(FliggyParser.fallbackRecord(f, err?.message));
    }
    done++;
    label.textContent = `${done} / ${total}`;
    fill.style.width = `${(done / total) * 100}%`;
  }

  state.records = state.records.concat(newRecords);
  await persistParsed();
  renderParsed();
  state.parsing = false;
  $("#confirmParseBtn").disabled = state.files.size === 0;
  setTimeout(() => {
    $("#parseProgress").hidden = true;
  }, 600);
  // Release the tesseract worker (~150MB) once the batch is done.
  if (FliggyParser.terminateOcr) {
    FliggyParser.terminateOcr().catch(() => {});
  }
  toast(`解析完成，共 ${newRecords.length} 条`);
  switchTab("parsed");
}

/* ---------- Parsed ---------- */
function bindParsedActions() {
  $("#importBtn").addEventListener("click", importToSystem);
  $("#diagBtn").addEventListener("click", runDiagnostics);
}

async function restoreParsed() {
  try {
    const data = await chrome.storage.local.get(STORAGE_KEY_PARSED);
    state.records = data[STORAGE_KEY_PARSED] || [];
  } catch (e) {
    state.records = [];
  }
}

async function persistParsed() {
  try {
    await chrome.storage.local.set({ [STORAGE_KEY_PARSED]: state.records });
  } catch (e) {
    console.warn("persist failed", e);
  }
}

function renderParsed() {
  const list = $("#parsedList");
  const tpl = $("#parsedItemTpl");
  list.innerHTML = "";
  const empty = $("#parsedEmpty");
  const totals = $("#totals");
  const badge = $("#parsedBadge");

  if (state.records.length === 0) {
    empty.style.display = "";
    totals.hidden = true;
    badge.hidden = true;
    $("#importBtn").disabled = true;
  } else {
    empty.style.display = "none";
    totals.hidden = false;
    badge.hidden = false;
    badge.textContent = state.records.length;
    $("#importBtn").disabled = false;
  }

  state.records.forEach((rec, idx) => {
    const node = tpl.content.firstElementChild.cloneNode(true);
    node.dataset.idx = idx;
    const secondRow = node.querySelector(".parsed-row.second");
    const nightsInp = node.querySelector(".nights");
    const applyTypeUI = (type) => {
      const isHotel = type === "hotel";
      nightsInp.hidden = !isHotel;
      secondRow.classList.toggle("with-nights", isHotel);
    };

    const typeSel = node.querySelector(".type");
    typeSel.value = rec.type || "other";
    applyTypeUI(typeSel.value);
    typeSel.addEventListener("change", () => {
      const t = typeSel.value;
      state.records[idx].type = t;
      // Sync nights for hotel <-> non-hotel transitions.
      if (t === "hotel") {
        state.records[idx].nights = state.records[idx].nights || 1;
        state.records[idx].checkin = state.records[idx].date || null;
        state.records[idx].checkout = addIsoDays(state.records[idx].date, state.records[idx].nights);
        nightsInp.value = state.records[idx].nights;
      } else {
        state.records[idx].nights = null;
        state.records[idx].checkin = null;
        state.records[idx].checkout = null;
      }
      applyTypeUI(t);
      persistParsed();
    });

    const dateInp = node.querySelector(".date");
    dateInp.value = rec.date || "";
    dateInp.addEventListener("change", () => {
      state.records[idx].date = dateInp.value;
      // Hotel checkin tracks the date; recompute checkout from nights.
      if (state.records[idx].type === "hotel") {
        state.records[idx].checkin = dateInp.value;
        state.records[idx].checkout = addIsoDays(
          dateInp.value,
          state.records[idx].nights || 1,
        );
      }
      persistParsed();
    });

    const cityInp = node.querySelector(".city");
    cityInp.value = rec.city || "";
    cityInp.addEventListener("input", () => {
      state.records[idx].city = cityInp.value.trim() || null;
    });
    cityInp.addEventListener("change", persistParsed);

    nightsInp.value = rec.nights || (rec.type === "hotel" ? 1 : "");
    nightsInp.addEventListener("input", () => {
      const n = Math.max(1, parseInt(nightsInp.value, 10) || 1);
      state.records[idx].nights = n;
      if (state.records[idx].type === "hotel") {
        state.records[idx].checkout = addIsoDays(
          state.records[idx].checkin || state.records[idx].date,
          n,
        );
      }
    });
    nightsInp.addEventListener("change", persistParsed);

    const curSel = node.querySelector(".currency");
    curSel.value = rec.currency || "CNY";
    curSel.addEventListener("change", () => {
      state.records[idx].currency = curSel.value;
      persistParsed();
      updateTotals();
    });

    const amtInp = node.querySelector(".amount");
    amtInp.value = rec.amount ?? "";
    amtInp.addEventListener("input", () => {
      state.records[idx].amount = parseFloat(amtInp.value) || 0;
      updateTotals();
    });
    amtInp.addEventListener("change", persistParsed);

    const noteInp = node.querySelector(".note");
    noteInp.value = (rec.note || "").slice(0, 20);
    noteInp.addEventListener("input", () => {
      state.records[idx].note = noteInp.value.slice(0, 20);
    });
    noteInp.addEventListener("change", persistParsed);

    const src = node.querySelector(".src-name");
    src.textContent = rec.source || "";
    src.title = rec.source || "";

    node.querySelector(".remove-parsed").addEventListener("click", () => {
      state.records.splice(idx, 1);
      persistParsed();
      renderParsed();
    });

    list.appendChild(node);
  });

  updateTotals();
}

function updateTotals() {
  $("#totalCount").textContent = state.records.length;
  // sum per dominant currency
  const sums = {};
  for (const r of state.records) {
    const c = r.currency || "CNY";
    sums[c] = (sums[c] || 0) + (parseFloat(r.amount) || 0);
  }
  const entries = Object.entries(sums);
  if (entries.length === 0) {
    $("#totalAmount").textContent = "0.00";
    $("#totalCurrency").textContent = "CNY";
    return;
  }
  entries.sort((a, b) => b[1] - a[1]);
  const [cur, val] = entries[0];
  $("#totalAmount").textContent = val.toFixed(2);
  $("#totalCurrency").textContent =
    entries.length > 1 ? `${cur}+` : cur;
}

/* ---------- Import to system ---------- */
async function getTargetTab() {
  // The side panel itself is not a normal tab; "active in current window"
  // returns the page the user is looking at.
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !/alibaba-inc\.com\/expense\//.test(tab.url || "")) {
    throw new Error("请在报销系统页面打开此插件");
  }
  return tab;
}

async function ping(tabId) {
  try {
    const r = await chrome.tabs.sendMessage(tabId, { type: "FLIGGY_PING" });
    return !!(r && r.ok);
  } catch {
    return false;
  }
}

async function ensureContentScript(tabId) {
  if (await ping(tabId)) {
    console.log("[FliggyClaim] content script already alive in tab", tabId);
    return;
  }
  console.log("[FliggyClaim] injecting content script into tab", tabId);
  try {
    await chrome.scripting.insertCSS({
      target: { tabId, allFrames: true },
      files: ["content/content.css"],
    });
  } catch (e) {
    console.warn("[FliggyClaim] insertCSS failed:", e);
  }
  await chrome.scripting.executeScript({
    target: { tabId, allFrames: false },
    files: ["content/content.js"],
  });
  // tiny grace period for the script to register its onMessage listener
  await new Promise((r) => setTimeout(r, 80));
  if (!(await ping(tabId))) {
    throw new Error("内容脚本注入后仍无响应（请尝试手动刷新报销页）");
  }
}

async function withTab(fn, btnSel) {
  const btn = btnSel ? $(btnSel) : null;
  if (btn) btn.disabled = true;
  try {
    const tab = await getTargetTab();
    await ensureContentScript(tab.id);
    return await fn(tab);
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function importToSystem() {
  if (state.records.length === 0) return;
  try {
    await withTab(async (tab) => {
      const attachments = await buildAttachmentsMap(state.records);
      const attCount = Object.keys(attachments).length;
      console.log("[FliggyClaim] sending FLIGGY_FILL to tab", tab.id, tab.url, {
        records: state.records.length,
        attachments: attCount,
      });
      const resp = await chrome.tabs.sendMessage(tab.id, {
        type: "FLIGGY_FILL",
        records: state.records,
        attachments,
      });
      console.log("[FliggyClaim] FLIGGY_FILL response:", resp);
      if (resp && resp.ok) {
        const tail = resp.attached != null ? `, 附件 ${resp.attached}` : "";
        if (resp.failed) {
          // Records we refused to save (e.g. 金额 wouldn't stick) are reported
          // as failures, not quietly dropped from the count.
          const which = resp.failedIndexes?.length ? `第 ${resp.failedIndexes.join("、")} 条` : `${resp.failed} 条`;
          toast(
            `已写入 ${resp.filled} / ${state.records.length} 条${tail}；${which}失败：${resp.firstError || "未知原因"}`,
            "error",
          );
        } else {
          toast(`已写入 ${resp.filled} / ${state.records.length} 条到报销系统${tail}`);
        }
      } else {
        toast(resp?.error || "写入失败，请打开 DevTools 查看日志", "error");
      }
    }, "#importBtn");
  } catch (err) {
    console.error("[FliggyClaim] import error:", err);
    toast(err?.message || "注入失败", "error");
  }
}

async function buildAttachmentsMap(records) {
  // Records are persisted to chrome.storage.local but the original File
  // objects are not — they only live in state.files for the current popup
  // session. Match by filename; warn but don't fail if a file is missing.
  const out = {};
  const byName = new Map();
  for (const f of state.files.values()) byName.set(f.name, f);
  for (const rec of records) {
    if (out[rec.source]) continue;
    const file = byName.get(rec.source);
    if (!file) {
      console.warn("[FliggyClaim] no original file for", rec.source,
        "— popup may have been reopened; record will be filled without attachment");
      continue;
    }
    try {
      const data = await fileToBase64Bytes(file);
      out[rec.source] = {
        data,
        mime: file.type || guessMime(rec.source),
        size: file.size,
      };
    } catch (e) {
      console.warn("[FliggyClaim] base64 encode failed for", rec.source, e);
    }
  }
  return out;
}

function fileToBase64Bytes(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => {
      const s = fr.result || "";
      const idx = s.indexOf(",");
      resolve(idx >= 0 ? s.slice(idx + 1) : s);
    };
    fr.onerror = reject;
    fr.readAsDataURL(file);
  });
}

function guessMime(name) {
  const ext = (name.split(".").pop() || "").toLowerCase();
  return {
    pdf: "application/pdf",
    png: "image/png",
    jpg: "image/jpeg", jpeg: "image/jpeg",
    webp: "image/webp",
    heic: "image/heic", heif: "image/heif",
    bmp: "image/bmp", gif: "image/gif",
    tif: "image/tiff", tiff: "image/tiff",
  }[ext] || "application/octet-stream";
}

async function runDiagnostics() {
  try {
    await withTab(async (tab) => {
      const resp = await chrome.tabs.sendMessage(tab.id, {
        type: "FLIGGY_DIAG",
        records: state.records,
      });
      console.log("[FliggyClaim] diagnostic response:", resp);
      if (resp && resp.ok) {
        const text = JSON.stringify(resp.report, null, 2);
        try {
          await navigator.clipboard.writeText(text);
          toast("诊断报告已复制到剪贴板，把它发给开发者即可");
        } catch {
          toast("诊断完成，请打开 DevTools 控制台查看报告");
        }
      } else {
        toast(resp?.error || "诊断失败", "error");
      }
    }, "#diagBtn");
  } catch (err) {
    console.error("[FliggyClaim] diag error:", err);
    toast(err?.message || "诊断失败", "error");
  }
}

/* ---------- Settings ---------- */
function addIsoDays(iso, days) {
  if (!iso) return iso;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  d.setDate(d.getDate() + (days || 0));
  return d.toISOString().slice(0, 10);
}

function bindSettings() {
  $("#settingsBtn").addEventListener("click", () => {
    chrome.runtime.openOptionsPage();
  });
}

/* ---------- Toast ---------- */
let toastTimer = null;
function toast(msg, type = "info") {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.toggle("error", type === "error");
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 2200);
}
