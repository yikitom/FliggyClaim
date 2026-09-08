/*
 * White-box tests for content.js finders and setters, run in real headless
 * Chromium against the TAE fixture, via the window.__fliggyInternals hook
 * (exposed only when window.__FLIGGY_TEST__ is set before the script loads).
 *
 * These pin down the DOM contract that the black-box E2E relies on:
 *   • label matching is innermost-only (a field container whose only text is
 *     its label must not win)
 *   • every finder looks INSIDE the label's own field container — never at a
 *     sibling field
 *   • amount never resolves to the checkbox / select2 search / readonly box
 *   • 保存 never resolves to 保存草稿
 */
"use strict";

const path = require("path");
const fs = require("fs");
const { execSync } = require("child_process");

function loadPlaywright() {
  try { return require("playwright"); } catch {}
  return require(path.join(execSync("npm root -g").toString().trim(), "playwright"));
}

const FIXTURE = "file://" + path.resolve(__dirname, "fixtures/tae-hotel-form.html");
const CONTENT_JS = fs.readFileSync(path.resolve(__dirname, "../content/content.js"), "utf8");

let browser = null, ctx = null, page = null;
async function boot(openForm) {
  if (!browser) {
    const { chromium } = loadPlaywright();
    browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-gpu"] });
  }
  if (page) { await ctx.close(); }
  ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  page = await ctx.newPage();
  await page.goto(FIXTURE);
  await page.evaluate(() => {
    window.__FLIGGY_TEST__ = true;
    window.chrome = { runtime: { onMessage: { addListener() {} }, getURL: (p) => p } };
  });
  await page.addScriptTag({ content: CONTENT_JS });
  if (openForm) await page.evaluate((t) => window.__fixture.openForm(t), openForm);
  return page;
}
afterAll(async () => { if (ctx) await ctx.close(); if (browser) await browser.close(); });

// Evaluate `fn(I, form, helpers)` in the page. `I` = internals; `form` = the
// resolved category form; `key(el)` = the fixture's data-key for an element.
function inPage(fn) {
  return page.evaluate(`(() => {
    const I = window.__fliggyInternals;
    const form = I.findCategoryForm();
    const key = (el) => el ? (el.getAttribute("data-key") || (el.closest && el.closest("[data-key]") && el.closest("[data-key]").getAttribute("data-key")) || null) : null;
    const cls = (el) => el ? String(el.className) : null;
    return (${fn.toString()})(I, form, { key, cls });
  })()`);
}

/* ---------------- pure helpers ---------------- */

test("normalizeLabelText strips required markers, colons, and whitespace on both ends", async () => {
  await boot();
  const out = await inPage((I) => [
    I.normalizeLabelText("金额"), I.normalizeLabelText("* 金额"), I.normalizeLabelText("＊金额："),
    I.normalizeLabelText("  金额 : "), I.normalizeLabelText("金额*"), I.normalizeLabelText("报销金额"),
    I.normalizeLabelText("  费用 发生 城市 "),
  ]);
  assert.deepEq(out, ["金额", "金额", "金额", "金额", "金额", "报销金额", "费用 发生 城市"]);
});

test("isInTableScope: table header 金额 is in scope, drawer label is not", async () => {
  await boot("hotel");
  const out = await inPage((I) => {
    const th = Array.from(document.querySelectorAll("th")).find((e) => e.textContent.trim() === "金额");
    const lbl = Array.from(document.querySelectorAll(".label_3OUma")).find((e) => e.textContent.trim() === "金额");
    return { th: I.isInTableScope(th), lbl: I.isInTableScope(lbl) };
  });
  assert.eq(out.th, true);
  assert.eq(out.lbl, false);
});

/* ---------------- label resolution ---------------- */

test("findLabelEls: innermost only — the field container whose text is just '金额' is excluded", async () => {
  await boot("hotel");
  const out = await inPage((I, form, h) => {
    const els = I.findLabelEls(form, I.LABELS.amount);
    return { n: els.length, cls: els.map(h.cls), tags: els.map((e) => e.tagName) };
  });
  assert.eq(out.n, 1, "exactly one label for 金额");
  assert.match(out.cls[0], /label_/, "it's the label_xxx element, not the field_xxx container");
});

test("findLabelEls: prefers drawer labels over the table's 金额 column header when scope is the page", async () => {
  await boot("hotel");
  const out = await inPage((I, form, h) => {
    const els = I.findLabelEls(document, I.LABELS.amount);
    return { n: els.length, inTable: els.map((e) => I.isInTableScope(e)) };
  });
  assert.eq(out.n, 1);
  assert.deepEq(out.inTable, [false]);
});

test("fieldContainerOf: climbs to the field_ container", async () => {
  await boot("hotel");
  const out = await inPage((I, form, h) => {
    const lbl = I.findLabelEls(form, I.LABELS.amount)[0];
    return h.cls(I.fieldContainerOf(lbl));
  });
  assert.match(out, /field_/);
});

/* ---------------- typed finders: hotel form ---------------- */

test("hotel form: every typed finder resolves to the control inside its own field", async () => {
  await boot("hotel");
  const out = await inPage((I, form, h) => ({
    amount: h.key(I.resolveAmountInput(form)),
    amountPlaceholder: I.resolveAmountInput(form)?.placeholder,
    currency: h.key(I.findCombobox(form, I.LABELS.currency)),
    currencyRole: I.findCombobox(form, I.LABELS.currency)?.getAttribute("role"),
    city: h.key(I.findCombobox(form, I.LABELS.city)),
    checkin: h.key(I.findDateInput(form, I.LABELS.checkin)),
    checkinReadonly: I.findDateInput(form, I.LABELS.checkin)?.readOnly,
    checkout: h.key(I.findDateInput(form, I.LABELS.checkout)),
    distinctDates: I.findDateInput(form, I.LABELS.checkin) !== I.findDateInput(form, I.LABELS.checkout),
    receipt: h.key(I.findFileInput(form, I.LABELS.hotelReceipt)),
    attachment: h.key(I.findFileInput(form, I.LABELS.attachment)),
    distinctFiles: I.findFileInput(form, I.LABELS.hotelReceipt) !== I.findFileInput(form, I.LABELS.attachment),
    note: h.key(I.findTextInput(form, I.LABELS.note)),
    noteTag: I.findTextInput(form, I.LABELS.note)?.tagName,
    rate: h.key(I.findFieldControl(form, I.LABELS.rate)),
    converted: h.key(I.findFieldControl(form, I.LABELS.convertedAmount)),
    date: I.findDateInput(form, I.LABELS.date), // hotel has no 费用发生时间
    flightDate: I.findDateInput(form, I.LABELS.flightDate),
  }));
  assert.eq(out.amount, "amount");
  assert.eq(out.amountPlaceholder, "请输入");
  assert.eq(out.currency, "currency");
  assert.eq(out.currencyRole, "combobox");
  assert.eq(out.city, "city");
  assert.eq(out.checkin, "checkin");
  assert.eq(out.checkinReadonly, true);
  assert.eq(out.checkout, "checkout");
  assert.eq(out.distinctDates, true);
  assert.eq(out.receipt, "receipt");
  assert.eq(out.attachment, "attachment");
  assert.eq(out.distinctFiles, true);
  assert.eq(out.note, "note");
  assert.eq(out.noteTag, "TEXTAREA");
  assert.eq(out.rate, "rate");
  assert.eq(out.converted, "converted");
  assert.isNull(out.date);
  assert.isNull(out.flightDate);
});

test("amount never resolves to the 有收据 checkbox, a select2 search field, or a readonly box", async () => {
  await boot("hotel");
  const out = await inPage((I, form) => {
    const el = I.resolveAmountInput(form);
    return { type: el.type, cls: String(el.className), readonly: el.readOnly, amountLike: I.isAmountLike(el),
      checkboxLike: I.isAmountLike(form.querySelector(".kuma-checkbox")),
      searchLike: I.isAmountLike(form.querySelector(".kuma-select2-search__field")),
      rateLike: I.isAmountLike(form.querySelector('[data-key="rate"]')) };
  });
  assert.eq(out.type, "text");
  assert.eq(out.readonly, false);
  assert.ok(!/checkbox|select2/.test(out.cls));
  assert.eq(out.amountLike, true);
  assert.eq(out.checkboxLike, false);
  assert.eq(out.searchLike, false);
  assert.eq(out.rateLike, false, "readonly 汇率 box is not amount-like");
});

test("regression: 详细说明 resolves to the textarea, not the amount input two fields up", async () => {
  await boot("hotel");
  const out = await inPage((I, form, h) => h.key(I.findTextInput(form, I.LABELS.note)));
  assert.eq(out, "note");
});

/* ---------------- typed finders: other forms ---------------- */

test("meal form: 费用发生时间 resolves to the date input, not the 公司合餐人 combobox next to it", async () => {
  await boot("meal");
  const out = await inPage((I, form, h) => ({
    date: h.key(I.findDateInput(form, I.LABELS.date)),
    dateTag: I.findDateInput(form, I.LABELS.date)?.tagName,
    city: I.findCombobox(form, I.LABELS.city),
    amount: h.key(I.resolveAmountInput(form)),
    attachment: h.key(I.findFileInput(form, I.LABELS.attachment)),
    receipt: I.findFileInput(form, I.LABELS.hotelReceipt),
  }));
  assert.eq(out.date, "date");
  assert.eq(out.dateTag, "INPUT");
  assert.isNull(out.city, "meal has no city field");
  assert.eq(out.amount, "amount");
  assert.eq(out.attachment, "attachment");
  assert.isNull(out.receipt, "meal has no hotel receipt slot");
});

test("taxi form: 是否网约车 → the 是 option; flight form: 乘机日期 → its own date input", async () => {
  await boot("taxi");
  const taxi = await inPage((I, form) => {
    const opt = I.findRadioOption(form, I.LABELS.rideshare, "是");
    return { text: opt && opt.textContent.trim(), tag: opt && opt.tagName };
  });
  assert.eq(taxi.text, "是");
  await boot("flight");
  const flight = await inPage((I, form, h) => ({
    flightDate: h.key(I.findDateInput(form, I.LABELS.flightDate)),
    date: h.key(I.findDateInput(form, I.LABELS.date)),
    distinct: I.findDateInput(form, I.LABELS.flightDate) !== I.findDateInput(form, I.LABELS.date),
  }));
  assert.eq(flight.flightDate, "flightDate");
  assert.eq(flight.date, "date");
  assert.eq(flight.distinct, true);
});

/* ---------------- drawer / buttons ---------------- */

test("findCategoryForm: null when closed, null with only the picker open, the drawer body when a form is open", async () => {
  await boot();
  assert.isNull(await inPage((I) => I.findCategoryForm()));
  await page.evaluate(() => document.getElementById("addExpenseBtn").click());
  const picker = await inPage((I) => ({ form: I.findCategoryForm(), picker: !!I.findCategoryPicker() }));
  assert.isNull(picker.form);
  assert.eq(picker.picker, true);
  await page.evaluate(() => window.__fixture.openForm("hotel"));
  const out = await inPage((I, form) => ({
    found: !!form, w: form && form.getBoundingClientRect().width,
    hasSave: !!(form && form.querySelector("#saveBtn")), hasTable: !!(form && form.querySelector("table#expenseRows, #expenseRows")),
    title: I.sniffFormTitle(form),
  }));
  assert.eq(out.found, true);
  assert.ok(out.w < 700, `drawer body, not the page (w=${out.w})`);
  assert.eq(out.hasSave, true);
  assert.eq(out.hasTable, false, "form scope must not include the expense table");
  assert.eq(out.title, "差旅-住宿");
});

test("findSaveButton: '保存', never the '保存草稿' decoy nor the ▾ aux button", async () => {
  await boot("hotel");
  const out = await inPage((I, form) => I.findSaveButton(form)?.id);
  assert.eq(out, "saveBtn");
});

test("findCategoryLeaf: matches the <li title='差旅-住宿'> whose text is wrapped in a custom <icon>", async () => {
  await boot();
  await page.evaluate(() => document.getElementById("addExpenseBtn").click());
  const out = await page.evaluate(async () => {
    const I = window.__fliggyInternals;
    const leaf = await I.findCategoryLeaf("hotel");
    const meal = await I.findCategoryLeaf("meal");
    return { hotel: leaf && leaf.getAttribute("title"), meal: meal && meal.getAttribute("title"), tag: leaf && leaf.tagName };
  });
  assert.eq(out.hotel, "差旅-住宿");
  assert.eq(out.meal, "差旅-餐费");
  assert.eq(out.tag, "LI");
});

/* ---------------- setters ---------------- */

test("setDateLikeValue: opens the calendar, navigates back a month, clicks the day, input shows the ISO date", async () => {
  await boot("hotel");
  const out = await page.evaluate(async () => {
    const I = window.__fliggyInternals;
    const form = I.findCategoryForm();
    const el = I.findDateInput(form, I.LABELS.checkin);
    const ok = await I.setDateLikeValue(el, "2026-03-29");
    return { ok, value: el.value, opens: window.__fixture.calendarOpens, panelOpen: document.getElementById("calendarPanel").classList.contains("is-open") };
  });
  assert.eq(out.ok, true);
  assert.eq(out.value, "2026-03-29");
  assert.eq(out.opens, 1);
  assert.eq(out.panelOpen, false, "popup closed after selection");
});

test("setDateLikeValue: navigates forward across a year boundary", async () => {
  await boot("hotel");
  const out = await page.evaluate(async () => {
    const I = window.__fliggyInternals;
    const el = I.findDateInput(I.findCategoryForm(), I.LABELS.checkout);
    const ok = await I.setDateLikeValue(el, "2027-01-15");
    return { ok, value: el.value };
  });
  assert.eq(out.ok, true);
  assert.eq(out.value, "2027-01-15");
});

test("setComboboxValue: types into the internal search field, clicks the option, collapses; readComboboxSelected reads it back", async () => {
  await boot("hotel");
  const out = await page.evaluate(async () => {
    const I = window.__fliggyInternals;
    const form = I.findCategoryForm();
    const cur = I.findCombobox(form, I.LABELS.currency);
    const before = I.readComboboxSelected(cur);
    const ok = await I.setComboboxValue(cur, ["CNY"]);
    const after = I.readComboboxSelected(cur);
    const dropdownOpen = !!document.querySelector(".kuma-select2-dropdown");
    const searchVisible = I.isVisible(cur.querySelector(".kuma-select2-search__field"));
    return { before, ok, after, dropdownOpen, searchVisible };
  });
  assert.match(out.before, /^SGD/);
  assert.eq(out.ok, true);
  assert.match(out.after, /^CNY/);
  assert.eq(out.dropdownOpen, false, "dropdown collapsed");
  assert.eq(out.searchVisible, false, "internal search field hidden again");
});

test("setComboboxValue: half-width vs full-width paren candidates both match TAE's option text", async () => {
  await boot("hotel");
  const out = await page.evaluate(async () => {
    const I = window.__fliggyInternals;
    const cur = I.findCombobox(I.findCategoryForm(), I.LABELS.currency);
    const ok = await I.setComboboxValue(cur, ["HKD (港币)"]); // half-width; fixture has full-width ）
    return { ok, after: I.readComboboxSelected(cur) };
  });
  assert.eq(out.ok, true);
  assert.match(out.after, /^HKD/);
});

test("setInputValue: writes the amount, and a later write to the note does NOT leak into the amount (focus guard)", async () => {
  await boot("hotel");
  const out = await page.evaluate(async () => {
    const I = window.__fliggyInternals;
    const form = I.findCategoryForm();
    const amt = I.resolveAmountInput(form);
    const via1 = await I.setInputValue(amt, "684.44");
    const note = I.findTextInput(form, I.LABELS.note);
    const via2 = await I.setInputValue(note, "深圳酒店");
    return { via1, via2, amount: amt.value, note: note.value, equals: I.valueEquals(amt, "684.44") };
  });
  assert.ok(out.via1, "strategy reported: " + out.via1);
  assert.ok(out.via2, "strategy reported: " + out.via2);
  assert.eq(out.amount, "684.44");
  assert.eq(out.note, "深圳酒店");
  assert.eq(out.equals, true);
});

test("setInputValue on a non-focusable target never types into the previously focused input", async () => {
  await boot("hotel");
  const out = await page.evaluate(async () => {
    const I = window.__fliggyInternals;
    const form = I.findCategoryForm();
    const amt = I.resolveAmountInput(form);
    await I.setInputValue(amt, "100");
    // A div (like a combobox wrapper) — cannot take focus, has no value setter.
    const div = form.querySelector('[data-key="currency"] [role="combobox"]');
    const via = await I.setInputValue(div, "GARBAGE");
    return { via, amount: amt.value };
  });
  assert.eq(out.amount, "100", "amount untouched");
});

test("valueEquals: numeric tolerance and thousands separators", async () => {
  await boot("hotel");
  const out = await inPage((I, form) => {
    const el = I.resolveAmountInput(form);
    const set = (v) => { el.value = v; };
    set("684.44"); const a = I.valueEquals(el, "684.44");
    set("684.440"); const b = I.valueEquals(el, "684.44");
    set("1,234.5"); const c = I.valueEquals(el, "1234.5");
    set("684.45"); const d = I.valueEquals(el, "684.44");
    set(""); const e = I.valueEquals(el, "0");
    return [a, b, c, d, e];
  });
  assert.deepEq(out, [true, true, true, false, false]);
});
