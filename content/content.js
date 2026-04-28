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

    // 4. Wait for category form. 10s — TAE drawers occasionally take 2–3s on
    // first open while the schema loads.
    const form = await waitFor(() => findCategoryForm(), 10000, "category form");
    // Title sniff: prefer text that starts with "差旅-" inside the form scope,
    // else fall back to any heading.
    const titleEl = Array.from(form.querySelectorAll("h1, h2, h3, h4, div, span"))
      .filter(isVisible)
      .find((el) => /^差旅-/.test((el.textContent || "").trim()) && (el.textContent || "").trim().length < 12);
    const formTitle = (titleEl?.textContent || form.querySelector("h1, h2, h3, h4")?.textContent || "").trim();
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
  // Heuristic fallback when findInputByLabel returns nothing for "金额".
  // Strategy: find any element whose text is exactly "金额" (no parent walk
  // restrictions, no table-scope filter) and pick the input visually closest
  // to it on the right or below — the field that LOOKS like the amount cell.
  // Kuma-specific fast path: look for a label container holding "金额"
  // (or an asterisk-prefixed variant), find the .field_xxx form-item ancestor,
  // and grab its `input.kuma-input[type=text]:not([readonly])` — that's the
  // amount field's actual signature in TAE. Skip variants like "申请金额" /
  // "报销金额" / "折算金额" / "本位币金额" which are computed/readonly.
  function findAmountInputByKumaStructure(scope) {
    const root = scope || document;
    // 1. Find label elements whose normalized text is exactly "金额".
    const labelEls = Array.from(root.querySelectorAll('div[class*="label"], span, label, p'))
      .filter(isVisible)
      .filter((el) => {
        const t = (el.textContent || "").trim().replace(/^[*\s]+/, "").replace(/[*：:\s]+$/, "");
        return t === "金额" || t === "费用金额";
      });
    for (const lbl of labelEls) {
      // 2. Walk up to the nearest Kuma form item — class contains "field_"
      // (CSS-modules hash). Cap at 6 levels — TAE wraps the label in a few
      // intermediate divs (label_xxx → flex → field_xxx) on some forms.
      let container = lbl;
      for (let i = 0; i < 6 && container; i++) {
        if (container.className && typeof container.className === "string" && /\bfield_/.test(container.className)) break;
        container = container.parentElement;
      }
      if (!container) continue;
      // 3. The field's input: kuma-input + type=text, not readonly, NOT the
      //    select2 internal search field.
      const candidates = Array.from(container.querySelectorAll('input.kuma-input, input[class*="kuma-input"]'))
        .filter(isVisible)
        .filter((inp) => inp.type === "text" && !inp.readOnly)
        .filter((inp) => !/select2-search|employee-search/.test(inp.className || ""));
      if (candidates.length) return candidates[0];
    }
    return null;
  }

  function findAmountInputByHeuristic(scope) {
    const root = scope || document;
    const labelEls = Array.from(root.querySelectorAll("label, span, div, dt, p, th, em, b, strong"))
      .filter(isVisible)
      .filter((el) => {
        const t = (el.textContent || "").trim().replace(/^[*\s]+/, "").replace(/[*：:\s]+$/, "");
        return t === "金额" || t === "费用金额";
      });
    if (!labelEls.length) return null;
    const inputs = Array.from(root.querySelectorAll('input:not([type="hidden"]):not([type="file"]):not([type="checkbox"]):not([type="radio"]):not([disabled]):not([readonly])'))
      .filter(isVisible)
      .filter((el) => !isInTableScope(el))
      // Reject Kuma's internal search inputs — they're for filtering dropdown
      // options, NOT for entering form values.
      .filter((el) => !/select2-search|employee-search/.test(el.className || ""));
    let best = null;
    let bestScore = -Infinity;
    for (const lbl of labelEls) {
      const lr = lbl.getBoundingClientRect();
      for (const inp of inputs) {
        const ir = inp.getBoundingClientRect();
        const verticalOverlap = Math.min(lr.bottom, ir.bottom) - Math.max(lr.top, ir.top);
        const horizontalOverlap = Math.min(lr.right, ir.right) - Math.max(lr.left, ir.left);
        const sameRow = verticalOverlap > 5 && ir.left >= lr.right - 4;
        const directlyBelow = ir.top >= lr.bottom - 4 && ir.top - lr.bottom < 30 && horizontalOverlap > 20;
        if (!sameRow && !directlyBelow) continue;
        const dist = sameRow
          ? (ir.left - lr.right)
          : (ir.top - lr.bottom + Math.abs((ir.left + ir.right) / 2 - (lr.left + lr.right) / 2));
        let score = -dist;
        if (/请输入|amount|\.|0/.test(inp.placeholder || "")) score += 50;
        if (inp.type === "number") score += 100;
        if (/kuma-input/.test(inp.className || "")) score += 80;
        if (inp.getAttribute("aria-label") && /金额/.test(inp.getAttribute("aria-label"))) score += 200;
        if (score > bestScore) { bestScore = score; best = inp; }
      }
    }
    return best;
  }

  function findFileInputByLabel(scope, labels) {
    if (!scope) return null;
    const allMatching = Array.from(scope.querySelectorAll("label, span, div, dt, p, th"))
      .filter(isVisible)
      .filter((el) => {
        const t = (el.textContent || "").trim().replace(/^[*\s]+/, "");
        return labels.some((l) => t === l || t === l + "：" || t === l + ":");
      });
    const nonTable = allMatching.filter((el) => !isInTableScope(el));
    const labelEls = nonTable.length > 0 ? nonTable : allMatching;
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
    // Anchor on the 「保存」 button: the category FORM drawer has one, the
    // category PICKER drawer does NOT. Walking up from the save button is
    // far more reliable than walking up from a "差旅-XXX" title text — TAE
    // nests its form bodies 7–9 levels deep, deeper than is safe to walk
    // from a title (you'd cross into the page wrapper).
    // The button's textContent may be "保存", "保存 ▾", "保存▾", or 保存草稿;
    // accept any starts-with-保存 that isn't 保存草稿.
    const saves = Array.from(document.querySelectorAll("button"))
      .filter(isVisible)
      .filter((b) => {
        const t = (b.textContent || "").trim();
        return t.startsWith("保存") && !t.startsWith("保存草稿");
      });
    for (const save of saves) {
      let cur = save.parentElement;
      // Walk up until we find an ancestor that holds form fields AND looks
      // like a category form (Chinese form labels we recognize).
      for (let i = 0; i < 14 && cur; i++) {
        if (cur.querySelector && cur.querySelector('input:not([type="hidden"]), textarea, select, [role="combobox"]')) {
          // Sanity: container should include category-form-ish text — guards
          // against returning a page-wide wrapper if other 保存 buttons exist.
          const txt = cur.textContent || "";
          if (/差旅-|有收据|无收据|费用发生|金额|币种|入住时间|乘机日期/.test(txt)) {
            return cur;
          }
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
        const text = (el.textContent || "").trim();
        const title = (el.getAttribute && el.getAttribute("title") || "").trim();
        // Match either text content or title attr — Kuma cascade items
        // sometimes wrap text in custom <icon> elements that swallow the
        // visible text node, but `title` is set on the <li> itself.
        return (texts.includes(text) || (title && texts.includes(title)))
          && (text.length <= 20 || (title && title.length <= 20))
          && el.children.length <= 3;
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
    // converted (本位币) amount.
    // Make sure ANY open Kuma combobox dropdown collapses first, otherwise
    // the dropdown's internal `kuma-select2-search__field` is visible inside
    // the form scope and pickFillable can grab it instead of the real amount
    // input. Click an inert spot, dispatch escape, and wait a tick.
    document.body.click();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await sleep(150);

    const wantAmt = String(rec.amount ?? 0);
    if (!rec.amount || parseFloat(wantAmt) === 0) {
      warn(`amount is 0 / missing for record (type=${rec.type}, source=${rec.source}); form will likely reject 保存 — edit the amount in the popup before importing.`);
    }
    // Resolution order matters:
    // 1. Kuma-specific structural lookup (label "金额" → field_xxx ancestor →
    //    input.kuma-input[type=text]:not([readonly])). This is dispositive on
    //    TAE because the amount input has a stable signature.
    // 2. Generic findInputByLabel (label-anchored sibling walk).
    // 3. Geometric heuristic (visual same-row / below-label).
    let amt = findAmountInputByKumaStructure(form)
      || findInputByLabel(form, LABELS.amount)
      || findAmountInputByHeuristic(form);
    log("→ amount input:", amt ? describeInput(amt) : "NOT FOUND");
    if (amt) {
      await setInputValue(amt, wantAmt);
      await sleep(180);
      try {
        amt.dispatchEvent(new Event("change", { bubbles: true }));
        amt.dispatchEvent(new FocusEvent("blur", { bubbles: true }));
      } catch {}
      document.body.click();
      // Verify and retry once with a fresh node lookup if the value vanished.
      await sleep(120);
      let fresh = findAmountInputByKumaStructure(form)
        || findInputByLabel(form, LABELS.amount)
        || findAmountInputByHeuristic(form)
        || amt;
      if (parseFloat((fresh.value || "0").toString().replace(/,/g, "")) !== parseFloat(wantAmt)) {
        log("amount didn't stick on first pass; retrying. got:", fresh.value, "want:", wantAmt);
        await setInputValue(fresh, wantAmt);
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
      warn("amount label not found in form — neither findInputByLabel nor heuristic found a candidate. Run 诊断 to see amountDeepProbe.");
    }

    // Note / 详细说明
    const note = findInputByLabel(form, LABELS.note);
    if (note) await setInputValue(note, rec.note || "");
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

  // Returns true if the element lives inside actual table chrome OR an ARIA
  // grid widget. Excluded ARIA roles are intentionally narrow — `row`/`cell`
  // would also match Fusion form items in some builds, which we DO want.
  const TABLE_SCOPE_SEL = "th, td, tr, thead, tbody, table, [role='columnheader'], [role='rowheader'], [role='gridcell'], [role='grid']";
  function isInTableScope(el) {
    return !!(el && el.closest && el.closest(TABLE_SCOPE_SEL));
  }

  function findInputByLabel(scope, labels) {
    const scan = scope || document;
    const allMatching = Array.from(scan.querySelectorAll("label, span, div, dt, p, th"))
      .filter(isVisible)
      .filter((el) => {
        const t = (el.textContent || "").trim().replace(/^[*\s]+/, "");
        return labels.some((l) => t === l || t === l + "：" || t === l + ":");
      });
    // PREFER drawer labels over table column headers (the expense list on the
    // left has a "金额" column header that would otherwise win in DOM order).
    // But if EVERY match happens to be in some grid-roled ancestor, fall back
    // to the full set rather than returning nothing — a Fusion build with
    // ARIA role="row" on form items shouldn't disqualify the real label.
    const nonTable = allMatching.filter((el) => !isInTableScope(el));
    const labelEls = nonTable.length > 0 ? nonTable : allMatching;

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
    const allMatching = Array.from((scope || document).querySelectorAll("label, span, div, dt, p, th"))
      .filter(isVisible)
      .filter((el) => {
        const t = (el.textContent || "").trim().replace(/^[*\s]+/, "");
        return labels.some((l) => t === l || t === l + "：" || t === l + ":");
      });
    const nonTable = allMatching.filter((el) => !isInTableScope(el));
    const labelEls = nonTable.length > 0 ? nonTable : allMatching;
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
    // Exclude:
    // - hidden / file inputs (not user-fillable)
    // - checkbox / radio (form metadata, not value fields)
    // - select2's internal search filter input (kuma-select2-search__field) —
    //   it's the dropdown's filter box, not a real form field
    // - employee-search filter input (people picker)
    const cands = Array.from(scope.querySelectorAll('input:not([type="hidden"]):not([type="file"]):not([type="checkbox"]):not([type="radio"]):not([disabled])'))
      .filter((el) => !/select2-search|employee-search/.test(el.className || ""));
    return (
      cands[0] ||
      scope.querySelector("textarea:not([disabled])") ||
      scope.querySelector("select:not([disabled])") ||
      scope.querySelector('[role="combobox"]') ||
      null
    );
  }

  /* ---------- Field setters ---------- */

  // Find the React props bag that React 16+ stashes on every controlled DOM
  // node (key is `__reactProps$<random>`). This is the dispositive hook for
  // Fusion / Ant / any React 16+ widget — calling onChange directly bypasses
  // every event-dispatch / tracker / IME quirk.
  function getReactProps(el) {
    if (!el) return null;
    const k = Object.keys(el).find((s) => s.startsWith("__reactProps$"));
    return k ? el[k] : null;
  }

  // Canonical React-16+ "setNativeValue": call the prototype setter (which is
  // the original native one) instead of the per-instance setter (which React
  // overrides). Uses Object.getPrototypeOf so it works for subclassed inputs
  // (Fusion sometimes wraps the input in a custom element constructor chain).
  function setNativeValue(el, value) {
    const ownDesc = Object.getOwnPropertyDescriptor(el, "value") || {};
    const proto = Object.getPrototypeOf(el) || HTMLInputElement.prototype;
    const protoDesc = Object.getOwnPropertyDescriptor(proto, "value") || {};
    if (protoDesc.set && ownDesc.set !== protoDesc.set) {
      protoDesc.set.call(el, value);
    } else if (ownDesc.set) {
      ownDesc.set.call(el, value);
    } else {
      el.value = value;
    }
  }

  async function setInputValue(el, value) {
    if (!el) return false;
    const str = String(value);
    try {
      el.focus();

      // Strategy A — React fiber direct call. React 16+ stashes the actual
      // onChange / onInput on the DOM node; calling it bypasses every
      // dispatch/tracker/IME quirk and is what works when nothing else does.
      try {
        const props = getReactProps(el);
        const handler = props && (props.onChange || props.onInput);
        if (typeof handler === "function") {
          // Update the DOM value first so React's handler reads the right
          // value when it inspects e.target.value.
          setNativeValue(el, str);
          const synthetic = {
            target: el, currentTarget: el,
            type: "change", bubbles: true, cancelable: true,
            preventDefault() {}, stopPropagation() {},
            persist() {}, nativeEvent: null,
          };
          handler(synthetic);
          // NumberPicker's wrapped handler signature is (value, event); try
          // that shape too if the standard call didn't take.
          await sleep(60);
          if (parseFloat((el.value || "0").toString().replace(/,/g, "")) !== parseFloat(str)) {
            try { handler(str, synthetic); } catch {}
          }
          await_dispatch(el, str);
          await sleep(60);
          if (parseFloat((el.value || "0").toString().replace(/,/g, "")) === parseFloat(str)) {
            return true;
          }
        }
      } catch (e) {
        warn("setInputValue strategy A (react props) failed:", e);
      }

      // Strategy B — execCommand insertText (real InputEvent). Most reliable
      // for Vue v-model and components that listen to `input` rather than
      // hook their own onChange.
      try {
        if (typeof el.select === "function") el.select();
        if (document.execCommand && document.execCommand("insertText", false, str)) {
          if (el.value === str) {
            await_dispatch(el);
            return true;
          }
        }
      } catch {}

      // Strategy C — canonical setNativeValue + tracker reset + dispatch.
      const oldValue = el.value;
      setNativeValue(el, str);
      const tracker = el._valueTracker;
      if (tracker && typeof tracker.setValue === "function" && oldValue !== str) {
        try { tracker.setValue(oldValue); } catch {}
      }
      await_dispatch(el, str);
      return true;
    } catch (e) {
      warn("setInputValue failed:", e);
      return false;
    }
  }

  // Fire input + change synchronously, blur on next tick (Fusion's onBlur
  // reformatter races with React's batched commit if blur is sync).
  function await_dispatch(el, str) {
    try {
      el.dispatchEvent(new InputEvent("input", { bubbles: true, data: str || el.value, inputType: "insertText" }));
    } catch {
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }
    el.dispatchEvent(new Event("change", { bubbles: true }));
    setTimeout(() => {
      try { el.dispatchEvent(new Event("blur", { bubbles: true })); } catch {}
    }, 0);
  }


  async function setDateLikeValue(el, iso) {
    if (!el || !iso) return false;
    if (el.type === "date") return await setInputValue(el, iso);

    el.focus();
    el.click();
    await setInputValue(el, iso);
    await sleep(200);
    // Some pickers want YYYY/MM/DD typed
    await setInputValue(el, iso.replaceAll("-", "/"));
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
    // findInputByLabel may hand us a Kuma combobox WRAPPER (a <div role=
    // "combobox">) instead of the inner search field — pickFillable
    // intentionally excludes `kuma-select2-search__field` for amount-input
    // safety. Locate the real search input here so we don't try to call
    // HTMLInputElement.prototype.value's setter on a <div> (that throws
    // "Illegal invocation").
    let typingTarget = el;
    if (el.tagName !== "INPUT" && el.tagName !== "TEXTAREA") {
      typingTarget = (el.querySelector && el.querySelector('input.kuma-select2-search__field, input[autocomplete="off"], input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([type="file"])'))
        || (el.parentElement && el.parentElement.querySelector && el.parentElement.querySelector('input.kuma-select2-search__field'))
        || el; // last-ditch: fall back to the wrapper itself (subsequent .value assign won't throw, just no-op)
    }
    try { el.focus(); } catch {}
    clickEl(el);
    await sleep(150);
    // Type the first candidate to filter — but only if typingTarget is a
    // real <input>; otherwise just open the dropdown and skip filtering.
    if (typingTarget && (typingTarget.tagName === "INPUT" || typingTarget.tagName === "TEXTAREA")) {
      try { typingTarget.focus(); } catch {}
      const proto = typingTarget.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
      try {
        if (setter) setter.call(typingTarget, candidateTexts[0]);
        else typingTarget.value = candidateTexts[0];
      } catch (e) {
        warn("setComboboxValue: typing into search input failed (will still try option click):", e);
      }
      typingTarget.dispatchEvent(new Event("input", { bubbles: true }));
    }
    await sleep(250);
    const opts = Array.from(
      document.querySelectorAll(
        '[role="option"], li[class*="option"], div[class*="option-item"], div[class*="MenuItem"]',
      ),
    ).filter(isVisible);
    log("combobox options visible:", opts.length, opts.slice(0, 5).map((o) => (o.textContent || "").trim()));
    // Normalize parens: TAE renders "CNY (人民币）" with a full-width 」）」
    // closing paren (and sometimes spaces vary). Compare both sides with the
    // parens stripped so "CNY (人民币)" still matches "CNY (人民币）".
    const normParens = (s) => (s || "").replace(/[()（）]/g, "").replace(/\s+/g, " ").trim();
    const opt = opts.find((o) => {
      const text = (o.textContent || "").trim();
      const textNorm = normParens(text);
      return candidateTexts.some((t) => {
        if (!t) return false;
        return text.includes(t) || textNorm.includes(normParens(t));
      });
    });
    if (opt) {
      clickEl(opt);
      await sleep(150);
      // Force-collapse the dropdown. If we leave it open, its internal
      // `kuma-select2-search__field` stays visible inside the form and our
      // next findInputByLabel / pickFillable run can mistake it for the
      // amount text input. Click body + Esc + blur the search input.
      try { el.blur(); } catch {}
      document.body.click();
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      await sleep(120);
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
    // React 16+ stashes props as __reactProps$<random>. Surface which handlers
    // are present — onChange/onInput/onBlur tell us we can drive the field
    // via Strategy A (fiber call) regardless of event-dispatch quirks.
    const reactKey = Object.keys(el).find((s) => s.startsWith("__reactProps$"));
    const props = reactKey ? el[reactKey] : null;
    const handlers = props ? Object.keys(props).filter((k) => /^on[A-Z]/.test(k) && typeof props[k] === "function") : [];
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
      hasReactProps: !!props,
      reactHandlers: handlers,
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
