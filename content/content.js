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
  // Use console.log (not console.warn) so non-fatal "skip and fall back" notices
  // don't show up as red errors on chrome://extensions.
  const warn = (...a) => console.log("%c[FliggyClaim]%c warn:", "color:#d71e1e;font-weight:bold", "color:#b06000;font-weight:bold", ...a);

  log("content script loaded on", location.href, "frame:", window.top === window ? "top" : "iframe");

  // Map our internal type → TAE category leaf text (with fallback list)
  const CATEGORY_LEAF = {
    flight: ["差旅-机票", "差旅-机", "机票"],
    hotel: ["差旅-住宿", "住宿", "差旅-酒店"],
    meal: ["差旅-餐费", "差旅-餐饮", "餐费", "餐饮"],
    taxi: ["差旅-打车", "差旅-出租车", "打车"],
    other: ["差旅-其他", "差旅-其它", "其他"],
  };

  // Each category form's labels we recognize
  const LABELS = {
    date: ["费用发生时间", "发生日期", "消费日期", "费用日期", "日期"],
    checkin: ["入住时间"],
    checkout: ["离店时间"],
    city: ["费用发生城市", "发生城市", "城市"],
    amount: ["金额", "费用金额", "总金额"],
    currency: ["币种", "货币", "Currency"],
    note: ["详细说明", "备注", "说明", "事由"],
    rideshare: ["是否网约车"],
    flightFrom: ["出发城市", "出发地"],
    flightTo: ["到达城市", "到达地", "目的地"],
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
        sendResponse({ ok: true, report: diagnose() });
      } catch (err) {
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
      return true;
    }
  }

  /* ---------- Public flow ---------- */

  async function fillRecords(records) {
    log(`starting fill: ${records.length} records`);
    let filled = 0;
    showOverlay(`准备写入 ${records.length} 条…`);
    for (let i = 0; i < records.length; i++) {
      const rec = records[i];
      showOverlay(`写入第 ${i + 1} / ${records.length} 条 (${rec.type})…`);
      try {
        await fillSingleExpense(rec);
        filled++;
        log(`✓ filled record ${i + 1}/${records.length}`, rec);
      } catch (e) {
        warn(`× record ${i + 1}/${records.length} failed:`, rec, e);
        await tryCancelDrawer();
      }
      await sleep(700);
    }
    hideOverlay(`已写入 ${filled} / ${records.length} 条`);
    if (filled === 0) {
      throw new Error("0 条写入成功——请打开 DevTools 控制台查看 [FliggyClaim] 日志");
    }
    return { filled };
  }

  async function fillSingleExpense(rec) {
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
    await fillFormFields(form, rec, formTitle);

    // 6. Click 保存 inside the form
    const saveBtn = findSaveButton(form);
    if (!saveBtn) throw new Error("没找到表单内的「保存」按钮");
    log("→ clicking 保存", saveBtn);
    clickEl(saveBtn);

    // 7. Wait for drawer to close (form vanishes)
    await waitFor(() => !findCategoryForm(), 6000, "drawer close");
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
    // Form has a header like "差旅-餐费" / "差旅-住宿" etc., and 保存 button
    const titles = Array.from(document.querySelectorAll("h1, h2, h3, h4, div, span"))
      .filter(isVisible)
      .filter((el) => /^差旅-/.test((el.textContent || "").trim()) && (el.textContent || "").trim().length < 12);
    for (const t of titles) {
      let cur = t;
      for (let i = 0; i < 10 && cur; i++) {
        if (cur.querySelector && cur.querySelector("input, textarea, select")) {
          // Confirm it has a 保存 button somewhere inside
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

    // Common fields
    if (isHotel) {
      const ci = findInputByLabel(form, LABELS.checkin);
      if (ci) await setDateLikeValue(ci, rec.date);
      const co = findInputByLabel(form, LABELS.checkout);
      if (co) await setDateLikeValue(co, addOneDay(rec.date));
      const city = findInputByLabel(form, LABELS.city);
      if (city) await setComboboxValue(city, [extractCityFromNote(rec.note) || "上海"]);
    } else {
      const dateEl = findInputByLabel(form, LABELS.date);
      if (dateEl) await setDateLikeValue(dateEl, rec.date);
    }

    if (isTaxi) {
      // 是否网约车 radio – default to 是
      const yes = findRadioByLabel(form, LABELS.rideshare, "是");
      if (yes) clickEl(yes);
    }

    // Amount
    const amt = findInputByLabel(form, LABELS.amount);
    if (amt) setInputValue(amt, String(rec.amount ?? 0));
    else warn("amount label not found in form");

    // Currency – form usually defaults to SGD; force-change
    const cur = findInputByLabel(form, LABELS.currency);
    if (cur) await setComboboxValue(cur, [rec.currency, currencyDisplay(rec.currency)]);

    // Note / 详细说明
    const note = findInputByLabel(form, LABELS.note);
    if (note) setInputValue(note, rec.note || "");
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

  function addOneDay(iso) {
    if (!iso) return iso;
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    d.setDate(d.getDate() + 1);
    return d.toISOString().slice(0, 10);
  }

  function extractCityFromNote(note) {
    if (!note) return null;
    const cities = ["北京", "上海", "杭州", "广州", "深圳", "成都", "重庆", "南京", "苏州", "西安", "天津", "厦门", "青岛", "长沙", "郑州", "宁波", "武汉", "香港", "澳门", "曼谷"];
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
      });

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
      });
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
    try {
      el.focus();
      const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
      const oldValue = el.value;
      if (setter) setter.call(el, value);
      else el.value = value;
      // Without this, Fusion/React-controlled InputNumber sees no diff and reverts to 0.
      const tracker = el._valueTracker;
      if (tracker && typeof tracker.setValue === "function" && oldValue !== value) {
        try { tracker.setValue(oldValue); } catch {}
      }
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      // Defer blur: an InputNumber's onBlur reformatter races with React's batched
      // state commit and would revert the value to 0 if dispatched synchronously.
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

  function diagnose() {
    return {
      url: location.href,
      title: document.title,
      isTop: window.top === window,
      addButton: describeMaybe(findAddExpenseButton()),
      categoryPicker: !!findCategoryPicker(),
      categoryForm: describeMaybe(findCategoryForm()),
      currentVisibleLabels: collectVisibleLabels(),
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
