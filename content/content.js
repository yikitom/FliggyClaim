/*
 * Content script for the Alibaba expense system.
 *
 * Listens for FLIGGY_FILL messages and writes parsed records into the
 * expense form. Tries to be resilient to the page's React/Vue components
 * by dispatching native input/change events that frameworks listen to.
 *
 * The expense system markup can change; selectors here are best-effort
 * and grouped so they're easy to tweak.
 */

(() => {
  if (window.__fliggyClaimInjected) return;
  window.__fliggyClaimInjected = true;

  const TYPE_LABELS = {
    flight: ["机票", "国内机票", "国际机票", "Air Ticket", "Flight"],
    hotel: ["酒店", "住宿", "Hotel", "Accommodation"],
    meal: ["餐饮", "餐费", "Meal", "Dining"],
    taxi: ["市内交通", "打车", "出租车", "Taxi", "Local Transport"],
    other: ["其他", "Others", "Misc"],
  };

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg && msg.type === "FLIGGY_FILL") {
      fillRecords(msg.records || [])
        .then((res) => sendResponse({ ok: true, ...res }))
        .catch((err) =>
          sendResponse({ ok: false, error: err?.message || String(err) }),
        );
      return true; // async
    }
    if (msg && msg.type === "FLIGGY_PING") {
      sendResponse({ ok: true, ready: true });
      return false;
    }
  });

  async function fillRecords(records) {
    let filled = 0;
    showOverlay(`正在写入 0 / ${records.length} 条…`);
    for (let i = 0; i < records.length; i++) {
      const rec = records[i];
      try {
        await addExpenseRow(rec);
        filled++;
        showOverlay(`正在写入 ${filled} / ${records.length} 条…`);
      } catch (e) {
        console.warn("[FliggyClaim] failed to add row", rec, e);
      }
      await sleep(350);
    }
    await trySaveDraft();
    hideOverlay(`已写入 ${filled} / ${records.length} 条`);
    return { filled };
  }

  /* ---------- Form interaction ---------- */

  async function addExpenseRow(rec) {
    const addBtn = findAddButton();
    if (addBtn) {
      addBtn.click();
      await waitFor(() => findLatestEditableRow(), 4000);
    }
    const row = findLatestEditableRow();
    if (!row) throw new Error("找不到可编辑的费用明细行");

    setTypeField(row, rec.type);
    await sleep(120);
    setDateField(row, rec.date);
    setCurrencyField(row, rec.currency);
    setAmountField(row, rec.amount);
    setNoteField(row, rec.note);

    // Some forms have a confirm/save row icon
    const rowConfirm = row.querySelector(
      'button[title*="保存"], button[title*="确认"], .row-confirm, .anticon-check',
    );
    if (rowConfirm) {
      rowConfirm.click();
    }
  }

  function findAddButton() {
    // Prefer text-matched buttons
    const btns = Array.from(document.querySelectorAll("button, a"));
    return (
      btns.find((b) => /\+\s*新增|新增明细|新增费用|添加明细|添加费用|Add (Item|Expense)/i.test(b.textContent || "")) ||
      btns.find((b) => /^\s*\+?\s*新增\s*$/i.test(b.textContent || "")) ||
      null
    );
  }

  function findLatestEditableRow() {
    // Common patterns: tr inside table.expense-detail, .ant-table-row-level-0,
    // or li.expense-row. Prefer the last one that contains an input.
    const rows = Array.from(
      document.querySelectorAll(
        "tr.editable-row, tr.ant-table-row, .expense-detail-row, li.expense-row",
      ),
    ).filter((r) => r.querySelector("input, [contenteditable=true]"));
    if (rows.length) return rows[rows.length - 1];

    // Fallback: any row inside the visible expense-detail panel
    const panel = document.querySelector(
      '[class*="expense-detail"], [class*="ExpenseDetail"]',
    );
    if (panel) {
      const cands = Array.from(panel.querySelectorAll("tr, li")).filter((r) =>
        r.querySelector("input, [contenteditable=true]"),
      );
      if (cands.length) return cands[cands.length - 1];
    }
    return null;
  }

  function setTypeField(row, type) {
    const sel = pickField(row, [
      'select[name*="type"]',
      '[data-field="type"] input',
      '[class*="type"] input',
      '[class*="Type"] input',
    ]);
    if (!sel) return;
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
    // Antd-style combobox: focus, then click the option
    sel.focus();
    nativeSetValue(sel, labels[0]);
    fireInput(sel);
    setTimeout(() => {
      const opt = document.querySelector(
        '.ant-select-item-option, .next-menu-item, [role="option"]',
      );
      if (opt) opt.click();
    }, 80);
  }

  function setDateField(row, date) {
    if (!date) return;
    const el = pickField(row, [
      'input[type="date"]',
      'input[placeholder*="日期"]',
      'input[placeholder*="Date"]',
      '[data-field="date"] input',
    ]);
    if (!el) return;
    nativeSetValue(el, date);
    fireInput(el);
    fireChange(el);
  }

  function setCurrencyField(row, currency) {
    if (!currency) return;
    const sel = pickField(row, [
      'select[name*="currency"]',
      '[data-field="currency"] input',
      '[class*="currency"] input',
      '[class*="Currency"] input',
    ]);
    if (!sel) return;
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
      ).find((o) =>
        (o.textContent || "").toUpperCase().includes(currency),
      );
      if (opt) opt.click();
    }, 80);
  }

  function setAmountField(row, amount) {
    if (amount == null) return;
    const el = pickField(row, [
      'input[type="number"]',
      'input[placeholder*="金额"]',
      'input[placeholder*="Amount"]',
      '[data-field="amount"] input',
      '[class*="amount"] input',
    ]);
    if (!el) return;
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
    ]);
    if (!el) return;
    nativeSetValue(el, note);
    fireInput(el);
    fireChange(el);
  }

  function pickField(scope, selectors) {
    for (const s of selectors) {
      const el = scope.querySelector(s);
      if (el) return el;
    }
    return null;
  }

  async function trySaveDraft() {
    const btn = Array.from(document.querySelectorAll("button")).find((b) =>
      /^(暂存|保存|保存草稿|Save Draft|Save)$/i.test((b.textContent || "").trim()),
    );
    if (btn && !btn.disabled) {
      btn.click();
      await sleep(400);
    }
  }

  /* ---------- React/Vue-friendly value setting ---------- */
  function nativeSetValue(el, value) {
    const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
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
