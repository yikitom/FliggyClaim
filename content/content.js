/*
 * Content script for the Alibaba expense system.
 *
 * Class names on the actual page are unknown / can change between builds,
 * so this script does NOT rely on them. It uses two strategies in order:
 *
 *   1. Label-anchored filling. Find labels with text like "类型 / 发生日期 /
 *      费用金额 / 备注" and grab the nearest input/select. Works for any
 *      framework (Antd, Fusion, custom).
 *
 *   2. Visual-proximity grouping. Cluster all visible inputs by Y-coordinate;
 *      take the latest cluster as one row. Used as a fallback when label
 *      anchoring misses some fields.
 *
 * For each record we click "新增" first (best-effort, tolerates absence) then
 * fill the latest row using the strategies above.
 */

(() => {
  if (window.__fliggyClaimInjected) {
    // Even if already injected, make sure we have the latest message handler
    // (the old one may have died across extension reloads).
    window.__fliggyClaimInjected = "reused";
  } else {
    window.__fliggyClaimInjected = true;
  }

  const log = (...a) => console.log("%c[FliggyClaim]", "color:#d71e1e;font-weight:bold", ...a);
  const warn = (...a) => console.warn("%c[FliggyClaim]", "color:#d71e1e;font-weight:bold", ...a);

  log("content script loaded on", location.href, "frame:", window.top === window ? "top" : "iframe");

  // Field labels we recognize, ordered by preference.
  const LABELS = {
    type: ["费用类型", "类型", "类别", "Category", "Type", "费用项目"],
    date: ["发生日期", "消费日期", "费用日期", "日期", "Date", "Occurrence Date"],
    currency: ["币种", "货币", "Currency"],
    amount: ["费用金额", "金额", "Amount", "总金额", "应付金额"],
    note: ["备注", "说明", "事由", "用途", "Remark", "Note", "Description"],
  };

  const TYPE_TEXTS = {
    flight: ["机票", "国内机票", "国际机票", "Air Ticket", "Flight", "飞机"],
    hotel: ["酒店", "住宿", "Hotel", "Accommodation", "宾馆"],
    meal: ["餐饮", "餐费", "Meal", "Dining", "工作餐", "招待"],
    taxi: ["市内交通", "打车", "出租车", "Taxi", "Local Transport", "网约车"],
    other: ["其他", "其它", "Others", "Misc", "杂费"],
  };

  // Avoid double-binding when re-injected
  if (!window.__fliggyClaimListenerBound) {
    window.__fliggyClaimListenerBound = true;
    chrome.runtime.onMessage.addListener(handleMessage);
  }

  function handleMessage(msg, _sender, sendResponse) {
    log("received message:", msg?.type);
    if (!msg || !msg.type) return;

    if (msg.type === "FLIGGY_PING") {
      sendResponse({ ok: true, ready: true, url: location.href, top: window.top === window });
      return false;
    }

    if (msg.type === "FLIGGY_DIAG") {
      try {
        const report = diagnose();
        log("diagnostic report:", report);
        sendResponse({ ok: true, report });
      } catch (err) {
        warn("diag error:", err);
        sendResponse({ ok: false, error: err?.message || String(err) });
      }
      return false;
    }

    if (msg.type === "FLIGGY_FILL") {
      fillRecords(msg.records || [])
        .then((res) => sendResponse({ ok: true, ...res }))
        .catch((err) => {
          warn("fill error:", err);
          sendResponse({ ok: false, error: err?.message || String(err) });
        });
      return true; // async
    }
  }

  /* ---------- Diagnostics ---------- */

  function diagnose() {
    const inputs = visibleInputs();
    return {
      url: location.href,
      title: document.title,
      isTop: window.top === window,
      framework: detectFramework(),
      addButtons: probeAddButtons(),
      saveButtons: probeSaveButtons(),
      visibleInputs: inputs.map(describeEl),
      visibleSelects: visibleSelects().map(describeEl),
      labels: probeLabels(),
      groups: groupByYBand(inputs).map((g) => ({
        y: g[0].rect.top,
        size: g.length,
        items: g.map((e) => describeEl(e.el)),
      })),
    };
  }

  function probeLabels() {
    const all = Array.from(document.querySelectorAll("label, span, div, dt, p, th"))
      .filter(isVisible)
      .filter((el) => {
        const t = (el.textContent || "").trim();
        return t.length > 0 && t.length < 20;
      });
    const out = {};
    for (const key of Object.keys(LABELS)) {
      const matches = all
        .filter((el) => LABELS[key].some((l) => (el.textContent || "").trim() === l))
        .slice(0, 5);
      out[key] = matches.map(describeEl);
    }
    return out;
  }

  function probeAddButtons() {
    const all = Array.from(document.querySelectorAll("button, a, [role=button], span, div"))
      .filter(isVisible);
    return all
      .filter((b) => /^\s*\+?\s*(新增|添加|Add|新增明细|新增费用|添加明细|添加费用)\s*$/i.test((b.textContent || "").trim()))
      .slice(0, 10)
      .map(describeEl);
  }

  function probeSaveButtons() {
    return Array.from(document.querySelectorAll("button, a, [role=button]"))
      .filter(isVisible)
      .filter((b) => /^(暂存|保存|保存草稿|Save|Save Draft)$/i.test((b.textContent || "").trim()))
      .slice(0, 5)
      .map(describeEl);
  }

  function describeEl(elOrItem) {
    const el = elOrItem.el || elOrItem;
    const tag = el.tagName.toLowerCase();
    const r = el.getBoundingClientRect();
    return {
      tag,
      type: el.getAttribute("type") || "",
      name: el.getAttribute("name") || "",
      id: el.id || "",
      placeholder: el.getAttribute("placeholder") || "",
      ariaLabel: el.getAttribute("aria-label") || "",
      cls: (el.className || "").toString().slice(0, 100),
      text: (el.textContent || "").trim().slice(0, 40),
      value: tag === "input" || tag === "textarea" ? (el.value || "").slice(0, 30) : "",
      rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
    };
  }

  function detectFramework() {
    const hits = [];
    if (document.querySelector("[class*='ant-']")) hits.push("antd");
    if (document.querySelector("[class*='next-']")) hits.push("alibaba-fusion");
    if (document.querySelector("[data-reactroot], [data-react-helmet]")) hits.push("react");
    if (window.Vue || document.querySelector("[data-v-]")) hits.push("vue");
    return hits.length ? hits : ["unknown"];
  }

  function isVisible(el) {
    if (!el || !el.getBoundingClientRect) return false;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return false;
    const s = getComputedStyle(el);
    return s.display !== "none" && s.visibility !== "hidden" && s.opacity !== "0";
  }

  function visibleInputs() {
    return Array.from(document.querySelectorAll("input, textarea"))
      .filter((el) => el.type !== "hidden" && el.type !== "file" && !el.disabled)
      .filter(isVisible)
      .map((el) => ({ el, rect: el.getBoundingClientRect() }));
  }

  function visibleSelects() {
    return Array.from(document.querySelectorAll("select")).filter(isVisible);
  }

  /* ---------- Fill flow ---------- */

  async function fillRecords(records) {
    log(`starting fill: ${records.length} records`);
    let filled = 0;
    showOverlay(`正在写入 0 / ${records.length} 条…`);
    for (let i = 0; i < records.length; i++) {
      const rec = records[i];
      try {
        // For every record, ensure there's a fresh empty row to fill into.
        // If the table already has an empty row (typical for a fresh form),
        // use it; otherwise click 新增费用 to add one.
        const tableInfo = findExpenseTable();
        const needAdd = !tableInfo || !findEmptyRowInTable(tableInfo);
        if (needAdd) {
          await tryClickAddButton();
          await sleep(500);
        }
        const ok = await fillOneRecord(rec);
        if (ok) {
          filled++;
          log(`✓ row ${i + 1}/${records.length}:`, rec);
        } else {
          warn(`× row ${i + 1}/${records.length}: no fields filled`, rec);
        }
        showOverlay(`正在写入 ${filled} / ${records.length} 条…`);
      } catch (e) {
        warn(`× row ${i + 1}/${records.length} threw:`, rec, e);
      }
      await sleep(450);
    }
    await trySaveDraft();
    hideOverlay(`已写入 ${filled} / ${records.length} 条`);
    if (filled === 0) {
      throw new Error("0 条写入成功——请点「诊断」按钮把报告发给开发者");
    }
    return { filled };
  }

  async function tryClickAddButton() {
    const btn = findAddByText();
    if (btn) {
      log("clicking add-row button:", btn);
      clickEl(btn);
      await sleep(450);
    } else {
      warn("no add-row button found (will try to fill latest row anyway)");
    }
  }

  function clickEl(el) {
    try {
      el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window }));
      el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window }));
      el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
    } catch (e) {
      try { el.click(); } catch {}
    }
  }

  function findAddByText() {
    const all = Array.from(document.querySelectorAll("button, a, [role=button]")).filter(isVisible);
    // Prefer exact matches first (the toolbar primary button)
    const exact = all.find((b) =>
      /^(\+\s*)?(新增费用|新增明细|添加费用|添加明细|新增)$/i.test((b.textContent || "").trim()),
    );
    if (exact) return exact;
    // Then partial matches
    return all.find((b) => /(新增费用|新增明细|添加费用|添加明细)/i.test((b.textContent || "").trim()));
  }

  // Convert a description back to a live element (best effort by id+rect)
  function findElByDescription(d) {
    if (d.id) {
      const el = document.getElementById(d.id);
      if (el) return el;
    }
    return null;
  }

  /* ---------- Per-record filling ---------- */

  async function fillOneRecord(rec) {
    let touched = 0;

    // Strategy 0: table column-index. Most expense forms render as a table
    // with column headers (日期 / 费用类型 / 金额 / 备注 / ...). We map
    // column indices via the header row, then fill cells in the latest row.
    const tableTargets = findTableTargets();
    if (tableTargets) {
      log("table targets:", Object.fromEntries(
        Object.entries(tableTargets.targets).map(([k, v]) => [k, v ? describeEl(v) : null])
      ));
      const t = tableTargets.targets;
      if (t.type && (await setComboboxValue(t.type, TYPE_TEXTS[rec.type] || TYPE_TEXTS.other))) touched++;
      await sleep(120);
      if (t.date && setInputValue(t.date, formatDateForInput(t.date, rec.date))) touched++;
      if (t.currency && (await setComboboxValue(t.currency, [rec.currency]))) touched++;
      if (t.amount && setInputValue(t.amount, String(rec.amount ?? 0))) touched++;
      if (t.note && setInputValue(t.note, rec.note || "")) touched++;
      if (touched > 0) return true;
    }

    // Strategy 1: label-anchored
    const targets = {
      type: findInputByLabel(LABELS.type),
      date: findInputByLabel(LABELS.date),
      currency: findInputByLabel(LABELS.currency),
      amount: findInputByLabel(LABELS.amount),
      note: findInputByLabel(LABELS.note),
    };
    log("label-anchored targets:", Object.fromEntries(
      Object.entries(targets).map(([k, v]) => [k, v ? describeEl(v) : null])
    ));

    if (targets.type && setComboboxValue(targets.type, TYPE_TEXTS[rec.type] || TYPE_TEXTS.other)) touched++;
    await sleep(120);
    if (targets.date && setInputValue(targets.date, formatDateForInput(targets.date, rec.date))) touched++;
    if (targets.currency && setComboboxValue(targets.currency, [rec.currency])) touched++;
    if (targets.amount && setInputValue(targets.amount, String(rec.amount ?? 0))) touched++;
    if (targets.note && setInputValue(targets.note, rec.note || "")) touched++;

    // Strategy 2: if some labels failed, use proximity grouping for the latest row
    const missing = ["type", "date", "currency", "amount", "note"].filter((k) => !targets[k]);
    if (missing.length) {
      const latest = latestInputCluster();
      if (latest && latest.length) {
        log("proximity fallback row:", latest.map((e) => describeEl(e.el)));
        // Heuristic: pick by input/placeholder type
        const candidates = latest.map((e) => e.el);
        for (const key of missing) {
          const guess = guessFieldFromCandidates(key, candidates);
          if (!guess) continue;
          if (key === "type" && setComboboxValue(guess, TYPE_TEXTS[rec.type] || TYPE_TEXTS.other)) touched++;
          else if (key === "date" && setInputValue(guess, formatDateForInput(guess, rec.date))) touched++;
          else if (key === "currency" && setComboboxValue(guess, [rec.currency])) touched++;
          else if (key === "amount" && setInputValue(guess, String(rec.amount ?? 0))) touched++;
          else if (key === "note" && setInputValue(guess, rec.note || "")) touched++;
        }
      }
    }

    return touched > 0;
  }

  /* ---------- Table column-index strategy ---------- */

  function findExpenseTable() {
    const tables = Array.from(document.querySelectorAll('table, [role="table"]')).filter(isVisible);
    for (const table of tables) {
      const headers = collectHeaderTexts(table);
      // Must contain at least 2 of our target labels to qualify
      let hits = 0;
      for (const key of Object.keys(LABELS)) {
        if (headers.some((h) => LABELS[key].some((l) => h.text.includes(l)))) hits++;
      }
      if (hits >= 2) return { table, headers };
    }
    return null;
  }

  function collectHeaderTexts(table) {
    const ths = Array.from(table.querySelectorAll('th, [role="columnheader"]'))
      .filter(isVisible);
    if (ths.length) {
      return ths.map((el, idx) => ({
        idx,
        text: (el.textContent || "").trim(),
        rect: el.getBoundingClientRect(),
        el,
      }));
    }
    // Fallback: try first row's cells if no <th>
    const firstRow = table.querySelector("tr, [role='row']");
    if (!firstRow) return [];
    const tds = Array.from(firstRow.querySelectorAll("td, [role='cell']"));
    return tds.map((el, idx) => ({
      idx,
      text: (el.textContent || "").trim(),
      rect: el.getBoundingClientRect(),
      el,
    }));
  }

  function findTableTargets() {
    const info = findExpenseTable();
    if (!info) return null;
    const { table, headers } = info;

    // Map field key → column index by matching label text
    const colMap = {};
    for (const key of Object.keys(LABELS)) {
      const h = headers.find((h) => LABELS[key].some((l) => h.text.includes(l)));
      if (h) colMap[key] = h.idx;
    }
    log("table column map:", colMap);
    if (!Object.keys(colMap).length) return null;

    // Prefer the row that has at least one input/textarea; otherwise the last row.
    const rows = Array.from(table.querySelectorAll("tr, [role='row']")).filter(isVisible);
    let target = null;
    for (let i = rows.length - 1; i >= 0; i--) {
      const r = rows[i];
      if (r.querySelector('input:not([type="hidden"]), textarea, select, [contenteditable="true"], [role="combobox"]')) {
        target = r;
        break;
      }
    }
    // If no editable row exists, the click-add path needs to run first.
    if (!target) return { table, targets: {}, colMap, rowMissing: true };

    const cells = Array.from(target.querySelectorAll("td, [role='cell']"));
    const targets = {};
    for (const [field, idx] of Object.entries(colMap)) {
      const cell = cells[idx];
      if (!cell) continue;
      const inp =
        cell.querySelector('input:not([type="hidden"]):not([disabled])') ||
        cell.querySelector("textarea:not([disabled])") ||
        cell.querySelector("select:not([disabled])") ||
        cell.querySelector('[role="combobox"]') ||
        cell.querySelector('[contenteditable="true"]');
      if (inp) targets[field] = inp;
    }
    return { table, targets, colMap, row: target };
  }

  function findEmptyRowInTable(info) {
    if (!info) return null;
    const rows = Array.from(info.table.querySelectorAll("tr, [role='row']")).filter(isVisible);
    for (let i = rows.length - 1; i >= 0; i--) {
      const r = rows[i];
      const inputs = r.querySelectorAll('input:not([type="hidden"]):not([disabled]), textarea:not([disabled])');
      if (inputs.length === 0) continue;
      const allEmpty = Array.from(inputs).every((el) => !el.value);
      if (allEmpty) return r;
    }
    return null;
  }

  function findInputByLabel(labelTexts) {
    const labelEls = Array.from(document.querySelectorAll("label, span, div, dt, p, th"))
      .filter(isVisible)
      .filter((el) => {
        const t = (el.textContent || "").trim();
        return labelTexts.some((l) => t === l || t === l + ":" || t === l + "：" || t === "*" + l);
      });

    for (const lbl of labelEls) {
      // 1) <label for="..."> direct mapping
      const forId = lbl.getAttribute && lbl.getAttribute("for");
      if (forId) {
        const target = document.getElementById(forId);
        if (target && isVisible(target)) return target;
      }
      // 2) Look in nextElementSibling chain
      let cur = lbl;
      for (let i = 0; i < 4 && cur; i++) {
        cur = cur.nextElementSibling;
        if (!cur) break;
        const inp = findFillableInside(cur);
        if (inp) return inp;
      }
      // 3) Look at parent's siblings
      let parent = lbl.parentElement;
      for (let i = 0; i < 3 && parent; i++) {
        let sib = parent.nextElementSibling;
        for (let j = 0; j < 3 && sib; j++) {
          const inp = findFillableInside(sib);
          if (inp) return inp;
          sib = sib.nextElementSibling;
        }
        parent = parent.parentElement;
      }
      // 4) Same parent, any input
      const sameParent = lbl.parentElement && findFillableInside(lbl.parentElement);
      if (sameParent && sameParent !== lbl) return sameParent;
    }
    return null;
  }

  function findFillableInside(scope) {
    if (!scope || !scope.querySelector) return null;
    return scope.querySelector(
      'input:not([type="hidden"]):not([type="file"]):not([disabled]), textarea:not([disabled]), select:not([disabled])',
    );
  }

  /* ---------- Visual proximity grouping ---------- */

  function latestInputCluster() {
    const groups = groupByYBand(visibleInputs());
    if (!groups.length) return null;
    return groups[groups.length - 1];
  }

  function groupByYBand(items, band = 36) {
    const sorted = [...items].sort((a, b) => a.rect.top - b.rect.top);
    const groups = [];
    for (const it of sorted) {
      const g = groups[groups.length - 1];
      if (g && Math.abs(it.rect.top - g[0].rect.top) <= band) g.push(it);
      else groups.push([it]);
    }
    return groups;
  }

  function guessFieldFromCandidates(key, els) {
    // amount: number-typed input or placeholder containing 金额/Amount
    if (key === "amount") {
      return els.find((el) => el.type === "number" || /金额|Amount/i.test(el.placeholder || el.getAttribute("aria-label") || ""));
    }
    if (key === "date") {
      return els.find((el) => el.type === "date" || /日期|Date/i.test(el.placeholder || el.getAttribute("aria-label") || ""));
    }
    if (key === "note") {
      return els.find((el) => el.tagName === "TEXTAREA" || /备注|说明|Remark|Note/i.test(el.placeholder || ""));
    }
    if (key === "type") {
      return els.find((el) => /类型|类别|Type|Category/i.test(el.placeholder || el.getAttribute("aria-label") || ""));
    }
    if (key === "currency") {
      return els.find((el) => /币种|货币|Currency|CNY|USD/i.test(el.placeholder || el.getAttribute("aria-label") || el.value || ""));
    }
    return null;
  }

  /* ---------- Field setters ---------- */

  function formatDateForInput(el, iso) {
    if (!iso) return iso;
    if (el.type === "date") return iso; // YYYY-MM-DD
    // Many UI date pickers accept YYYY/MM/DD or YYYY-MM-DD
    return iso.replaceAll("-", "/");
  }

  function setInputValue(el, value) {
    if (!el) return false;
    try {
      el.focus();
      const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
      if (setter) setter.call(el, value);
      else el.value = value;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      el.dispatchEvent(new Event("blur", { bubbles: true }));
      return true;
    } catch (e) {
      warn("setInputValue failed:", e);
      return false;
    }
  }

  function setComboboxValue(el, candidateTexts) {
    if (!el) return false;
    if (el.tagName === "SELECT") {
      const opt = Array.from(el.options).find((o) =>
        candidateTexts.some((t) => (o.textContent || "").includes(t)),
      );
      if (!opt) return false;
      el.value = opt.value;
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    }
    // Combobox: focus, type, then click matching dropdown option
    el.focus();
    const proto = HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    if (setter) setter.call(el, candidateTexts[0]);
    else el.value = candidateTexts[0];
    el.dispatchEvent(new Event("input", { bubbles: true }));

    // Trigger arrow-down to open dropdown for some pickers
    el.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));

    return new Promise((resolve) => {
      setTimeout(() => {
        const opts = Array.from(
          document.querySelectorAll(
            '[role="option"], .ant-select-item-option, .next-menu-item, [class*="option"][class*="item"]',
          ),
        ).filter(isVisible);
        const opt = opts.find((o) =>
          candidateTexts.some((t) => (o.textContent || "").includes(t)),
        );
        if (opt) {
          opt.click();
          resolve(true);
        } else {
          // Try Enter to confirm typed value
          el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
          resolve(true);
        }
      }, 180);
    });
  }

  async function trySaveDraft() {
    const btn = Array.from(document.querySelectorAll("button, a, [role=button]"))
      .filter(isVisible)
      .find((b) => /^(暂存|保存|保存草稿|Save Draft|Save)$/i.test((b.textContent || "").trim()));
    if (btn && !btn.disabled) {
      log("clicking save-draft button:", btn);
      btn.click();
      await sleep(400);
    } else {
      warn("save-draft button not found (skipping; user can save manually)");
    }
  }

  /* ---------- Helpers ---------- */
  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  /* ---------- Overlay ---------- */
  let overlayEl = null;
  function showOverlay(msg) {
    if (window.top !== window) return; // overlay only in top frame
    if (!overlayEl) {
      overlayEl = document.createElement("div");
      overlayEl.className = "fliggy-overlay";
      document.body.appendChild(overlayEl);
    }
    overlayEl.textContent = msg;
    overlayEl.classList.add("show");
  }
  function hideOverlay(msg) {
    if (!overlayEl) return;
    overlayEl.textContent = msg;
    setTimeout(() => overlayEl?.classList.remove("show"), 1500);
  }
})();
