/*
 * FliggyClaim — content script for the Alibaba TAE expense system.
 *
 * Automates the real-world drawer flow:
 *   1. click "新增费用"                       → category PICKER drawer opens
 *   2. click a leaf ("差旅-住宿", "差旅-餐费"…) → category FORM drawer opens
 *   3. fill the fields for that category, attach the receipt
 *   4. click "保存"                           → drawer closes, a row is added
 *
 * Layout of this file
 *   §1 constants   — category leaves, field labels, every Kuma/TAE selector, timings
 *   §2 messaging   — FLIGGY_PING / FLIGGY_FILL / FLIGGY_DIAG
 *   §3 fill flow   — fillRecords → fillSingleExpense
 *   §4 fields      — per-category field filling (dates, city, currency, amount, note)
 *   §5 finders     — label → field container → control; drawer / picker / buttons
 *   §6 setters     — text (React-aware), combobox, readonly calendar, file upload
 *   §7 diagnostics — 诊断 report
 *   §8 helpers     — click / visibility / sleep / waitFor / overlay / dates
 *   §9 test hook   — internals exposed only when window.__FLIGGY_TEST__ is set
 *
 * Design rules that came out of 16 hotfixes (keep them):
 *   • Field lookup is LABEL → its own Kuma field container → control INSIDE it.
 *     Never walk to a sibling field: a field container whose only text is its
 *     label ("金额") satisfies a naive text match and would send you to the
 *     next field's control.
 *   • The category is what we clicked (rec.type), never a title sniff.
 *   • Currency is set BEFORE amount (TAE clears amount on currency change).
 *   • Never dispatch a document-level Escape — it cancels TAE's FX confirm modal.
 *   • Kuma calendar inputs are readonly: open the popup and click the day cell.
 *   • Kuma comboboxes carry an internal search <input> — it is not a form field.
 *   • Only run execCommand on the element that actually has focus.
 */
(() => {
  "use strict";

  if (window.__fliggyClaimInjected) {
    window.__fliggyClaimInjected = "reused";
  } else {
    window.__fliggyClaimInjected = true;
  }

  const TAG = "%c[FliggyClaim]";
  const TAG_CSS = "color:#d71e1e;font-weight:bold";
  const log = (...a) => console.log(TAG, TAG_CSS, ...a);
  const warn = (...a) => console.warn(TAG, TAG_CSS, ...a);

  log("content script loaded on", location.href, "frame:", window.top === window ? "top" : "iframe");

  /* ======================================================================
   * §1 constants
   * ==================================================================== */

  // Internal type → TAE picker leaf text (ordered candidates).
  const CATEGORY_LEAF = {
    flight: ["差旅-机票", "差旅-机", "机票"],
    hotel: ["差旅-住宿", "住宿", "差旅-酒店"],
    meal: ["差旅-餐费", "差旅-餐饮", "餐费", "餐饮"],
    taxi: ["差旅-打车", "差旅-出租车", "打车"],
    train: ["差旅-火车", "差旅-高铁", "差旅-动车", "火车", "高铁"],
    other: ["差旅-其他", "差旅-其它", "其他"],
  };

  // Field labels as they appear in the drawer forms (exact, after normalizeLabelText).
  const LABELS = {
    date: ["费用发生时间", "发生日期", "消费日期", "费用日期", "日期"],
    flightDate: ["乘机日期"],
    checkin: ["入住时间"],
    checkout: ["离店时间"],
    city: ["费用发生城市", "发生城市", "城市"],
    amount: ["金额", "费用金额", "总金额"],
    currency: ["币种", "货币", "Currency"],
    rate: ["汇率", "Exchange Rate"],
    convertedAmount: ["折算金额", "本位币金额", "报销金额", "申请金额"],
    note: ["详细说明", "备注", "说明", "事由"],
    rideshare: ["是否网约车"],
    hotelReceipt: ["酒店住宿相关凭证"], // required on hotel; the 📎 column tracks 附件 though
    attachment: ["附件"],
  };

  // Every Kuma / TAE class name we depend on lives here. Brittleness:
  //   HIGH  = CSS-modules hash prefix or an exclusion (a rename silently
  //           changes behaviour) — covered by the finder-level tests.
  //   MED   = library namespace (kuma-*) — stable across TAE builds so far.
  //   LOW   = generic ARIA / element selectors.
  const SEL = {
    fieldContainer: /\bfield_/,                                                    // HIGH  div.field_PlvYD
    textInput: 'input.kuma-input, input[class*="kuma-input"], textarea',           // MED
    dateWrapper: '.kuma-calendar-picker-input, [class*="calendar-picker"]',        // MED
    // NB: a selector LIST — "<wrapper> input" has to be spelled out per
    // alternative; `${dateWrapper} input` would match the wrapper itself.
    dateInput: '.kuma-calendar-picker-input input, [class*="calendar-picker"] input', // MED
    dateTrigger: '.kuma-calendar-trigger-icon, [class*="trigger-icon"], i[class*="riqi"]', // MED
    calendarPanel: '.kuma-calendar-panel, .kuma-calendar, [class*="calendar-panel"], [class*="calendar-popup"]', // MED
    calendarHeader: '[class*="my-select"], [class*="month-select"], [class*="year-select"], [class*="calendar-header"]', // MED
    calendarNext: '[class*="next-month"], [class*="next-btn"]',                    // MED
    calendarPrev: '[class*="prev-month"], [class*="prev-btn"]',                    // MED
    calendarCell: 'td, [role="gridcell"], [class*="calendar-cell"]',               // LOW
    calendarOtherMonth: /(prev|next|last|other)[-_]?month|disabled/i,              // MED
    combobox: '[role="combobox"]',                                                 // LOW
    comboboxSearch: 'input.kuma-select2-search__field, input[class*="select2-search"]', // MED
    comboboxSelected: '.kuma-select2-selection-selected-value, [class*="selected-value"]', // MED
    comboboxRoot: '.kuma-select2, [class*="select2"], [class*="select_"]',         // MED
    comboboxOption: '[role="option"], li[class*="option"], div[class*="option-item"], div[class*="MenuItem"]', // LOW
    internalSearch: /select2-search|employee-search/,                              // HIGH  exclusion
    tableScope: "th, td, tr, thead, tbody, table, [role='columnheader'], [role='rowheader'], [role='gridcell'], [role='grid']", // LOW
    labelTags: "label, span, div, dt, p, th",                                      // LOW
    anyControl: 'input:not([type="hidden"]), textarea, select, [role="combobox"]', // LOW
  };

  // Timings (ms). "settle" = no observable to wait on; "wait" = polled via waitFor.
  const T = {
    pickerWait: 5000,
    formWait: 10000,        // TAE loads the schema on first open; 2–3s is normal
    drawerCloseWait: 6000,
    leafWait: 1500,
    optionsWait: 1500,
    calendarOpenWait: 800,
    rateWait: 2500,
    afterClickSettle: 150,
    comboboxSettle: 120,
    fxRateSettle: 450,      // TAE fires an FX request after a currency change
    amountSettle: 180,
    reactCommitSettle: 60,
    calendarNavSettle: 140,
    dayClickSettle: 200,
    attachSettle: 1500,     // upload component registers the file
    betweenRecords: 700,
  };

  /* ======================================================================
   * §2 messaging
   * ==================================================================== */

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
        sendResponse({ ok: true, report: diagnose(msg.records || null) });
      } catch (err) {
        sendResponse({ ok: false, error: err?.message || String(err) });
      }
      return false;
    }
    if (msg.type === "FLIGGY_FILL") {
      fillRecords(msg.records || [], msg.attachments || {})
        .then((res) => sendResponse({ ok: true, ...res }))
        .catch((err) => {
          warn("fill error:", err);
          sendResponse({ ok: false, error: err?.message || String(err) });
        });
      return true; // async response
    }
  }

  /* ======================================================================
   * §3 fill flow
   * ==================================================================== */

  // Populated by fillRecords; surfaced via diagnose().
  let lastFillSummary = null;

  async function fillRecords(records, attachments) {
    log(`starting fill: ${records.length} records, attachments: ${Object.keys(attachments || {}).length}`);
    let filled = 0;
    let attached = 0;
    const perRecord = [];
    showOverlay(`准备写入 ${records.length} 条…`);
    for (let i = 0; i < records.length; i++) {
      const rec = records[i];
      const att = attachments && attachments[rec.source];
      showOverlay(`写入第 ${i + 1} / ${records.length} 条 (${rec.type})…`);
      const slot = { index: i + 1, type: rec.type, currency: rec.currency, amount: rec.amount, ok: false, error: null, amountFinal: null, via: null };
      try {
        const result = await fillSingleExpense(rec, att);
        filled++;
        if (result.attached) attached++;
        slot.ok = true;
        slot.amountFinal = result.amountFinal;
        slot.via = result.via;
        log(`✓ filled record ${i + 1}/${records.length}`, rec, result);
      } catch (e) {
        warn(`× record ${i + 1}/${records.length} failed:`, rec, e);
        slot.error = e?.message || String(e);
        await tryCancelDrawer();
      }
      perRecord.push(slot);
      await sleep(T.betweenRecords);
    }
    lastFillSummary = { at: new Date().toISOString(), total: records.length, filled, attached, perRecord };
    hideOverlay(`已写入 ${filled} / ${records.length} 条 (附件 ${attached})`);
    if (filled === 0) {
      throw new Error("0 条写入成功——请打开 DevTools 控制台查看 [FliggyClaim] 日志");
    }
    return { filled, attached };
  }

  async function fillSingleExpense(rec, attachment) {
    const type = CATEGORY_LEAF[rec.type] ? rec.type : "other";

    // 1. 新增费用 → picker
    const addBtn = findAddExpenseButton();
    if (!addBtn) throw new Error("没找到「新增费用」按钮");
    log("→ clicking 新增费用", addBtn);
    clickEl(addBtn);
    await waitFor(findCategoryPicker, T.pickerWait, "category picker");

    // 2. leaf → form
    const leaf = await findCategoryLeaf(type);
    if (!leaf) throw new Error(`没找到「${CATEGORY_LEAF[type][0]}」类别项`);
    log("→ clicking category leaf", leaf);
    clickEl(leaf);
    const form = await waitFor(findCategoryForm, T.formWait, "category form");
    log("→ category form opened:", sniffFormTitle(form) || "(no title in scope)", "type:", type, form);

    // 3. fields + attachment
    const outcome = await fillFormFields(form, rec, type);
    let attached = false;
    if (attachment && attachment.data) {
      attached = await attachReceiptFile(liveForm(form), attachment, rec.source, type);
    }

    // 4. 保存 → drawer closes
    const saveBtn = findSaveButton(liveForm(form));
    if (!saveBtn) throw new Error("没找到表单内的「保存」按钮");
    log("→ clicking 保存", saveBtn);
    clickEl(saveBtn);
    await waitFor(() => !findCategoryForm(), T.drawerCloseWait, "drawer close");
    return { attached, ...outcome };
  }

  // TAE may re-mount the drawer body (e.g. after a currency change). Any
  // lookup that runs after an await should go through this so a detached
  // `form` reference is transparently re-resolved.
  function liveForm(form) {
    if (form && form.isConnected) return form;
    return findCategoryForm() || form;
  }

  /* ======================================================================
   * §4 per-category field filling
   * ==================================================================== */

  async function fillFormFields(form, rec, type) {
    const scope = () => liveForm(form);
    const outcome = { amountFinal: null, amountInput: null, via: null };

    // --- dates ---------------------------------------------------------
    if (type === "hotel") {
      const checkin = rec.checkin || rec.date;
      const checkout = rec.checkout || addDays(checkin, rec.nights || 1);
      await setDateField(scope(), LABELS.checkin, checkin, "入住时间");
      await setDateField(scope(), LABELS.checkout, checkout, "离店时间");
    } else {
      await setDateField(scope(), LABELS.date, rec.date, "费用发生时间"); // optional
      if (type === "flight") await setDateField(scope(), LABELS.flightDate, rec.date, "乘机日期★");
    }

    // --- city (required on hotel; present on some other forms) --------
    await setComboboxField(scope(), LABELS.city, [rec.city || "上海"], "城市");

    // --- taxi: 是否网约车 → 是 ------------------------------------------
    if (type === "taxi") {
      const yes = findRadioOption(scope(), LABELS.rideshare, "是");
      if (yes) clickEl(yes); else warn("是否网约车 option not found");
    }

    // --- currency BEFORE amount ---------------------------------------
    await setCurrencyField(scope(), rec.currency || "CNY");

    // Collapse any dropdown still open. Body-click only: a document-level
    // Escape would also cancel TAE's "currency changed, recompute FX?" modal.
    document.body.click();
    await sleep(T.afterClickSettle);

    // --- amount -------------------------------------------------------
    const wantAmt = String(rec.amount ?? 0);
    if (!(parseFloat(wantAmt) > 0)) {
      warn(`amount is 0 / missing for ${rec.type} ${rec.source}; the form will reject 保存 — fix it in the popup first.`);
    }
    const amt = resolveAmountInput(scope());
    log("→ amount input:", amt ? describeInput(amt) : "NOT FOUND");
    if (amt) {
      let via = await setInputValue(amt, wantAmt);
      await sleep(T.amountSettle);
      nudgeChange(amt);
      document.body.click();
      await sleep(T.comboboxSettle);
      // Verify with a fresh lookup (TAE can re-mount the input) and retry once.
      let fresh = resolveAmountInput(scope()) || amt;
      if (!valueEquals(fresh, wantAmt)) {
        log("amount didn't stick; retrying. got:", fresh.value, "want:", wantAmt);
        via = await setInputValue(fresh, wantAmt);
        await sleep(T.amountSettle);
        nudgeChange(fresh);
        document.body.click();
        fresh = resolveAmountInput(scope()) || fresh;
      }
      log("amount final value:", fresh.value, "via", via);
      outcome.amountFinal = fresh.value;
      outcome.amountInput = describeInput(fresh);
      outcome.via = via;
      await waitForRatePopulated(scope, T.rateWait);
    } else {
      warn("amount input not found — run 诊断 and look at amountDeepProbe");
    }

    // --- note ---------------------------------------------------------
    const note = findTextInput(scope(), LABELS.note);
    if (note) await setInputValue(note, rec.note || "");
    else log("note field not found (optional)");

    return outcome;
  }

  async function setDateField(form, labels, iso, what) {
    if (!iso) return false;
    const el = findDateInput(form, labels);
    if (!el) { log(`→ ${what}: field not found (skipped)`); return false; }
    const ok = await setDateLikeValue(el, iso);
    log(`→ ${what}:`, ok ? "set" : "FAILED", iso, "now:", el.value);
    return ok;
  }

  async function setComboboxField(form, labels, candidates, what) {
    const el = findCombobox(form, labels);
    if (!el) { log(`→ ${what}: field not found (skipped)`); return false; }
    const ok = await setComboboxValue(el, candidates);
    log(`→ ${what}:`, ok ? "set" : "FAILED", candidates[0], "now:", readComboboxSelected(el));
    return ok;
  }

  // Set currency, wait for the FX request, read back the rendered selection
  // and retry once with a fresh lookup if it didn't commit.
  async function setCurrencyField(form, code) {
    const el = findCombobox(form, LABELS.currency);
    if (!el) { log("→ 币种: field not found (skipped)"); return false; }
    await setComboboxValue(el, [code]);
    await sleep(T.fxRateSettle);
    let shown = readComboboxSelected(findCombobox(liveForm(form), LABELS.currency) || el);
    log("→ 币种 displayed after set:", shown);
    if (!shown.startsWith(code)) {
      const again = findCombobox(liveForm(form), LABELS.currency);
      if (again) {
        log("→ 币种 didn't take, retrying");
        await setComboboxValue(again, [code]);
        await sleep(T.fxRateSettle);
        shown = readComboboxSelected(again);
        log("→ 币种 displayed after retry:", shown);
      }
    }
    return shown.startsWith(code);
  }

  // Poll for a non-zero exchange rate / converted amount. Both are absent when
  // the record currency equals the report base currency — then we just time out.
  async function waitForRatePopulated(scope, timeoutMs) {
    const filled = (el) => {
      if (!el) return false;
      const n = parseFloat(String(el.value ?? el.textContent ?? "").replace(/,/g, ""));
      return !isNaN(n) && n > 0;
    };
    return waitFor(() => filled(findFieldControl(scope(), LABELS.rate)) || filled(findFieldControl(scope(), LABELS.convertedAmount)),
      timeoutMs, "rate populated").then(() => true, () => false);
  }

  /* ======================================================================
   * §5 finders
   * ==================================================================== */

  // "* 金额：" → "金额". Strips both ends: required markers, colons, spaces.
  function normalizeLabelText(s) {
    return (s || "").replace(/\s+/g, " ").trim().replace(/^[*＊\s]+/, "").replace(/[*＊：:\s]+$/, "");
  }

  function isInTableScope(el) {
    return !!(el && el.closest && el.closest(SEL.tableScope));
  }

  function classOf(el) {
    return typeof el?.className === "string" ? el.className : "";
  }

  function isInternalSearch(el) {
    return SEL.internalSearch.test(classOf(el));
  }

  // All elements in `scope` whose normalized text equals one of `labels`.
  //   • cheap text test first, isVisible (layout) second
  //   • INNERMOST only — a container whose text is just the label because its
  //     controls carry no text is NOT the label
  //   • prefer elements outside table chrome (the expense list has a 金额
  //     column header); fall back to all if that leaves nothing
  function findLabelEls(scope, labels, tags = SEL.labelTags) {
    const all = Array.from((scope || document).querySelectorAll(tags))
      .filter((el) => labels.includes(normalizeLabelText(el.textContent)))
      .filter(isVisible);
    const innermost = all.filter((el) => !all.some((o) => o !== el && el.contains(o)));
    const nonTable = innermost.filter((el) => !isInTableScope(el));
    return nonTable.length ? nonTable : innermost;
  }

  // The Kuma form item that owns a label: nearest ancestor with a `field_…`
  // class; else the nearest ancestor (≤4 up) that contains any control.
  function fieldContainerOf(lbl, maxUp = 6) {
    let cur = lbl;
    for (let i = 0; i < maxUp && cur; i++) {
      if (SEL.fieldContainer.test(classOf(cur))) return cur;
      cur = cur.parentElement;
    }
    cur = lbl.parentElement;
    for (let i = 0; i < 4 && cur; i++) {
      if (cur.querySelector && cur.querySelector(SEL.anyControl)) return cur;
      cur = cur.parentElement;
    }
    return lbl.parentElement || lbl;
  }

  // Generic: for each matching label, look for a control INSIDE its own field
  // container. `pick(container, label)` returns the control or null.
  function findControlInField(scope, labels, pick) {
    for (const lbl of findLabelEls(scope, labels)) {
      const hit = pick(fieldContainerOf(lbl), lbl);
      if (hit) return hit;
    }
    return null;
  }

  // Editable text field (kuma-input[type=text] or textarea), not readonly,
  // never a combobox's internal search box.
  function findTextInput(scope, labels) {
    return findControlInField(scope, labels, (c) =>
      Array.from(c.querySelectorAll(SEL.textInput)).find((el) =>
        isVisible(el) && !el.readOnly && !el.disabled && !isInternalSearch(el) &&
        (el.tagName === "TEXTAREA" || el.type === "text" || el.type === "number" || !el.type)) || null);
  }

  // Readonly calendar input inside a Kuma date wrapper.
  function findDateInput(scope, labels) {
    return findControlInField(scope, labels, (c) =>
      c.querySelector(SEL.dateInput) ||
      Array.from(c.querySelectorAll("input[readonly]")).find(isVisible) || null);
  }

  // The combobox WRAPPER (role=combobox) or a native <select>.
  function findCombobox(scope, labels) {
    return findControlInField(scope, labels, (c) => c.querySelector(SEL.combobox) || c.querySelector("select") || null);
  }

  function findFileInput(scope, labels) {
    return findControlInField(scope, labels, (c) => c.querySelector('input[type="file"]:not([disabled])'));
  }

  function findAnyFileInput(scope) {
    const inputs = Array.from((scope || document).querySelectorAll('input[type="file"]'));
    return inputs.find((i) => !i.disabled) || inputs[0] || null;
  }

  // A radio/checkbox option by its visible text ("是"/"否") inside a labelled field.
  function findRadioOption(scope, labels, optionText) {
    return findControlInField(scope, labels, (c) =>
      Array.from(c.querySelectorAll("label, span")).find((s) => (s.textContent || "").trim() === optionText && isVisible(s)) || null);
  }

  // Any control in the field, readonly included (for read-back: 汇率, 报销金额).
  function findFieldControl(scope, labels) {
    return findControlInField(scope, labels, (c) =>
      Array.from(c.querySelectorAll(SEL.anyControl)).find((el) => !isInternalSearch(el)) || null);
  }

  // ---- amount ----------------------------------------------------------
  function isAmountLike(el) {
    return !!el && el.tagName === "INPUT" && (el.type === "text" || el.type === "number") &&
      !el.readOnly && !el.disabled && !isInternalSearch(el);
  }

  // Structural lookup first (label → field → kuma-input), geometric fallback
  // second. Both results are validated with isAmountLike so a checkbox,
  // a readonly 汇率 box or a select2 search field can never be returned.
  function resolveAmountInput(scope) {
    const byField = findTextInput(scope, LABELS.amount);
    if (isAmountLike(byField)) return byField;
    const byGeom = findAmountInputByGeometry(scope);
    if (isAmountLike(byGeom)) return byGeom;
    return null;
  }

  // Visual fallback: the closest editable input to the right of / just below a
  // "金额" label. Only used if the structural lookup fails (e.g. field_ renamed).
  function findAmountInputByGeometry(scope) {
    const labelEls = findLabelEls(scope, LABELS.amount, "label, span, div, dt, p, th, em, b, strong");
    if (!labelEls.length) return null;
    const inputs = Array.from((scope || document).querySelectorAll('input:not([type="hidden"]):not([type="file"]):not([type="checkbox"]):not([type="radio"]):not([disabled]):not([readonly])'))
      .filter(isVisible).filter((el) => !isInTableScope(el) && !isInternalSearch(el));
    let best = null, bestScore = -Infinity;
    for (const lbl of labelEls) {
      const lr = lbl.getBoundingClientRect();
      for (const inp of inputs) {
        const ir = inp.getBoundingClientRect();
        const vOverlap = Math.min(lr.bottom, ir.bottom) - Math.max(lr.top, ir.top);
        const hOverlap = Math.min(lr.right, ir.right) - Math.max(lr.left, ir.left);
        const sameRow = vOverlap > 5 && ir.left >= lr.right - 4;
        const below = ir.top >= lr.bottom - 4 && ir.top - lr.bottom < 30 && hOverlap > 20;
        if (!sameRow && !below) continue;
        const dist = sameRow ? ir.left - lr.right : ir.top - lr.bottom + Math.abs((ir.left + ir.right) / 2 - (lr.left + lr.right) / 2);
        let score = -dist;
        if (/请输入|amount/.test(inp.placeholder || "")) score += 50;
        if (inp.type === "number") score += 100;
        if (/kuma-input/.test(classOf(inp))) score += 80;
        if (/金额/.test(inp.getAttribute("aria-label") || "")) score += 200;
        if (score > bestScore) { bestScore = score; best = inp; }
      }
    }
    return best;
  }

  // ---- page-level ------------------------------------------------------
  function findAddExpenseButton() {
    const all = Array.from(document.querySelectorAll("button, a, [role=button]")).filter(isVisible);
    return all.find((b) => /^(\+\s*)?新增费用$/.test((b.textContent || "").trim()))
      || all.find((b) => /^\+\s*新增$/.test((b.textContent || "").trim()))
      || all.find((b) => /新增费用/.test((b.textContent || "").trim()))
      || null;
  }

  // Picker = a panel with a "选择费用类型" header that contains category text.
  function findCategoryPicker() {
    const headers = Array.from(document.querySelectorAll("h1, h2, h3, h4, div, span"))
      .filter((el) => /^选择费用类型/.test((el.textContent || "").trim()))
      .filter(isVisible);
    for (const h of headers) {
      let cur = h;
      for (let i = 0; i < 8 && cur; i++) {
        if (cur.querySelectorAll && cur.querySelectorAll("*").length > 5 && /差旅|常用|新人|招待/.test(cur.textContent || "")) return cur;
        cur = cur.parentElement;
      }
    }
    return null;
  }

  async function findCategoryLeaf(type) {
    const candidates = CATEGORY_LEAF[type] || CATEGORY_LEAF.other;
    let leaf = findVisibleByExactText(candidates);
    if (leaf) return leaf;
    // Expand the 差旅 group on the left, then wait for the leaf to render.
    const group = findVisibleByExactText(["差旅"]);
    if (group) {
      log("→ expanding 差旅 parent group");
      clickEl(group);
      leaf = await waitFor(() => findVisibleByExactText(candidates), T.leafWait, "category leaf").catch(() => null);
      if (leaf) return leaf;
    }
    return findVisibleByContains(candidates);
  }

  // The category FORM drawer, anchored on its 「保存」 button (the picker has
  // none). Walk up from the button to the nearest ancestor that holds form
  // controls and category-form text. TAE nests the body 7–9 levels deep, so
  // walking up from the title text is not reliable.
  function findCategoryForm() {
    for (const save of findSaveButtons(document)) {
      let cur = save.parentElement;
      for (let i = 0; i < 14 && cur; i++) {
        if (cur.querySelector && cur.querySelector(SEL.anyControl) &&
            /差旅-|有收据|无收据|费用发生|金额|币种|入住时间|乘机日期/.test(cur.textContent || "")) {
          return cur;
        }
        cur = cur.parentElement;
      }
    }
    return null;
  }

  // "保存" / "保存 ▾" — never "保存草稿".
  function findSaveButtons(scope) {
    return Array.from((scope || document).querySelectorAll("button"))
      .filter((b) => { const t = (b.textContent || "").trim(); return t.startsWith("保存") && !t.startsWith("保存草稿"); })
      .filter(isVisible);
  }
  function findSaveButton(scope) {
    const all = findSaveButtons(scope);
    return all.find((b) => (b.textContent || "").trim() === "保存") || all[0] || null;
  }

  function findCancelButton(scope) {
    return Array.from((scope || document).querySelectorAll("button, a"))
      .filter((b) => /^取消$/.test((b.textContent || "").trim()))
      .filter(isVisible)[0] || null;
  }

  async function tryCancelDrawer() {
    const f = findCategoryForm();
    if (f) {
      const c = findCancelButton(f);
      if (c) { clickEl(c); await sleep(300); return; }
    }
    const picker = findCategoryPicker();
    if (picker) {
      const c = findCancelButton(picker);
      if (c) clickEl(c);
    }
  }

  // Log-only: the drawer title ("差旅-住宿") lives in a sibling of the form
  // body, so look in the form and a few ancestors.
  function sniffFormTitle(form) {
    let cur = form;
    for (let i = 0; i < 4 && cur; i++) {
      const el = Array.from(cur.querySelectorAll("h1, h2, h3, h4, div, span"))
        .filter((e) => /^差旅-/.test((e.textContent || "").trim()) && (e.textContent || "").trim().length < 12)
        .filter((e) => !isInTableScope(e))
        .find(isVisible);
      if (el) return (el.textContent || "").trim();
      cur = cur.parentElement;
    }
    return "";
  }

  function findVisibleByExactText(texts) {
    return Array.from(document.querySelectorAll("a, span, div, li, button, [role=menuitem]"))
      .filter((el) => {
        const text = (el.textContent || "").trim();
        const title = (el.getAttribute && el.getAttribute("title") || "").trim();
        // Kuma cascade items wrap the text in a custom <icon>; `title` is on the <li>.
        return (texts.includes(text) || (title && texts.includes(title)))
          && (text.length <= 20 || (title && title.length <= 20))
          && el.children.length <= 3;
      })
      .find(isVisible) || null;
  }

  function findVisibleByContains(texts) {
    return Array.from(document.querySelectorAll("a, span, div, li, button, [role=menuitem]"))
      .filter((el) => { const t = (el.textContent || "").trim(); return texts.some((x) => t.includes(x)) && t.length <= 30 && el.children.length <= 3; })
      .find(isVisible) || null;
  }

  /* ======================================================================
   * §6 setters
   * ==================================================================== */

  // React 16+ stashes the props bag on every host node it renders.
  function getReactProps(el) {
    if (!el) return null;
    const k = Object.keys(el).find((s) => s.startsWith("__reactProps$"));
    return k ? el[k] : null;
  }

  // Canonical "setNativeValue": call the PROTOTYPE setter (native), not the
  // per-instance one React installs, so React's value tracker sees a change.
  function setNativeValue(el, value) {
    const own = Object.getOwnPropertyDescriptor(el, "value") || {};
    const proto = Object.getPrototypeOf(el) || HTMLInputElement.prototype;
    const protoDesc = Object.getOwnPropertyDescriptor(proto, "value") || {};
    if (protoDesc.set && own.set !== protoDesc.set) protoDesc.set.call(el, value);
    else if (own.set) own.set.call(el, value);
    else el.value = value;
  }

  function valueEquals(el, str) {
    const a = String(el?.value ?? "").replace(/,/g, "").trim();
    const b = String(str).trim();
    if (a === b) return true;
    const na = parseFloat(a), nb = parseFloat(b);
    return !isNaN(na) && !isNaN(nb) && na === nb;
  }

  // Text-editable host: the only kind of element execCommand may target.
  function isEditable(el) {
    if (!el) return false;
    if (el.tagName === "TEXTAREA") return true;
    if (el.tagName === "INPUT") return !/^(checkbox|radio|file|hidden|button|submit|reset|image|range|color)$/.test(el.type || "");
    return el.isContentEditable === true;
  }

  // Fire input + change now; blur on the next tick (Kuma's onBlur reformatter
  // races React's batched commit if blur is synchronous).
  function dispatchInputEvents(el, str) {
    try {
      el.dispatchEvent(new InputEvent("input", { bubbles: true, data: str ?? el.value, inputType: "insertText" }));
    } catch {
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }
    el.dispatchEvent(new Event("change", { bubbles: true }));
    setTimeout(() => { try { el.dispatchEvent(new Event("blur", { bubbles: true })); } catch {} }, 0);
  }

  function nudgeChange(el) {
    try {
      el.dispatchEvent(new Event("change", { bubbles: true }));
      el.dispatchEvent(new FocusEvent("blur", { bubbles: true }));
    } catch {}
  }

  // Write `value` into a text-like control. Returns the strategy that worked
  // ("react" | "exec" | "native") or false.
  //   A. React fiber: call the onChange prop directly — bypasses every
  //      dispatch/tracker/IME quirk on Fusion/Kuma/Ant controlled inputs.
  //   B. execCommand("insertText"): a real InputEvent, ONLY if the element
  //      actually has focus (otherwise Chrome types into whatever is focused).
  //   C. Native setter + React tracker reset + synthetic events.
  async function setInputValue(el, value) {
    if (!el) return false;
    const str = String(value);
    try {
      try { el.focus(); } catch {}

      // A
      try {
        const props = getReactProps(el);
        const handler = props && (props.onChange || props.onInput);
        if (typeof handler === "function") {
          setNativeValue(el, str);
          handler({ target: el, currentTarget: el, type: "change", bubbles: true, cancelable: true,
            preventDefault() {}, stopPropagation() {}, persist() {}, nativeEvent: null });
          dispatchInputEvents(el, str);
          await sleep(T.reactCommitSettle);
          if (valueEquals(el, str)) return "react";
        }
      } catch (e) {
        warn("setInputValue strategy A (react props) failed:", e);
      }

      // B — guarded: execCommand acts on the document SELECTION, which can
      // still sit inside a previously focused <input> even after focusing a
      // focusable-but-non-editable node (a tabindex=0 combobox wrapper). Only
      // run it for an editable element that actually holds focus.
      if (isEditable(el) && document.activeElement === el && !el.readOnly) {
        try {
          if (typeof el.select === "function") el.select();
          if (document.execCommand && document.execCommand("insertText", false, str) && valueEquals(el, str)) {
            dispatchInputEvents(el, str);
            return "exec";
          }
        } catch {}
      }

      // C
      const oldValue = el.value;
      setNativeValue(el, str);
      const tracker = el._valueTracker;
      if (tracker && typeof tracker.setValue === "function" && oldValue !== str) {
        try { tracker.setValue(oldValue); } catch {}
      }
      dispatchInputEvents(el, str);
      return valueEquals(el, str) ? "native" : false;
    } catch (e) {
      warn("setInputValue failed:", e);
      return false;
    }
  }

  // Kuma calendar: readonly input → open popup → navigate month → click day.
  async function setDateLikeValue(el, iso) {
    if (!el || !iso) return false;
    if (el.type === "date") return !!(await setInputValue(el, iso));
    const m = iso.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if (!m) { warn("invalid ISO date", iso); return false; }
    const year = +m[1], month = +m[2], day = +m[3];

    // 1. open
    const wrapper = (el.closest && el.closest(SEL.dateWrapper)) || el.parentElement;
    const trigger = (wrapper && wrapper.querySelector && wrapper.querySelector(SEL.dateTrigger)) || el;
    try { el.focus(); } catch {}
    clickEl(trigger);
    const findPanel = () => {
      const panels = Array.from(document.querySelectorAll(SEL.calendarPanel)).filter(isVisible);
      return panels.length ? panels[panels.length - 1] : null;
    };
    let panel = await waitFor(findPanel, T.calendarOpenWait, "calendar panel").catch(() => null);
    if (!panel) {
      clickEl(el);
      panel = await waitFor(findPanel, T.calendarOpenWait, "calendar panel").catch(() => null);
    }
    if (!panel) { warn("date picker did not open for", iso); return false; }

    // 2. navigate to the month (re-resolve the panel each step — Kuma re-renders it)
    const targetTotal = year * 12 + month;
    for (let i = 0; i < 36; i++) {
      panel = findPanel() || panel;
      const headerText = Array.from(panel.querySelectorAll(SEL.calendarHeader)).map((h) => (h.textContent || "").trim()).join(" ")
        || (panel.textContent || "").slice(0, 40);
      const ym = headerText.match(/(\d{4})[^\d]+(\d{1,2})/);
      if (!ym) { warn("can't parse calendar header:", headerText); break; }
      const currTotal = (+ym[1]) * 12 + (+ym[2]);
      if (currTotal === targetTotal) break;
      const nav = panel.querySelector(currTotal < targetTotal ? SEL.calendarNext : SEL.calendarPrev);
      if (!nav) { warn("no month nav button in calendar"); break; }
      clickEl(nav);
      await sleep(T.calendarNavSettle);
    }

    // 3. click the day
    panel = findPanel() || panel;
    const cells = Array.from(panel.querySelectorAll(SEL.calendarCell)).filter(isVisible);
    const cn = `${year}年${month}月${day}日`;
    let cell = cells.find((c) => {
      const title = c.getAttribute("title") || "", aria = c.getAttribute("aria-label") || "";
      return title.includes(iso) || aria.includes(iso) || title.includes(cn) || aria.includes(cn);
    });
    if (!cell) {
      cell = cells.find((c) => !SEL.calendarOtherMonth.test(classOf(c)) && (c.textContent || "").trim() === String(day));
    }
    if (!cell) { warn("no day cell for", iso); return false; }
    clickEl(cell);
    await sleep(T.dayClickSettle);
    document.body.click();
    return true;
  }

  function readComboboxSelected(el) {
    if (!el) return "";
    if (el.tagName === "SELECT") return (el.options[el.selectedIndex]?.textContent || "").trim();
    const root = (el.closest && el.closest(SEL.comboboxRoot)) || el;
    const sv = root.querySelector && root.querySelector(SEL.comboboxSelected);
    return (sv && sv.textContent || "").trim();
  }

  // "CNY (人民币)" vs TAE's "CNY (人民币）" (full-width paren) → compare with parens stripped.
  const normParens = (s) => (s || "").replace(/[()（）]/g, "").replace(/\s+/g, " ").trim();

  // Kuma select2: click the wrapper to open, type into the INTERNAL search
  // input to filter, click the matching option, collapse.
  async function setComboboxValue(el, candidateTexts) {
    if (!el) return false;
    if (el.tagName === "SELECT") {
      const opt = Array.from(el.options).find((o) => candidateTexts.some((t) => (o.textContent || "").includes(t)));
      if (!opt) return false;
      el.value = opt.value;
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    }
    const isText = (n) => n && (n.tagName === "INPUT" || n.tagName === "TEXTAREA");
    let typingTarget = isText(el) ? el
      : (el.querySelector && el.querySelector(SEL.comboboxSearch))
        || (el.parentElement && el.parentElement.querySelector && el.parentElement.querySelector(SEL.comboboxSearch))
        || null;

    try { el.focus(); } catch {}
    clickEl(el);
    await sleep(T.afterClickSettle);

    // Type only the leading token ("CNY" of "CNY (人民币)", "深圳"): select2
    // filters by substring, so typing a full display string with half-width
    // parens would filter TAE's full-width-paren option OUT of the list.
    const filterText = String(candidateTexts.find(Boolean) || "").split(/[\s(（]/)[0];
    if (isText(typingTarget) && filterText) {
      try { typingTarget.focus(); } catch {}
      try {
        const proto = typingTarget.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
        if (setter) setter.call(typingTarget, filterText); else typingTarget.value = filterText;
      } catch (e) {
        warn("combobox: typing into search input failed (will still try option click):", e);
      }
      typingTarget.dispatchEvent(new Event("input", { bubbles: true }));
    }

    const visibleOptions = () => Array.from(document.querySelectorAll(SEL.comboboxOption)).filter(isVisible);
    const opts = await waitFor(() => { const o = visibleOptions(); return o.length ? o : null; }, T.optionsWait, "combobox options").catch(() => []);
    log("combobox options visible:", opts.length, opts.slice(0, 5).map((o) => (o.textContent || "").trim()));
    const opt = opts.find((o) => {
      const text = (o.textContent || "").trim(), norm = normParens(text);
      return candidateTexts.some((t) => t && (text.includes(t) || norm.includes(normParens(t))));
    });
    if (!opt) {
      el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      return false;
    }
    clickEl(opt);
    await sleep(T.afterClickSettle);
    // Collapse: blur + body click. No document-level Escape (see header).
    try { typingTarget && typingTarget.blur && typingTarget.blur(); } catch {}
    try { el.blur && el.blur(); } catch {}
    document.body.click();
    await sleep(T.comboboxSettle);
    return true;
  }

  // Upload the receipt. Hotel has two slots: 酒店住宿相关凭证★ (required —
  // satisfies the validator) and 附件 (optional — but it's the slot the expense
  // table's 📎 indicator reads). Fill both on hotel; 附件 only elsewhere.
  async function attachReceiptFile(form, att, filename, type) {
    try {
      const blob = await fetch(`data:${att.mime || "application/octet-stream"};base64,${att.data}`).then((r) => r.blob());
      const uploadTo = async (slot, label) => {
        if (!slot) return false;
        const file = new File([blob], filename, { type: att.mime || blob.type });
        const dt = new DataTransfer();
        dt.items.add(file);
        try { slot.files = dt.files; } catch { Object.defineProperty(slot, "files", { value: dt.files, configurable: true }); }
        slot.dispatchEvent(new Event("change", { bubbles: true }));
        slot.dispatchEvent(new Event("input", { bubbles: true }));
        log(`→ attached ${filename} (${file.size} B) to ${label}`);
        await sleep(T.attachSettle);
        return true;
      };
      let any = false;
      if (type === "hotel") {
        const receipt = findFileInput(form, LABELS.hotelReceipt);
        const attachment = findFileInput(form, LABELS.attachment);
        if (await uploadTo(receipt, "hotelReceipt slot")) any = true;
        if (attachment && attachment !== receipt && await uploadTo(attachment, "attachment slot")) any = true;
      } else {
        if (await uploadTo(findFileInput(form, LABELS.attachment), "attachment slot")) any = true;
      }
      if (!any && await uploadTo(findAnyFileInput(form), "generic file input")) any = true;
      if (!any) log("no file input found in form; skipping attachment for", filename);
      return any;
    } catch (e) {
      warn("attach failed:", filename, e);
      return false;
    }
  }

  /* ======================================================================
   * §7 diagnostics
   * ==================================================================== */

  function describeInput(el, full = false) {
    if (!el) return null;
    const out = {
      tag: el.tagName.toLowerCase(),
      type: el.type || null,
      cls: classOf(el).slice(0, 160),
      value: String(el.value ?? el.textContent ?? "").slice(0, 60),
      placeholder: el.placeholder || null,
      readonly: !!el.readOnly,
      disabled: !!el.disabled,
      role: el.getAttribute && el.getAttribute("role"),
    };
    if (full) {
      const r = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
      const props = getReactProps(el);
      out.name = el.name || null;
      out.id = el.id || null;
      out.ariaLabel = el.getAttribute && el.getAttribute("aria-label");
      out.hasReactProps = !!props;
      out.reactHandlers = props ? Object.keys(props).filter((k) => /^on[A-Z]/.test(k) && typeof props[k] === "function") : [];
      out.rect = r ? { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } : null;
    }
    return out;
  }

  function describeMaybe(el) {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { tag: el.tagName.toLowerCase(), text: (el.textContent || "").trim().slice(0, 60), cls: classOf(el).slice(0, 100),
      rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } };
  }

  // Which control each label resolves to, using the SAME finders the fill uses.
  function probeLabels(form) {
    if (!form) return null;
    return {
      amount: describeInput(resolveAmountInput(form)),
      currency: describeInput(findCombobox(form, LABELS.currency)),
      city: describeInput(findCombobox(form, LABELS.city)),
      date: describeInput(findDateInput(form, LABELS.date)),
      flightDate: describeInput(findDateInput(form, LABELS.flightDate)),
      checkin: describeInput(findDateInput(form, LABELS.checkin)),
      checkout: describeInput(findDateInput(form, LABELS.checkout)),
      note: describeInput(findTextInput(form, LABELS.note)),
      hotelReceipt: describeInput(findFileInput(form, LABELS.hotelReceipt)),
      attachment: describeInput(findFileInput(form, LABELS.attachment)),
      rate: describeInput(findFieldControl(form, LABELS.rate)),
      convertedAmount: describeInput(findFieldControl(form, LABELS.convertedAmount)),
    };
  }

  function deepProbeAmount(form) {
    if (!form) return { error: "no form open — open a 费用 drawer manually then run 诊断 again" };
    const tags = "label, span, div, dt, p, th, strong, em, li, b";
    const raw = Array.from(form.querySelectorAll(tags)).filter((el) => LABELS.amount.includes(normalizeLabelText(el.textContent)));
    const chosen = findLabelEls(form, LABELS.amount, tags);
    return {
      rawTextMatches: raw.length,
      innermostVisibleMatches: chosen.length,
      labels: chosen.slice(0, 6).map((lbl) => {
        const c = fieldContainerOf(lbl);
        return {
          tag: lbl.tagName.toLowerCase(), cls: classOf(lbl).slice(0, 160), text: (lbl.textContent || "").trim().slice(0, 40),
          inTableScope: isInTableScope(lbl),
          container: c ? { tag: c.tagName.toLowerCase(), cls: classOf(c).slice(0, 160) } : null,
          controlsInContainer: c ? Array.from(c.querySelectorAll(SEL.anyControl)).slice(0, 6).map((e) => describeInput(e, true)) : [],
        };
      }),
      resolved: describeInput(resolveAmountInput(form), true),
      allFormInputs: Array.from(form.querySelectorAll(SEL.anyControl)).filter(isVisible).slice(0, 25).map((e) => describeInput(e, true)),
    };
  }

  function collectVisibleLabels() {
    return Array.from(document.querySelectorAll(SEL.labelTags))
      .filter(isVisible)
      .map((el) => (el.textContent || "").trim())
      .filter((t) => t.length > 0 && t.length < 16)
      .filter((t, i, a) => a.indexOf(t) === i)
      .slice(0, 200);
  }

  function diagnose(records) {
    const form = findCategoryForm();
    return {
      version: (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.getManifest) ? chrome.runtime.getManifest().version : null,
      url: location.href,
      title: document.title,
      isTop: window.top === window,
      addButton: describeMaybe(findAddExpenseButton()),
      categoryPicker: !!findCategoryPicker(),
      categoryForm: describeMaybe(form),
      formTitle: form ? sniffFormTitle(form) : null,
      formProbes: probeLabels(form),
      amountDeepProbe: deepProbeAmount(form),
      pendingRecords: Array.isArray(records) ? records.map((r) => ({
        type: r.type, date: r.date, currency: r.currency, amount: r.amount,
        city: r.city, nights: r.nights, checkin: r.checkin, checkout: r.checkout,
        note: (r.note || "").slice(0, 40), source: r.source,
      })) : null,
      lastFillSummary,
      currentVisibleLabels: collectVisibleLabels(),
    };
  }

  /* ======================================================================
   * §8 helpers
   * ==================================================================== */

  function clickEl(el) {
    try {
      el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window }));
      el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window }));
      el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
    } catch {
      try { el.click(); } catch {}
    }
  }

  function isVisible(el) {
    if (!el || !el.getBoundingClientRect) return false;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return false;
    const s = getComputedStyle(el);
    return s.display !== "none" && s.visibility !== "hidden" && s.opacity !== "0";
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  // Poll `fn` every 100ms until truthy; reject after `timeout`.
  function waitFor(fn, timeout = 5000, label = "condition") {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      const tick = () => {
        let v = null;
        try { v = fn(); } catch (e) { warn(`waitFor(${label}) probe threw:`, e); }
        if (v) return resolve(v);
        if (Date.now() - start > timeout) return reject(new Error(`等待 ${label} 超时`));
        setTimeout(tick, 100);
      };
      tick();
    });
  }

  // Canonical implementation lives in lib/parser.js (FliggyParser.addDays);
  // content scripts can't import it, and this is only a fallback when the
  // popup didn't supply rec.checkout.
  function addDays(iso, days) {
    if (!iso) return iso;
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    d.setUTCDate(d.getUTCDate() + (days || 0));
    return d.toISOString().slice(0, 10);
  }

  let overlayEl = null;
  function showOverlay(msg) {
    if (window.top !== window) return;
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
    setTimeout(() => overlayEl?.classList.remove("show"), 1800);
  }

  /* ======================================================================
   * §9 test hook (only when the harness sets window.__FLIGGY_TEST__)
   * ==================================================================== */
  if (window.__FLIGGY_TEST__) {
    window.__fliggyInternals = {
      LABELS, SEL, T,
      normalizeLabelText, isInTableScope, findLabelEls, fieldContainerOf,
      findTextInput, findDateInput, findCombobox, findFileInput, findRadioOption, findFieldControl,
      isAmountLike, resolveAmountInput, findAmountInputByGeometry,
      findAddExpenseButton, findCategoryPicker, findCategoryLeaf, findCategoryForm, findSaveButton, findCancelButton,
      findVisibleByExactText, sniffFormTitle,
      setInputValue, setDateLikeValue, setComboboxValue, readComboboxSelected, valueEquals,
      describeInput, diagnose, addDays, isVisible,
    };
  }
})();
