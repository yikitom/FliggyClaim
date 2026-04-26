/*
 * Content script for the Alibaba TAE expense system.
 *
 * Real-world flow observed:
 *   1. Click "新增费用" button → opens a category picker drawer
 *      (left column: parent groups; right column: leaf items)
 *   2. Click a leaf like "差旅-餐费" / "差旅-住宿" / "差旅-打车" / "差旅-机票"
 *   3. Drawer switches to a category-specific form (different fields per category)
 *   4. Fill fields and click "保存"
 *   5. Drawer closes; one row is added to the table on the left
 *
 * This script automates that whole loop.
 */

(() => {
  if (window.__fliggyClaimInjected) {
    window.__fliggyClaimInjected = "reused";
  } else {
    window.__fliggyClaimInjected = true;
  }

  const log = (...a) => console.log("%c[FliggyClaim]", "color:#d71e1e;font-weight:bold", ...a);
  const warn = (...a) => console.warn("%c[FliggyClaim]", "color:#d71e1e;font-weight:bold", ...a);

  log("content script loaded on", location.href, "frame:", window.top === window ? "top" : "iframe");

  // Map our internal type → TAE category leaf text (with fallback list)
  const CATEGORY_LEAF = {
    flight: ["差旅-机票", "差旅-机", "机票"],
    hotel: ["差旅-住宿", "住宿", "差旅-酒店"],
    meal: ["差旅-餐费", "差旅-餐饮", "餐费", "餐饮"],
    taxi: ["差旅-打车", "差旅-出租车", "打车"],
    train: ["差旅-火车", "差旅-高铁", "差旅-动车", "火车", "高铁"],
    other: ["差旅-其他", "差旅-其它", "其他"],
  };

  // Each category form's labels we recognize
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
    flightFrom: ["出发城市", "出发地"],
    flightTo: ["到达城市", "到达地", "目的地"],
    // Hotel: 「酒店住宿相关凭证」is the REQUIRED receipt; generic 「附件」is optional.
    hotelReceipt: ["酒店住宿相关凭证"],
    attachment: ["附件"],
  };

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
      return true;
    }
  }

  /* ---------- Public flow ---------- */

  async function fillRecords(records, attachments) {
    log(`starting fill: ${records.length} records`,
      `attachments: ${Object.keys(attachments || {}).length}`);
    let filled = 0;
    let attached = 0;
    const perRecord = [];
    showOverlay(`准备写入 ${records.length} 条…`);
    for (let i = 0; i < records.length; i++) {
      const rec = records[i];
      const att = attachments && attachments[rec.source];
      showOverlay(`写入第 ${i + 1} / ${records.length} 条 (${rec.type})…`);
      const slot = {
        index: i + 1,
        type: rec.type, currency: rec.currency, amount: rec.amount,
        ok: false, error: null, amountFinal: null,
      };
      try {
        const result = await fillSingleExpense(rec, att);
        filled++;
        if (result && result.attached) attached++;
        slot.ok = true;
        slot.amountFinal = result?.amountFinal ?? null;
        log(`✓ filled record ${i + 1}/${records.length}`, rec, result);
      } catch (e) {
        warn(`× record ${i + 1}/${records.length} failed:`, rec, e);
        slot.error = e?.message || String(e);
        await tryCancelDrawer();
      }
      perRecord.push(slot);
      await sleep(700);
    }
    lastFillSummary = {
      at: new Date().toISOString(),
      total: records.length,
      filled,
      attached,
      perRecord,
    };
    hideOverlay(`已写入 ${filled} / ${records.length} 条 (附件 ${attached})`);
    if (filled === 0) {
      throw new Error("0 条写入成功——请打开 DevTools 控制台查看 [FliggyClaim] 日志");
    }
    return { filled, attached };
  }

  async function fillSingleExpense(rec, attachment) {
    // 1. Click "新增费用"
    const addBtn = findAddExpenseButton();
    if (!addBtn) throw new Error("没找到「新增费用」按钮");
    log("→ clicking 新增费用", addBtn);
    clickEl(addBtn);

    // 2. Wait for category picker drawer
    await waitFor(() => findCategoryPicker(), 5000, "category picker");

    // 3. Click the matching leaf
    const leaf = await findCategoryLeaf(rec.type);
    if (!leaf) throw new Error(`没找到「${CATEGORY_LEAF[rec.type]?.[0] || rec.type}」类别项`);
    log("→ clicking category leaf", leaf);
    clickEl(leaf);

    // 4. Wait for category form
    const form = await waitFor(() => findCategoryForm(), 5000, "category form");
    const formTitle = (form.querySelector("h1, h2, h3, h4")?.textContent || "").trim();
    log("→ category form opened, title:", formTitle, form);

    // 5. Fill fields based on visible labels in the form
    const fillOutcome = await fillFormFields(form, rec, formTitle);

    // 5b. Attach the source receipt file (if popup provided one)
    let attached = false;
    if (attachment && attachment.data) {
      attached = await attachReceiptFile(form, attachment, rec.source, formTitle);
    }

    // 6. Click 保存 inside the form
    const saveBtn = findSaveButton(form);
    if (!saveBtn) throw new Error("没找到表单内的「保存」按钮");
    log("→ clicking 保存", saveBtn);
    clickEl(saveBtn);

    // 7. Wait for drawer to close (form vanishes)
    await waitFor(() => !findCategoryForm(), 6000, "drawer close");
    return { attached, amountFinal: fillOutcome?.amountFinal ?? null, amountInput: fillOutcome?.amountInput ?? null };
  }

  /* ---------- File attachment ---------- */

  async function attachReceiptFile(form, att, filename, formTitle) {
    try {
      const isHotel = /住宿|酒店/.test(formTitle || "");
      // Hotel forms have TWO file inputs: 酒店住宿相关凭证★ (required) and 附件
      // (optional). Always prefer the required slot — uploading to 附件 won't
      // satisfy the validator and 保存 will fail.
      let input = isHotel ? findFileInputByLabel(form, LABELS.hotelReceipt) : null;
      if (!input) input = findFileInputByLabel(form, LABELS.attachment);
      if (!input) input = findFileInput(form);
      if (!input) {
        log("no file input found in form, skipping attachment for", filename);
        return false;
      }
      log(`→ attaching ${filename} to`, isHotel ? "hotelReceipt slot" : "attachment slot", input);
      const dataUrl = `data:${att.mime || "application/octet-stream"};base64,${att.data}`;
      const blob = await fetch(dataUrl).then((r) => r.blob());
      const file = new File([blob], filename, { type: att.mime || blob.type });
      const dt = new DataTransfer();
      dt.items.add(file);
      try {
        input.files = dt.files;
      } catch {
        // Fallback for non-standard file inputs.
        Object.defineProperty(input, "files", { value: dt.files, configurable: true });
      }
      input.dispatchEvent(new Event("change", { bubbles: true }));
      input.dispatchEvent(new Event("input", { bubbles: true }));
      log(`→ attached ${filename} (${file.size} B) to`, input);
      // Wait briefly for the upload component to register and show progress.
      await sleep(1500);
      return true;
    } catch (e) {
      warn("attach failed:", filename, e);
      return false;
    }
  }

  function findFileInput(scope) {
    // Look for any enabled file input within this drawer/form scope.
    const inputs = Array.from((scope || document).querySelectorAll('input[type="file"]'));
    return (
      inputs.find((i) => !i.disabled && !i.readOnly) ||
      inputs[0] ||
      null
    );
  }

  // Same anchor strategy as findInputByLabel, but specifically for file inputs
  // (which findInputByLabel/pickFillable deliberately exclude).
  function findFileInputByLabel(scope, labels) {
    if (!scope) return null;
    const labelEls = Array.from(scope.querySelectorAll("label, span, div, dt, p, th"))
      .filter(isVisible)
      .filter((el) => {
        const t = (el.textContent || "").trim().replace(/^[*\s]+/, "");
        return labels.some((l) => t === l || t === l + "：" || t === l + ":");
      })
      .filter((el) => !el.closest("th, td, tr, thead, tbody, table, [role='columnheader'], [role='rowheader'], [role='cell'], [role='row'], [role='grid'], [role='table']"));
    const pickFile = (el) => el && el.querySelector
      ? el.querySelector('input[type="file"]:not([disabled])') : null;
    for (const lbl of labelEls) {
      let cur = lbl;
      for (let i = 0; i < 4; i++) {
        cur = cur.nextElementSibling;
        if (!cur) break;
        const fi = pickFile(cur);
        if (fi) return fi;
      }
      let parent = lbl.parentElement;
      for (let i = 0; i < 3 && parent; i++) {
        const fi = pickFile(parent);
        if (fi) return fi;
        parent = parent.parentElement;
      }
    }
    return null;
  }

  /* ---------- Discovery helpers ---------- */

  function findAddExpenseButton() {
    // Prefer the toolbar primary button "新增费用"
    const all = Array.from(document.querySelectorAll("button, a, [role=button]")).filter(isVisible);
    return (
      all.find((b) => /^(\+\s*)?新增费用$/.test((b.textContent || "").trim())) ||
      all.find((b) => /^\+\s*新增$/.test((b.textContent || "").trim())) ||
      all.find((b) => /新增费用/.test((b.textContent || "").trim())) ||
      null
    );
  }

  // Category picker = a panel that contains "选择费用类型" header
  function findCategoryPicker() {
    const headers = Array.from(document.querySelectorAll("h1, h2, h3, h4, div, span"))
      .filter(isVisible)
      .filter((el) => /^选择费用类型/.test((el.textContent || "").trim()));
    if (!headers.length) return null;
    // Walk up to find a sensible container with leaf items
    for (const h of headers) {
      let cur = h;
      for (let i = 0; i < 8 && cur; i++) {
        if (cur.querySelector && cur.querySelectorAll(":scope * ").length > 5) {
          // ensure it actually contains category-looking text
          const txt = cur.textContent || "";
          if (/差旅|常用|新人|招待/.test(txt)) return cur;
        }
        cur = cur.parentElement;
      }
    }
    return null;
  }

  async function findCategoryLeaf(type) {
    const candidates = CATEGORY_LEAF[type] || CATEGORY_LEAF.other;
    // Try direct visible match first (works when 常用 already shows our leaf)
    let leaf = findVisibleByExactText(candidates);
    if (leaf) return leaf;

    // If not visible, click the 差旅 parent group on the left to expand
    const chaiLv = findVisibleByExactText(["差旅"]);
    if (chaiLv) {
      log("→ expanding 差旅 parent group");
      clickEl(chaiLv);
      await sleep(300);
      leaf = findVisibleByExactText(candidates);
      if (leaf) return leaf;
    }

    // Fall back to a substring match
    return findVisibleByContains(candidates);
  }

  function findCategoryForm() {
    // Form has a header like "差旅-餐费" / "差旅-住宿" etc., and 保存 button.
    // The expense table on the left ALSO renders these strings as cell values,
    // so we skip any title inside table chrome — otherwise the walk-up from
    // a table cell ends at the page-level container (which then makes label
    // lookups inside the "form" stray into the wrong drawer fields).
    const titles = Array.from(document.querySelectorAll("h1, h2, h3, h4, div, span"))
      .filter(isVisible)
      .filter((el) => /^差旅-/.test((el.textContent || "").trim()) && (el.textContent || "").trim().length < 12)
      .filter((el) => !el.closest("th, td, tr, thead, tbody, table, [role='columnheader'], [role='rowheader'], [role='cell'], [role='row'], [role='grid'], [role='table']"));
    for (const t of titles) {
      let cur = t;
      // Walk up only a handful of levels — the drawer body is typically 2–4
      // ancestors above the title; going to 10 risks crossing into a shared
      // page wrapper that also contains unrelated forms.
      for (let i = 0; i < 6 && cur; i++) {
        if (cur.querySelector && cur.querySelector("input, textarea, select")) {
          const save = Array.from(cur.querySelectorAll("button"))
            .filter(isVisible)
            .find((b) => /^保存/.test((b.textContent || "").trim()));
          if (save) return cur;
        }
        cur = cur.parentElement;
      }
    }
    return null;
  }

  function findSaveButton(scope) {
    return Array.from(scope.querySelectorAll("button"))
      .filter(isVisible)
      .find((b) => /^保存/.test((b.textContent || "").trim())) || null;
  }

  function findCancelButton(scope) {
    return Array.from((scope || document).querySelectorAll("button"))
      .filter(isVisible)
      .find((b) => /^取消/.test((b.textContent || "").trim())) || null;
  }

  async function tryCancelDrawer() {
    const f = findCategoryForm();
    if (f) {
      const c = findCancelButton(f);
      if (c) {
        clickEl(c);
        await sleep(300);
        return;
      }
    }
    const picker = findCategoryPicker();
    if (picker) {
      const c = findCancelButton(picker) ||
        Array.from(picker.querySelectorAll("a, span, button"))
          .filter(isVisible)
          .find((el) => /^取消$/.test((el.textContent || "").trim()));
      if (c) clickEl(c);
    }
  }

  function findVisibleByExactText(texts) {
    return Array.from(document.querySelectorAll("a, span, div, li, button, [role=menuitem]"))
      .filter(isVisible)
      .find((el) => {
        const t = (el.textContent || "").trim();
        return texts.includes(t) && t.length <= 20 && el.children.length <= 3;
      });
  }

  function findVisibleByContains(texts) {
    return Array.from(document.querySelectorAll("a, span, div, li, button, [role=menuitem]"))
      .filter(isVisible)
      .find((el) => {
        const t = (el.textContent || "").trim();
        return texts.some((x) => t.includes(x)) && t.length <= 30 && el.children.length <= 3;
      });
  }

  /* ---------- Form filling ---------- */

  async function fillFormFields(form, rec, formTitle) {
    const isHotel = /住宿|酒店/.test(formTitle);
    const isTaxi = /打车|出租/.test(formTitle);
    const isFlight = /机票/.test(formTitle);
    const outcome = { amountFinal: null, amountInput: null };

    // Common fields
    const cityName = rec.city || extractCityFromNote(rec.note) || extractCityFromNote(rec.source) || "上海";
    if (isHotel) {
      const ci = findInputByLabel(form, LABELS.checkin);
      const checkinDate = rec.checkin || rec.date;
      if (ci) await setDateLikeValue(ci, checkinDate);
      const co = findInputByLabel(form, LABELS.checkout);
      const checkoutDate = rec.checkout || addNDays(checkinDate, rec.nights || 1);
      if (co) await setDateLikeValue(co, checkoutDate);
    } else {
      // 费用发生时间 (optional on most forms, required on none of the screenshots)
      const dateEl = findInputByLabel(form, LABELS.date);
      if (dateEl) await setDateLikeValue(dateEl, rec.date);
      // 乘机日期★ — only on the flight form, and it IS required.
      if (isFlight) {
        const fdEl = findInputByLabel(form, LABELS.flightDate);
        if (fdEl) await setDateLikeValue(fdEl, rec.date);
      }
    }
    // 城市 may exist on hotel/meal/taxi/other forms — try unconditionally.
    const cityEl = findInputByLabel(form, LABELS.city);
    if (cityEl) await setComboboxValue(cityEl, [cityName]);

    if (isTaxi) {
      // 是否网约车 radio – default to 是
      const yes = findRadioByLabel(form, LABELS.rideshare, "是");
      if (yes) clickEl(yes);
    }

    // Currency MUST be set before amount: TAE clears the amount field
    // when the currency changes (and re-fetches the FX rate against the
    // report's base currency). Filling amount first would be silently wiped.
    const cur = findInputByLabel(form, LABELS.currency);
    if (cur) {
      await setComboboxValue(cur, [rec.currency, currencyDisplay(rec.currency)]);
      // Give TAE time to fire the FX-rate request triggered by the change.
      await sleep(450);
    }

    // Amount – set after currency, then nudge the form to recompute the
    // converted (本位币) amount. Verify after each strategy and fall back
    // to a fresh element lookup + retry if the value was silently dropped
    // (which happens when currency change re-mounted the InputNumber after
    // we cached a stale node reference).
    const wantAmt = String(rec.amount ?? 0);
    let amt = findInputByLabel(form, LABELS.amount);
    if (amt) {
      setInputValue(amt, wantAmt);
      await sleep(180);
      try {
        amt.dispatchEvent(new Event("change", { bubbles: true }));
        amt.dispatchEvent(new FocusEvent("blur", { bubbles: true }));
      } catch {}
      document.body.click();
      // Verify and retry once with a fresh node lookup if the value vanished.
      await sleep(120);
      let fresh = findInputByLabel(form, LABELS.amount) || amt;
      if (parseFloat((fresh.value || "0").toString().replace(/,/g, "")) !== parseFloat(wantAmt)) {
        log("amount didn't stick on first pass; retrying. got:", fresh.value, "want:", wantAmt);
        setInputValue(fresh, wantAmt);
        await sleep(180);
        try {
          fresh.dispatchEvent(new Event("change", { bubbles: true }));
          fresh.dispatchEvent(new FocusEvent("blur", { bubbles: true }));
        } catch {}
        document.body.click();
      }
      log("amount final value:", fresh.value);
      outcome.amountFinal = fresh.value;
      outcome.amountInput = describeInput(fresh);
      await waitForRatePopulated(form, 2500);
    } else {
      warn("amount label not found in form");
    }

    // Note / 详细说明
    const note = findInputByLabel(form, LABELS.note);
    if (note) setInputValue(note, rec.note || "");
    return outcome;
  }

  // Poll the form for a non-zero exchange rate or converted amount.
  // When the record's currency equals the report base currency, both fields
  // are usually absent — in that case we just return after the timeout.
  async function waitForRatePopulated(form, timeoutMs) {
    const start = Date.now();
    const looksFilled = (el) => {
      if (!el) return false;
      const v = (el.value ?? el.textContent ?? "").toString().trim();
      if (!v) return false;
      const n = parseFloat(v.replace(/,/g, ""));
      return !isNaN(n) && n > 0;
    };
    while (Date.now() - start < timeoutMs) {
      const rateEl = findInputByLabel(form, LABELS.rate);
      const convEl = findInputByLabel(form, LABELS.convertedAmount);
      if (looksFilled(rateEl) || looksFilled(convEl)) return true;
      await sleep(120);
    }
    return false;
  }

  function currencyDisplay(code) {
    const m = {
      CNY: "CNY (人民币)",
      USD: "USD (美元)",
      EUR: "EUR (欧元)",
      JPY: "JPY (日元)",
      HKD: "HKD (港币)",
      GBP: "GBP (英镑)",
      SGD: "SGD (新加坡元)",
    };
    return m[code] || code;
  }

  function addOneDay(iso) { return addNDays(iso, 1); }
  function addNDays(iso, days) {
    if (!iso) return iso;
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    d.setDate(d.getDate() + (days || 0));
    return d.toISOString().slice(0, 10);
  }

  function extractCityFromNote(note) {
    if (!note) return null;
    const cities = [
      "北京", "上海", "杭州", "广州", "深圳", "成都", "重庆", "武汉",
      "南京", "苏州", "西安", "天津", "厦门", "青岛", "长沙", "郑州",
      "合肥", "宁波", "佛山", "东莞", "无锡", "大连", "沈阳", "哈尔滨",
      "济南", "福州", "昆明", "南昌", "贵阳", "南宁", "三亚", "海口",
      "香港", "澳门", "台北", "高雄",
      "新加坡", "曼谷", "吉隆坡", "雅加达", "马尼拉", "胡志明", "河内",
      "首尔", "东京", "大阪",
      "伦敦", "巴黎", "纽约", "旧金山", "洛杉矶", "迪拜",
    ];
    for (const c of cities) if (note.includes(c)) return c;
    return null;
  }

  /* ---------- Label-anchored input finder ---------- */

  function findInputByLabel(scope, labels) {
    const scan = scope || document;
    const labelEls = Array.from(scan.querySelectorAll("label, span, div, dt, p, th"))
      .filter(isVisible)
      .filter((el) => {
        const t = (el.textContent || "").trim().replace(/^[*\s]+/, "");
        return labels.some((l) => t === l || t === l + "：" || t === l + ":");
      })
      // The expense list on the left has a column header literally named "金额"
      // and "费用类型" etc. If we let those match, we'd walk up to a high
      // ancestor that contains both the table AND the drawer, then pickFillable
      // returns the FIRST input in DOM order — which is usually the city
      // combobox in the drawer, not the amount field. Skipping anything that
      // lives inside table chrome leaves only the drawer's real form labels.
      .filter((el) => !el.closest("th, td, tr, thead, tbody, table, [role='columnheader'], [role='rowheader'], [role='cell'], [role='row'], [role='grid'], [role='table']"));

    for (const lbl of labelEls) {
      const forId = lbl.getAttribute && lbl.getAttribute("for");
      if (forId) {
        const t = scan.querySelector ? scan.querySelector("#" + CSS.escape(forId)) : null;
        const target = t || document.getElementById(forId);
        if (target && isVisible(target)) return target;
      }
      let cur = lbl;
      for (let i = 0; i < 4; i++) {
        cur = cur.nextElementSibling;
        if (!cur) break;
        const inp = pickFillable(cur);
        if (inp) return inp;
      }
      let parent = lbl.parentElement;
      for (let i = 0; i < 3 && parent; i++) {
        let sib = parent.nextElementSibling;
        for (let j = 0; j < 3 && sib; j++) {
          const inp = pickFillable(sib);
          if (inp) return inp;
          sib = sib.nextElementSibling;
        }
        const inSame = pickFillable(parent);
        if (inSame && inSame !== lbl) return inSame;
        parent = parent.parentElement;
      }
    }
    return null;
  }

  function findRadioByLabel(scope, labels, optionText) {
    const labelEls = Array.from((scope || document).querySelectorAll("label, span, div, dt, p, th"))
      .filter(isVisible)
      .filter((el) => {
        const t = (el.textContent || "").trim().replace(/^[*\s]+/, "");
        return labels.some((l) => t === l || t === l + "：" || t === l + ":");
      })
      .filter((el) => !el.closest("th, td, tr, thead, tbody, table, [role='columnheader'], [role='rowheader'], [role='cell'], [role='row'], [role='grid'], [role='table']"));
    for (const lbl of labelEls) {
      let parent = lbl.parentElement;
      for (let i = 0; i < 4 && parent; i++) {
        // look for a span containing optionText next to a radio input
        const spans = Array.from(parent.querySelectorAll("label, span"));
        const opt = spans.find((s) => (s.textContent || "").trim() === optionText && isVisible(s));
        if (opt) return opt;
        parent = parent.parentElement;
      }
    }
    return null;
  }

  function pickFillable(scope) {
    if (!scope || !scope.querySelector) return null;
    return (
      scope.querySelector('input:not([type="hidden"]):not([type="file"]):not([disabled])') ||
      scope.querySelector("textarea:not([disabled])") ||
      scope.querySelector("select:not([disabled])") ||
      scope.querySelector('[role="combobox"]') ||
      null
    );
  }

  /* ---------- Field setters ---------- */

  function setInputValue(el, value) {
    if (!el) return false;
    const str = String(value);
    try {
      el.focus();
      // Strategy A: execCommand insertText. Fires a real `InputEvent` with
      // inputType="insertText" that Fusion's NumberPicker / Vue v-model /
      // React controlled inputs all observe. select() first so the new text
      // replaces rather than appends. This is the most user-like simulation
      // and works when the prototype-setter trick alone is silently dropped.
      try {
        if (typeof el.select === "function") el.select();
        if (document.execCommand && document.execCommand("insertText", false, str)) {
          if (el.value === str) {
            el.dispatchEvent(new Event("change", { bubbles: true }));
            setTimeout(() => {
              try { el.dispatchEvent(new Event("blur", { bubbles: true })); } catch {}
            }, 0);
            return true;
          }
        }
      } catch {}

      // Strategy B (fallback): native value setter + React tracker reset.
      const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
      const oldValue = el.value;
      if (setter) setter.call(el, str);
      else el.value = str;
      const tracker = el._valueTracker;
      if (tracker && typeof tracker.setValue === "function" && oldValue !== str) {
        try { tracker.setValue(oldValue); } catch {}
      }
      el.dispatchEvent(new InputEvent("input", { bubbles: true, data: str, inputType: "insertText" }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      setTimeout(() => {
        try { el.dispatchEvent(new Event("blur", { bubbles: true })); } catch {}
      }, 0);
      return true;
    } catch (e) {
      warn("setInputValue failed:", e);
      return false;
    }
  }

  async function setDateLikeValue(el, iso) {
    if (!el || !iso) return false;
    if (el.type === "date") return setInputValue(el, iso);

    el.focus();
    el.click();
    setInputValue(el, iso);
    await sleep(200);
    // Some pickers want YYYY/MM/DD typed
    setInputValue(el, iso.replaceAll("-", "/"));
    await sleep(150);
    el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    // close the picker by clicking elsewhere
    document.body.click();
    return true;
  }

  async function setComboboxValue(el, candidateTexts) {
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
    el.focus();
    clickEl(el);
    await sleep(150);
    // Type the first candidate to filter
    const proto = HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    if (setter) setter.call(el, candidateTexts[0]);
    else el.value = candidateTexts[0];
    el.dispatchEvent(new Event("input", { bubbles: true }));
    await sleep(250);
    const opts = Array.from(
      document.querySelectorAll(
        '[role="option"], li[class*="option"], div[class*="option-item"], div[class*="MenuItem"]',
      ),
    ).filter(isVisible);
    log("combobox options visible:", opts.length, opts.slice(0, 5).map((o) => (o.textContent || "").trim()));
    const opt = opts.find((o) =>
      candidateTexts.some((t) => (o.textContent || "").trim().includes(t)),
    );
    if (opt) {
      clickEl(opt);
      await sleep(150);
      return true;
    }
    el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    return false;
  }

  /* ---------- Diagnostics ---------- */

  // Captured by fillRecords; surfaced via diagnose() so the user can see
  // exactly what the last import attempt did.
  let lastFillSummary = null;

  function describeInput(el) {
    if (!el) return null;
    return {
      tag: el.tagName.toLowerCase(),
      type: el.type || null,
      cls: (el.className || "").toString().slice(0, 120),
      value: ((el.value ?? el.textContent ?? "") + "").slice(0, 60),
      placeholder: el.placeholder || null,
      readonly: !!el.readOnly,
      disabled: !!el.disabled,
      role: el.getAttribute && el.getAttribute("role"),
    };
  }

  function probeLabels(form) {
    if (!form) return null;
    const out = {};
    for (const key of ["amount", "currency", "date", "city", "note", "checkin", "checkout"]) {
      const labels = LABELS[key];
      if (!labels) continue;
      out[key] = describeInput(findInputByLabel(form, labels));
    }
    return out;
  }

  function diagnose(records) {
    const form = findCategoryForm();
    return {
      url: location.href,
      title: document.title,
      isTop: window.top === window,
      addButton: describeMaybe(findAddExpenseButton()),
      categoryPicker: !!findCategoryPicker(),
      categoryForm: describeMaybe(form),
      // Per-label input probe — confirms which actual <input> each label
      // resolves to in the currently-open drawer (open one manually before
      // running 诊断 to populate this).
      formProbes: probeLabels(form),
      // Deep DOM dump around every "金额"-ish label in the page. This is the
      // dispositive diagnostic for "amount won't write" — it shows which
      // element findInputByLabel landed on, what's actually around the label
      // in the DOM, and whether our table-skip filter is too aggressive.
      amountDeepProbe: deepProbeAmount(form),
      // Records the popup is about to send (or just sent). Confirms the
      // chrome message payload carries amount/currency/etc end-to-end.
      pendingRecords: Array.isArray(records) ? records.map((r) => ({
        type: r.type, date: r.date, currency: r.currency,
        amount: r.amount, note: (r.note || "").slice(0, 40),
        source: r.source,
      })) : null,
      lastFillSummary,
      currentVisibleLabels: collectVisibleLabels(),
    };
  }

  function deepProbeAmount(form) {
    if (!form) {
      return { error: "no form open — open a 费用 drawer manually then run 诊断 again" };
    }
    const labelTexts = LABELS.amount;
    const allMatching = Array.from(form.querySelectorAll("label, span, div, dt, p, th, strong, em, li, b"))
      .filter(isVisible)
      .filter((el) => {
        const t = (el.textContent || "").trim().replace(/^[*\s]+/, "");
        return labelTexts.some((l) => t === l || t === l + "：" || t === l + ":");
      });
    const tableSkipSel = "th, td, tr, thead, tbody, table, [role='columnheader'], [role='rowheader'], [role='cell'], [role='row'], [role='grid'], [role='table']";
    const probes = allMatching.slice(0, 8).map((lbl, i) => ({
      idx: i,
      tag: lbl.tagName.toLowerCase(),
      cls: (lbl.className || "").toString().slice(0, 200),
      text: (lbl.textContent || "").trim().slice(0, 40),
      parentTag: lbl.parentElement?.tagName.toLowerCase(),
      parentCls: (lbl.parentElement?.className || "").toString().slice(0, 200),
      grandparentCls: (lbl.parentElement?.parentElement?.className || "").toString().slice(0, 200),
      excludedByTableFilter: !!lbl.closest(tableSkipSel),
      excludingAncestor: lbl.closest(tableSkipSel)?.tagName.toLowerCase() || null,
      outerHtml: lbl.outerHTML.slice(0, 400),
      // Inputs found by walking from this label
      siblingInputs: collectNeighborInputs(lbl),
    }));
    // Now show what findInputByLabel actually returns
    const resolved = findInputByLabel(form, labelTexts);
    // And dump all input-like elements in the form for context
    const allInputs = Array.from(form.querySelectorAll('input, textarea, [role="combobox"], [role="spinbutton"], [contenteditable="true"]'))
      .filter(isVisible)
      .slice(0, 25)
      .map(describeInputFull);
    return {
      labelMatchCount: allMatching.length,
      probes,
      resolvedByFindInputByLabel: describeInputFull(resolved),
      allFormInputs: allInputs,
    };
  }

  function collectNeighborInputs(lbl) {
    const out = [];
    let cur = lbl;
    for (let i = 0; i < 4; i++) {
      cur = cur.nextElementSibling;
      if (!cur) break;
      const inps = cur.querySelectorAll
        ? Array.from(cur.querySelectorAll('input, textarea, [role="combobox"], [role="spinbutton"], [contenteditable="true"]'))
        : [];
      for (const el of inps) {
        if (isVisible(el)) out.push({ via: `nextSibling+${i + 1}`, ...describeInputFull(el) });
      }
    }
    let parent = lbl.parentElement;
    for (let i = 0; i < 3 && parent; i++) {
      let sib = parent.nextElementSibling;
      for (let j = 0; j < 3 && sib; j++) {
        const inps = sib.querySelectorAll
          ? Array.from(sib.querySelectorAll('input, textarea, [role="combobox"], [role="spinbutton"], [contenteditable="true"]'))
          : [];
        for (const el of inps) {
          if (isVisible(el)) out.push({ via: `parent^${i + 1}.nextSib+${j + 1}`, ...describeInputFull(el) });
        }
        sib = sib.nextElementSibling;
      }
      parent = parent.parentElement;
    }
    return out.slice(0, 12);
  }

  function describeInputFull(el) {
    if (!el) return null;
    const r = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
    return {
      tag: el.tagName.toLowerCase(),
      type: el.type || null,
      role: el.getAttribute && el.getAttribute("role"),
      cls: (el.className || "").toString().slice(0, 200),
      name: el.name || null,
      id: el.id || null,
      ariaLabel: el.getAttribute && el.getAttribute("aria-label"),
      placeholder: el.placeholder || null,
      value: ((el.value ?? el.textContent ?? "") + "").slice(0, 60),
      readonly: !!el.readOnly,
      disabled: !!el.disabled,
      rect: r ? { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } : null,
    };
  }

  function describeMaybe(el) {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return {
      tag: el.tagName.toLowerCase(),
      text: (el.textContent || "").trim().slice(0, 60),
      cls: (el.className || "").toString().slice(0, 100),
      rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
    };
  }

  function collectVisibleLabels() {
    return Array.from(document.querySelectorAll("label, span, div, dt, p, th"))
      .filter(isVisible)
      .map((el) => (el.textContent || "").trim())
      .filter((t) => t.length > 0 && t.length < 16)
      .filter((t, i, a) => a.indexOf(t) === i)
      .slice(0, 200);
  }

  /* ---------- Helpers ---------- */

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

  function waitFor(fn, timeout = 5000, label = "condition") {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      const tick = () => {
        const v = fn();
        if (v) return resolve(v);
        if (Date.now() - start > timeout) return reject(new Error(`等待 ${label} 超时`));
        setTimeout(tick, 100);
      };
      tick();
    });
  }

  /* ---------- Overlay ---------- */
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
})();
