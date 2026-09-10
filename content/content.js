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
    const failures = perRecord.filter((r) => !r.ok);
    hideOverlay(
      failures.length
        ? `已写入 ${filled} / ${records.length} 条，${failures.length} 条失败`
        : `已写入 ${filled} / ${records.length} 条 (附件 ${attached})`,
    );
    if (filled === 0) {
      throw new Error(
        failures[0]?.error
          ? `0 条写入成功：${failures[0].error}`
          : "0 条写入成功——请打开 DevTools 控制台查看 [FliggyClaim] 日志",
      );
    }
    // Surface partial failures: a record we refuse to save (e.g. the amount
    // wouldn't take) must never be silently rounded down to "done".
    return {
      filled,
      attached,
      failed: failures.length,
      firstError: failures[0]?.error || null,
      failedIndexes: failures.map((r) => r.index),
    };
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
    const leafTitle = (leaf.textContent || "").trim();
    log("→ clicking category leaf", leaf);
    clickEl(leaf);

    // 4. Wait for the category form to be READY (fields rendered), not merely
    // present. Returning on a half-rendered drawer is what let
    // findCategoryForm() walk all the way up to the page wrapper — which drags
    // the left-hand expense table (and its own 「金额」 column header) into
    // scope, so 金额 resolved to a table row checkbox.
    const form = await waitFor(
      () => {
        const f = findCategoryForm();
        return f && isFormReady(f) ? f : null;
      },
      10000,
      "category form",
    );
    // The leaf we just clicked IS the form's identity. Sniffing a title out of
    // the DOM broke as soon as the drawer scope tightened (the heading lives
    // outside the form body), and an empty title silently disabled every
    // hotel-specific branch below.
    const formTitle = leafTitle || sniffFormTitle(form);
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

  // Geometric fallback when the label-anchored lookup finds nothing for 金额:
  // pick the input visually closest to a 金额 label, to its right or below.
  function findAmountInputByHeuristic(scope) {
    const root = scope || document;
    const labelEls = collectLabelEls(root, LABELS.amount, true);
    if (!labelEls.length) return null;
    const inputs = Array.from(root.querySelectorAll('input:not([type="hidden"]):not([type="file"]):not([type="checkbox"]):not([type="radio"]):not([disabled]):not([readonly])'))
      .filter(isVisible)
      // Skip inputs inside the read-only expense table on the left.
      .filter((el) => !isInTableScope(el))
      // Never a dropdown's typeahead box — writing there wipes its selection.
      .filter((el) => !BAD_CONTROL_CLS.test((el.className || "").toString()));
    let best = null;
    let bestScore = -Infinity;
    for (const lbl of labelEls) {
      const lr = lbl.getBoundingClientRect();
      for (const inp of inputs) {
        const ir = inp.getBoundingClientRect();
        // Same row (vertical overlap) AND input is to the right of the label,
        // OR input is directly below the label.
        const verticalOverlap = Math.min(lr.bottom, ir.bottom) - Math.max(lr.top, ir.top);
        const horizontalOverlap = Math.min(lr.right, ir.right) - Math.max(lr.left, ir.left);
        const sameRow = verticalOverlap > 5 && ir.left >= lr.right - 4;
        const directlyBelow = ir.top >= lr.bottom - 4 && ir.top - lr.bottom < 30 && horizontalOverlap > 20;
        if (!sameRow && !directlyBelow) continue;
        // Closer = better. Penalize distance.
        const dist = sameRow
          ? (ir.left - lr.right)
          : (ir.top - lr.bottom + Math.abs((ir.left + ir.right) / 2 - (lr.left + lr.right) / 2));
        // Bonus for placeholder mentioning 输入 / amount-y attributes.
        let score = -dist;
        if (/请输入|amount|\.|0/.test(inp.placeholder || "")) score += 50;
        if (inp.type === "number") score += 100;
        if (inp.getAttribute("aria-label") && /金额/.test(inp.getAttribute("aria-label"))) score += 200;
        if (score > bestScore) { bestScore = score; best = inp; }
      }
    }
    return best;
  }

  // Same row-scoped anchor strategy as findControlByLabel, but for file inputs
  // (which pickControl deliberately excludes).
  function findFileInputByLabel(scope, labels) {
    if (!scope) return null;
    const pickFile = (el) => (el && el.querySelector
      ? el.querySelector('input[type="file"]:not([disabled])') : null);
    for (const loose of [false, true]) {
      for (const lbl of collectLabelEls(scope, labels, loose)) {
        let sib = lbl.nextElementSibling;
        for (let i = 0; i < 3 && sib; i++) {
          const fi = pickFile(sib);
          if (fi) return fi;
          sib = sib.nextElementSibling;
        }
        let cur = lbl.parentElement;
        for (let i = 0; i < 4 && cur && cur !== scope; i++) {
          if (fieldRowsIn(cur).length > 1 || containsForeignLabel(cur, labels)) break;
          const fi = pickFile(cur);
          if (fi) return fi;
          cur = cur.parentElement;
        }
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

  // A "field row" is TAE's one-label-one-control wrapper (`field_xxxx`), the
  // unit every label lookup must stay inside.
  const FIELD_ROW_SEL =
    '[class*="field_"], [class*="field-"], [class*="formItem"], [class*="form-item"], [class*="FormItem"], .kuma-form-item';

  function fieldRowsIn(el) {
    if (!el || !el.querySelectorAll) return [];
    return Array.from(el.querySelectorAll(FIELD_ROW_SEL)).filter(isVisible);
  }

  // How much of a form body does this container hold? Prefer counting real
  // field rows; fall back to counting visible controls so a class-name change
  // in TAE's CSS-module hashes can't take the whole flow down.
  function formBodyWeight(el) {
    const rows = fieldRowsIn(el).length;
    if (rows) return rows;
    return Array.from(
      el.querySelectorAll('input:not([type="hidden"]):not([type="file"]), textarea, [role="combobox"]'),
    ).filter(isVisible).length;
  }

  function findCategoryForm() {
    // Anchor on the 「保存」 button: the category FORM drawer has one, the
    // category PICKER drawer does NOT. Then walk up only as far as the
    // SMALLEST container that actually holds the form body.
    //
    // Two hard stops keep the scope honest:
    //   • never accept a container that also holds the 「新增费用」 toolbar
    //     button — that button lives in the master (left) pane, so such a
    //     container is the page wrapper, and the expense table inside it has
    //     its own 「金额」 column header that hijacks every label lookup;
    //   • never accept table chrome.
    // The old version stopped at the first ancestor holding *any* input whose
    // text merely mentioned 金额/费用发生 — on a not-yet-rendered drawer that
    // matched the page wrapper, because the left-hand table supplies exactly
    // those words.
    const addBtn = findAddExpenseButton();
    const saves = Array.from(document.querySelectorAll("button"))
      .filter(isVisible)
      .filter((b) => {
        const t = (b.textContent || "").trim();
        return t.startsWith("保存") && !t.startsWith("保存草稿");
      });
    for (const save of saves) {
      let cur = save.parentElement;
      for (let i = 0; i < 14 && cur; i++) {
        if (addBtn && cur.contains(addBtn)) break; // walked into the master pane
        if (cur === document.body || cur === document.documentElement) break;
        if (!isInTableScope(cur) && formBodyWeight(cur) >= 2) return cur;
        cur = cur.parentElement;
      }
    }
    return null;
  }

  // The drawer mounts its 保存 button before the schema-driven fields land.
  // Treat it as usable only once the fields are actually there.
  function isFormReady(form) {
    if (!form) return false;
    if (collectLabelEls(form, LABELS.amount).length) return true;
    return fieldRowsIn(form).length >= 3;
  }

  // Only a fallback now — the clicked category leaf is the authoritative title.
  function sniffFormTitle(form) {
    const scope = form?.closest('[class*="detail"], [class*="drawer"], [class*="content"]') || document;
    const el = Array.from(scope.querySelectorAll("h1, h2, h3, h4, div, span"))
      .filter(isVisible)
      .find((n) => /^差旅-/.test((n.textContent || "").trim()) && (n.textContent || "").trim().length < 12);
    return (el?.textContent || "").trim();
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
      const ci = findControlByLabel(form, LABELS.checkin, "date");
      const checkinDate = rec.checkin || rec.date;
      if (ci) await setDateLikeValue(ci, checkinDate);
      const co = findControlByLabel(form, LABELS.checkout, "date");
      const checkoutDate = rec.checkout || addNDays(checkinDate, rec.nights || 1);
      if (co) await setDateLikeValue(co, checkoutDate);
    } else {
      // 费用发生时间 (optional on most forms, required on none of the screenshots)
      const dateEl = findControlByLabel(form, LABELS.date, "date");
      if (dateEl) await setDateLikeValue(dateEl, rec.date);
      // 乘机日期★ — only on the flight form, and it IS required.
      if (isFlight) {
        const fdEl = findControlByLabel(form, LABELS.flightDate, "date");
        if (fdEl) await setDateLikeValue(fdEl, rec.date);
      }
    }
    // 城市 may exist on hotel/meal/taxi/other forms — try unconditionally.
    await setComboByLabel(form, LABELS.city, [cityName], cityName);

    if (isTaxi) {
      // 是否网约车 radio – default to 是
      const yes = findRadioByLabel(form, LABELS.rideshare, "是");
      if (yes) clickEl(yes);
    }

    // Currency MUST be set before amount: TAE clears the amount field
    // when the currency changes (and re-fetches the FX rate against the
    // report's base currency). Filling amount first would be silently wiped.
    const curOk = await setComboByLabel(
      form, LABELS.currency,
      [rec.currency, currencyDisplay(rec.currency)],
      rec.currency,
    );
    // Give TAE time to fire the FX-rate request triggered by the change.
    if (curOk) await sleep(450);

    // Amount – set after currency, then nudge the form to recompute the
    // converted (本位币) amount.
    //
    // Every pass RE-RESOLVES the input before reading it back. The old code
    // verified `el.value` on whatever node it had first landed on, so when the
    // lookup returned a checkbox the check "passed" purely because we had just
    // assigned .value to that checkbox — and a record with no amount at all
    // got saved and reported as ✓.
    const wantAmt = String(rec.amount ?? 0);
    let amtEl = findAmountInput(form);
    log("→ amount input:", amtEl ? describeInput(amtEl) : "NOT FOUND");
    if (!amtEl) {
      throw new Error("没找到「金额」输入框——请打开 DevTools 控制台查看 [FliggyClaim] 日志，或运行诊断");
    }
    let amtOk = false;
    for (let pass = 1; pass <= 3 && !amtOk; pass++) {
      await setInputValue(amtEl, wantAmt);
      await sleep(200);
      try {
        amtEl.dispatchEvent(new Event("change", { bubbles: true }));
        amtEl.dispatchEvent(new FocusEvent("blur", { bubbles: true }));
        amtEl.blur();
      } catch {}
      await sleep(150);
      // Currency changes re-mount the InputNumber, so the node may be stale.
      amtEl = findAmountInput(form) || amtEl;
      amtOk = sameAmount(amtEl.value, wantAmt);
      if (!amtOk) log(`amount pass ${pass} didn't stick. got:`, amtEl.value, "want:", wantAmt);
    }
    log("amount final value:", amtEl.value);
    outcome.amountFinal = amtEl.value;
    outcome.amountInput = describeInput(amtEl);
    if (!amtOk) {
      // Refuse to save a record whose amount we could not write — an expense
      // row with a blank/wrong 金额 is worse than a failed row the user can
      // retry, and it used to be reported as a success.
      throw new Error(`金额没能写入（期望 ${wantAmt}，实际「${amtEl.value}」）——该条已取消，未保存`);
    }
    await waitForRatePopulated(form, 2500);

    // The 币种 dropdown sits directly after 金额 in every category form; a
    // stray focus/blur can knock it back to the report's default currency.
    // Re-assert it before 保存 — a wrong 币种 silently changes the claim value.
    await verifyComboByLabel(form, LABELS.currency, [rec.currency, currencyDisplay(rec.currency)], rec.currency);

    // Note / 详细说明
    const note = findControlByLabel(form, LABELS.note, "textarea") || findControlByLabel(form, LABELS.note, "text");
    if (note) await setInputValue(note, rec.note || "");
    return outcome;
  }

  function sameAmount(got, want) {
    const a = parseFloat((got ?? "").toString().replace(/[,\s￥¥]/g, ""));
    const b = parseFloat((want ?? "").toString().replace(/[,\s￥¥]/g, ""));
    if (!isFinite(a) || !isFinite(b)) return false;
    return Math.abs(a - b) < 0.005;
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

  // Anything that counts as a control. Used both to pick fields AND — just as
  // importantly — to DISQUALIFY label candidates: a real label never wraps its
  // own control.
  const CONTROL_SEL =
    'input:not([type="hidden"]), textarea, select, [role="combobox"], [contenteditable="true"]';

  // Normalize label text: drop whitespace, the required-star, and trailing
  // colons of either width.
  function normLabel(s) {
    return (s || "")
      .replace(/\s+/g, "")
      .replace(/^[*＊]+/, "")
      .replace(/[*＊]+$/, "")
      .replace(/[:：]+$/, "");
  }

  // A bracketed suffix such as 「金额（元）」 is still the 金额 label.
  const LOOSE_TAIL = /^[（(【[][^）)】\]]{0,6}[）)】\]]$/;

  const ALL_LABEL_TEXTS = new Set(Object.values(LABELS).flat().map(normLabel));

  /**
   * Collect the elements that ARE the label for `labels`.
   *
   * The `!el.querySelector(CONTROL_SEL)` filter is the fix for the bug that
   * sent 金额 into the 币种 combobox: TAE's field wrapper has exactly the
   * label's text as its textContent (an <input> contributes nothing), so the
   * wrapper matched first in DOM order, and walking to ITS next sibling landed
   * on the NEXT FIELD's control. A wrapper contains a control; a label doesn't.
   */
  function collectLabelEls(scope, labels, loose) {
    const want = labels.map(normLabel);
    const cands = Array.from((scope || document).querySelectorAll("label, span, div, dt, p, th, em, b, strong"))
      .filter(isVisible)
      .filter((el) => !el.querySelector(CONTROL_SEL));
    const exact = cands.filter((el) => want.includes(normLabel(el.textContent)));
    if (exact.length || !loose) return exact;
    return cands.filter((el) => {
      const t = normLabel(el.textContent);
      return want.some((w) => t.length > w.length && t.startsWith(w) && LOOSE_TAIL.test(t.slice(w.length)));
    });
  }

  // True once `el` has grown big enough to hold a DIFFERENT field's label —
  // i.e. climbing one more level would let us reach the wrong control.
  function containsForeignLabel(el, labels) {
    const own = new Set(labels.map(normLabel));
    return Array.from(el.querySelectorAll("label, span, div, dt, p")).some((n) => {
      if (!isVisible(n) || n.querySelector(CONTROL_SEL)) return false;
      const t = normLabel(n.textContent);
      return !!t && ALL_LABEL_TEXTS.has(t) && !own.has(t);
    });
  }

  const NON_VALUE_INPUT_TYPES = ["file", "checkbox", "radio", "button", "submit", "reset", "image"];
  // select2 keeps a text input inside every dropdown (and the employee picker)
  // purely for typeahead. Writing an amount there does nothing except wipe the
  // dropdown's current selection — exactly what turned 币种 back into SGD.
  const BAD_CONTROL_CLS = /select2-search|search__field|mirror|checkbox|radio|switch/i;

  /**
   * Pick the control of a given kind inside `scope` (a single field row).
   *   amount   – editable text/number input, prefers TAE's NumberInput wrapper
   *   date     – calendar input (readonly is normal for these)
   *   combobox – the VISIBLE select2 selection box (never its hidden search input)
   *   textarea – textarea
   *   text/any – first usable control
   */
  function pickControl(scope, kind) {
    if (!scope || !scope.querySelectorAll) return null;
    const vis = (sel) => Array.from(scope.querySelectorAll(sel)).filter(isVisible);
    const textInputs = vis('input:not([type="hidden"])')
      .filter((el) => !NON_VALUE_INPUT_TYPES.includes((el.type || "text").toLowerCase()))
      .filter((el) => !el.disabled)
      .filter((el) => !BAD_CONTROL_CLS.test((el.className || "").toString()));
    const isCalendar = (el) =>
      /calendar|datepicker/i.test(((el.className || "") + " " + (el.parentElement?.className || "")).toString());

    switch (kind) {
      case "amount": {
        const editable = textInputs.filter((el) => !el.readOnly && !isCalendar(el));
        return (
          editable.find((el) => el.closest('[class*="numberInput"], [class*="number-input"], [class*="InputNumber"]')) ||
          editable.find((el) => (el.type || "").toLowerCase() === "number") ||
          editable[0] ||
          null
        );
      }
      case "date":
        return textInputs.find(isCalendar) || textInputs.find((el) => el.readOnly) || textInputs[0] || null;
      case "combobox":
        return (
          vis('[class*="select2-selection"]').find((el) => !el.getAttribute("disabled")) ||
          vis('[role="combobox"]')[0] ||
          vis("select:not([disabled])")[0] ||
          null
        );
      case "textarea":
        return vis("textarea:not([disabled])")[0] || null;
      case "text":
      default:
        return (
          textInputs.find((el) => !el.readOnly) ||
          vis("textarea:not([disabled])")[0] ||
          textInputs[0] ||
          vis('[role="combobox"], select:not([disabled])')[0] ||
          null
        );
    }
  }

  /**
   * Label-anchored control lookup that never leaves the label's own field row.
   * Resolution order: for= binding → the label's own next siblings → climb,
   * stopping the instant the ancestor also owns another field.
   */
  function findControlByLabel(scope, labels, kind) {
    const scan = scope || document;
    for (const loose of [false, true]) {
      for (const lbl of collectLabelEls(scan, labels, loose)) {
        const forId = lbl.getAttribute && lbl.getAttribute("for");
        if (forId) {
          const target = document.getElementById(forId);
          if (target && isVisible(target)) return target;
        }
        // (a) siblings of the label — same field row by construction
        let sib = lbl.nextElementSibling;
        for (let i = 0; i < 3 && sib; i++) {
          const c = pickControl(sib, kind);
          if (c) return c;
          sib = sib.nextElementSibling;
        }
        // (b) climb to the row wrapper, but no further than this field
        let cur = lbl.parentElement;
        for (let i = 0; i < 4 && cur && cur !== scan; i++) {
          if (fieldRowsIn(cur).length > 1 || containsForeignLabel(cur, labels)) break;
          const c = pickControl(cur, kind);
          if (c) return c;
          cur = cur.parentElement;
        }
      }
    }
    return null;
  }

  // Kept for the diagnostics probes.
  function findInputByLabel(scope, labels) {
    return findControlByLabel(scope, labels, "any");
  }

  function findAmountInput(form) {
    return findControlByLabel(form, LABELS.amount, "amount") || findAmountInputByHeuristic(form);
  }

  function findRadioByLabel(scope, labels, optionText) {
    const labelEls = collectLabelEls(scope || document, labels, true);
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

  // Compare display text width-insensitively: TAE renders 「CNY (人民币）」 with
  // a fullwidth closing paren, which no literal in this file would ever match.
  function normText(s) {
    return (s || "")
      .toString()
      .replace(/\s+/g, "")
      .replace(/[（]/g, "(")
      .replace(/[）]/g, ")")
      .toUpperCase();
  }

  // What the select2 widget currently shows as its selection ("" if none).
  // Order matters: the dedicated value node must win over the __rendered
  // wrapper, which still holds the (display:none) placeholder as text.
  function readComboSelection(comp) {
    if (!comp) return "";
    const el =
      comp.querySelector('[class*="selection-selected-value"]') ||
      comp.querySelector('[class*="selection__choice"]') ||
      comp.querySelector('[class*="selection__rendered"]');
    if (!el) return "";
    let txt = (el.getAttribute("title") || "").trim();
    if (!txt) {
      txt = Array.from(el.childNodes)
        .filter((n) => n.nodeType === 3
          || (n.nodeType === 1 && isVisible(n) && !/search/i.test((n.className || "").toString())))
        .map((n) => (n.textContent || "").trim())
        .join("")
        .trim();
    }
    return /^(请选择|请输入|输入姓名)/.test(txt) ? "" : txt;
  }

  async function setComboByLabel(form, labels, candidateTexts, wantCode) {
    const combo = findControlByLabel(form, labels, "combobox");
    if (!combo) return false;
    return await setComboboxValue(combo, candidateTexts, wantCode);
  }

  // Re-assert a dropdown that something else may have clobbered. Only acts
  // when we can read a selection that definitively differs from what we want.
  async function verifyComboByLabel(form, labels, candidateTexts, wantCode) {
    const combo = findControlByLabel(form, labels, "combobox");
    if (!combo) return true;
    const comp = comboComponent(combo);
    const got = readComboSelection(comp);
    if (!got || normText(got).includes(normText(wantCode))) return true;
    warn(`${labels[0]} 被改回了「${got}」，重设为 ${wantCode}`);
    return await setComboboxValue(combo, candidateTexts, wantCode);
  }

  function comboComponent(el) {
    return el.closest('[class*="kuma-select2"], [class*="select_"], [class*="employee-search"]') || el.parentElement || el;
  }

  /**
   * Drive a kuma-select2 dropdown.
   *
   * `el` is the VISIBLE selection box (or a native <select>). The widget keeps
   * its typeahead <input> at display:none until it opens, and events dispatched
   * at a display:none input do nothing — which is why 币种 used to stay on the
   * report's default currency. So: click the selection box first, then type.
   */
  async function setComboboxValue(el, candidateTexts, wantCode) {
    if (!el) return false;
    const wants = candidateTexts.filter(Boolean).map(normText);
    if (el.tagName === "SELECT") {
      const opt = Array.from(el.options).find((o) => wants.some((t) => normText(o.textContent).includes(t)));
      if (!opt) return false;
      el.value = opt.value;
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    }
    const comp = comboComponent(el);
    // Open the dropdown — this is what reveals the typeahead input.
    clickEl(comp.querySelector('[class*="select2-selection"]') || el);
    await sleep(220);
    const search = Array.from(comp.querySelectorAll('input[class*="search__field"], input[type="text"], input:not([type])'))
      .find((i) => !i.disabled) || (el.tagName === "INPUT" ? el : null);
    if (search) {
      try { search.focus(); } catch {}
      setNativeValue(search, candidateTexts[0]);
      try {
        search.dispatchEvent(new InputEvent("input", { bubbles: true, data: candidateTexts[0], inputType: "insertText" }));
      } catch {
        search.dispatchEvent(new Event("input", { bubbles: true }));
      }
      await sleep(320);
    }
    const opts = Array.from(
      document.querySelectorAll(
        '[role="option"], li[class*="option"], div[class*="option-item"], div[class*="MenuItem"]',
      ),
    ).filter(isVisible);
    log("combobox options visible:", opts.length, opts.slice(0, 5).map((o) => (o.textContent || "").trim()));
    const opt = opts.find((o) => wants.some((t) => normText(o.textContent).includes(t)));
    if (opt) {
      clickEl(opt);
      await sleep(220);
    } else if (search) {
      search.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, keyCode: 13 }));
      await sleep(220);
    }
    const got = readComboSelection(comp);
    const ok = !wantCode || (!!got && normText(got).includes(normText(wantCode)));
    log("combobox selected:", got || "(空)", ok ? "✓" : `✗ 期望 ${wantCode}`);
    return ok;
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
