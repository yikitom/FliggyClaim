/*
 * Content script for the Alibaba expense system.
 *
 * Listens for FLIGGY_FILL / FLIGGY_DIAG / FLIGGY_PING messages.
 *
 * Selectors are kept permissive and grouped so they're easy to tweak.
 * Run "诊断" in the popup to print + copy a form structure report
 * that helps tune selectors for the actual page.
 */

(() => {
  if (window.__fliggyClaimInjected) return;
  window.__fliggyClaimInjected = true;

  const log = (...a) => console.log("%c[FliggyClaim]", "color:#d71e1e;font-weight:bold", ...a);
  const warn = (...a) => console.warn("%c[FliggyClaim]", "color:#d71e1e;font-weight:bold", ...a);

  log("content script loaded on", location.href);

  const TYPE_LABELS = {
    flight: ["机票", "国内机票", "国际机票", "Air Ticket", "Flight", "飞机"],
    hotel: ["酒店", "住宿", "Hotel", "Accommodation", "宾馆"],
    meal: ["餐饮", "餐费", "Meal", "Dining", "工作餐", "招待"],
    taxi: ["市内交通", "打车", "出租车", "Taxi", "Local Transport", "网约车"],
    other: ["其他", "Others", "Misc", "杂费"],
  };

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    log("received message:", msg?.type);
    if (!msg || !msg.type) return;

    if (msg.type === "FLIGGY_PING") {
      sendResponse({ ok: true, ready: true, url: location.href });
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
  });

  /* ---------- Diagnostics ---------- */

  function diagnose() {
    const report = {
      url: location.href,
      title: document.title,
      candidates: {
        addButtons: probeAddButtons(),
        rows: probeRows(),
        inputs: sampleInputs(),
        selects: sampleSelects(),
      },
      framework: detectFramework(),
    };
    return report;
  }

  function probeAddButtons() {
    const all = Array.from(document.querySelectorAll("button, a, [role=button], span"));
    const matches = all
      .filter((b) => /新增|添加|Add(?: |Item|Expense|新)?|\+\s*新增/i.test(b.textContent || ""))
      .slice(0, 20);
    return matches.map((b) => ({
      tag: b.tagName.toLowerCase(),
      text: (b.textContent || "").trim().slice(0, 40),
      cls: (b.className || "").toString().slice(0, 80),
      visible: isVisible(b),
    }));
  }

  function probeRows() {
    const sels = [
      "tr",
      "li",
      ".expense-detail-row",
      ".ant-table-row",
      ".next-table-row",
      "[class*=expense] [class*=row]",
      "[class*=ExpenseDetail] [class*=row]",
    ];
    const out = {};
    for (const s of sels) {
      const els = document.querySelectorAll(s);
      out[s] = els.length;
    }
    return out;
  }

  function sampleInputs() {
    const inputs = Array.from(document.querySelectorAll("input, textarea")).slice(0, 40);
    return inputs.map((el) => ({
      tag: el.tagName.toLowerCase(),
      type: el.getAttribute("type") || "",
      name: el.getAttribute("name") || "",
      id: el.id || "",
      placeholder: el.getAttribute("placeholder") || "",
      cls: (el.className || "").toString().slice(0, 80),
      value: (el.value || "").slice(0, 30),
      visible: isVisible(el),
    }));
  }

  function sampleSelects() {
    const sels = Array.from(document.querySelectorAll("select")).slice(0, 20);
    return sels.map((el) => ({
      name: el.getAttribute("name") || "",
      id: el.id || "",
      cls: (el.className || "").toString().slice(0, 80),
      options: Array.from(el.options).slice(0, 8).map((o) => o.textContent),
    }));
  }

  function detectFramework() {
    const hits = [];
    if (document.querySelector("[class*='ant-']")) hits.push("antd");
    if (document.querySelector("[class*='next-']")) hits.push("alibaba-fusion");
    if (document.querySelector("[data-reactroot], [data-react-helmet]")) hits.push("react");
    if (document.querySelector("[id^='__nuxt'], [id^='__next']")) hits.push("ssr");
    if (window.Vue || document.querySelector("[data-v-]")) hits.push("vue");
    return hits.length ? hits : ["unknown"];
  }

  function isVisible(el) {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return false;
    const s = getComputedStyle(el);
    return s.display !== "none" && s.visibility !== "hidden" && s.opacity !== "0";
  }

  /* ---------- Form interaction ---------- */

  async function fillRecords(records) {
    log(`starting fill: ${records.length} records`);
    let filled = 0;
    showOverlay(`正在写入 0 / ${records.length} 条…`);
    for (let i = 0; i < records.length; i++) {
      const rec = records[i];
      try {
        await addExpenseRow(rec);
        filled++;
        showOverlay(`正在写入 ${filled} / ${records.length} 条…`);
        log(`✓ row ${i + 1}/${records.length}:`, rec);
      } catch (e) {
        warn(`× row ${i + 1}/${records.length} failed:`, rec, e);
      }
      await sleep(400);
    }
    await trySaveDraft();
    hideOverlay(`已写入 ${filled} / ${records.length} 条`);
    return { filled };
  }

  async function addExpenseRow(rec) {
    const addBtn = findAddButton();
    if (addBtn) {
      log("clicking add-row button:", addBtn);
      addBtn.click();
      await waitFor(() => findLatestEditableRow(), 4000).catch(() => null);
    } else {
      warn("no add-row button found; falling back to existing last row");
    }
    const row = findLatestEditableRow();
    if (!row) throw new Error("找不到可编辑的费用明细行 (运行「诊断」收集页面结构发给开发者)");
    log("editing row:", row);

    setTypeField(row, rec.type);
    await sleep(150);
    setDateField(row, rec.date);
    setCurrencyField(row, rec.currency);
    setAmountField(row, rec.amount);
    setNoteField(row, rec.note);

    const rowConfirm = row.querySelector(
      'button[title*="保存"], button[title*="确认"], .row-confirm, .anticon-check',
    );
    if (rowConfirm) rowConfirm.click();
  }

  function findAddButton() {
    const all = Array.from(document.querySelectorAll("button, a, [role=button], span"));
    const visible = all.filter(isVisible);
    return (
      visible.find((b) =>
        /^\s*\+?\s*(新增明细|新增费用|添加明细|添加费用|Add Item|Add Expense)\s*$/i.test(
          (b.textContent || "").trim(),
        ),
      ) ||
      visible.find((b) => /\+\s*新增|新增明细|新增费用|添加明细|添加费用/i.test(b.textContent || "")) ||
      visible.find((b) => /^\s*\+?\s*新增\s*$/i.test((b.textContent || "").trim())) ||
      null
    );
  }

  function findLatestEditableRow() {
    const cands = Array.from(
      document.querySelectorAll(
        "tr.editable-row, tr.ant-table-row, tr.next-table-row, .expense-detail-row, li.expense-row, [class*='expense'] [class*='row']",
      ),
    ).filter((r) => r.querySelector("input, textarea, [contenteditable=true]"));
    if (cands.length) return cands[cands.length - 1];

    const panel = document.querySelector(
      '[class*="expense-detail"], [class*="ExpenseDetail"], [class*="expenseDetail"]',
    );
    if (panel) {
      const inner = Array.from(panel.querySelectorAll("tr, li")).filter((r) =>
        r.querySelector("input, textarea, [contenteditable=true]"),
      );
      if (inner.length) return inner[inner.length - 1];
    }
    return null;
  }

  function setTypeField(row, type) {
    const sel = pickField(row, [
      'select[name*="type" i]',
      'select[name*="category" i]',
      '[data-field="type"] input',
      '[class*="type" i] input',
      '[placeholder*="类型" i]',
      '[placeholder*="类别" i]',
    ]);
    if (!sel) {
      warn("type field not found in row");
      return;
    }
    const labels = TYPE_LABELS[type] || TYPE_LABELS.other;
    if (sel.tagName === "SELECT") {
      const opt = Array.from(sel.options).find((o) =>
        labels.some((l) => (o.textContent || "").includes(l)),
      );
      if (opt) {
        sel.value = opt.value;
        fireChange(sel);
      }
      return;
    }
    sel.focus();
    nativeSetValue(sel, labels[0]);
    fireInput(sel);
    setTimeout(() => {
      const opt = document.querySelector(
        '.ant-select-item-option, .next-menu-item, [role="option"]',
      );
      if (opt) opt.click();
    }, 100);
  }

  function setDateField(row, date) {
    if (!date) return;
    const el = pickField(row, [
      'input[type="date"]',
      'input[placeholder*="日期"]',
      'input[placeholder*="Date"]',
      'input[placeholder*="发生日期"]',
      '[data-field="date"] input',
      '[class*="date" i] input',
    ]);
    if (!el) {
      warn("date field not found");
      return;
    }
    nativeSetValue(el, date);
    fireInput(el);
    fireChange(el);
  }

  function setCurrencyField(row, currency) {
    if (!currency) return;
    const sel = pickField(row, [
      'select[name*="currency" i]',
      '[data-field="currency"] input',
      '[class*="currency" i] input',
      '[placeholder*="币种" i]',
    ]);
    if (!sel) {
      warn("currency field not found");
      return;
    }
    if (sel.tagName === "SELECT") {
      const opt = Array.from(sel.options).find(
        (o) => (o.textContent || "").trim().toUpperCase().includes(currency),
      );
      if (opt) {
        sel.value = opt.value;
        fireChange(sel);
      }
      return;
    }
    sel.focus();
    nativeSetValue(sel, currency);
    fireInput(sel);
    setTimeout(() => {
      const opt = Array.from(
        document.querySelectorAll(
          '.ant-select-item-option, .next-menu-item, [role="option"]',
        ),
      ).find((o) => (o.textContent || "").toUpperCase().includes(currency));
      if (opt) opt.click();
    }, 100);
  }

  function setAmountField(row, amount) {
    if (amount == null) return;
    const el = pickField(row, [
      'input[type="number"]',
      'input[placeholder*="金额"]',
      'input[placeholder*="Amount"]',
      'input[placeholder*="费用金额"]',
      '[data-field="amount"] input',
      '[class*="amount" i] input',
    ]);
    if (!el) {
      warn("amount field not found");
      return;
    }
    nativeSetValue(el, String(amount));
    fireInput(el);
    fireChange(el);
  }

  function setNoteField(row, note) {
    if (!note) return;
    const el = pickField(row, [
      'textarea[placeholder*="备注"]',
      'input[placeholder*="备注"]',
      'textarea[placeholder*="Remark"]',
      'input[placeholder*="Remark"]',
      '[data-field="remark"] textarea',
      '[data-field="remark"] input',
      '[class*="remark" i] textarea',
      '[class*="remark" i] input',
    ]);
    if (!el) {
      warn("note field not found");
      return;
    }
    nativeSetValue(el, note);
    fireInput(el);
    fireChange(el);
  }

  function pickField(scope, selectors) {
    for (const s of selectors) {
      try {
        const el = scope.querySelector(s);
        if (el) return el;
      } catch (e) {
        // CSS selectors with [name*="x" i] may not parse on old browsers
      }
    }
    return null;
  }

  async function trySaveDraft() {
    const btn = Array.from(document.querySelectorAll("button")).find((b) =>
      /^(暂存|保存|保存草稿|Save Draft|Save)$/i.test((b.textContent || "").trim()),
    );
    if (btn && !btn.disabled) {
      log("clicking save-draft button");
      btn.click();
      await sleep(400);
    } else {
      warn("save-draft button not found");
    }
  }

  /* ---------- React/Vue-friendly value setting ---------- */
  function nativeSetValue(el, value) {
    const proto =
      el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    if (setter) setter.call(el, value);
    else el.value = value;
  }
  function fireInput(el) {
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }
  function fireChange(el) {
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  /* ---------- Helpers ---------- */
  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }
  function waitFor(fn, timeout = 3000) {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      const tick = () => {
        const r = fn();
        if (r) return resolve(r);
        if (Date.now() - start > timeout) return reject(new Error("timeout"));
        requestAnimationFrame(tick);
      };
      tick();
    });
  }

  /* ---------- Overlay ---------- */
  let overlayEl = null;
  function showOverlay(msg) {
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
