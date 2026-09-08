/*
 * Black-box end-to-end tests for content/content.js.
 *
 * Runs the REAL content script inside REAL headless Chromium (playwright)
 * against tests/fixtures/tae-hotel-form.html — a miniature TAE page with the
 * same Kuma DOM structure and the same traps as production (table column
 * header named 金额, hidden checkbox, select2 search fields, readonly date
 * inputs with a popup calendar, two file inputs on hotel).
 *
 * Only the PUBLIC message contract is used (FLIGGY_PING / FLIGGY_FILL /
 * FLIGGY_DIAG), so these tests are insensitive to internal refactors.
 *
 * Requires playwright + its Chromium (present globally in this environment;
 * on a fresh machine: `npm i -g playwright && npx playwright install chromium`).
 */
"use strict";

const path = require("path");
const fs = require("fs");
const { execSync } = require("child_process");

function loadPlaywright() {
  try { return require("playwright"); } catch {}
  const g = execSync("npm root -g").toString().trim();
  return require(path.join(g, "playwright"));
}

const FIXTURE = "file://" + path.resolve(__dirname, "fixtures/tae-hotel-form.html");
const CONTENT_JS = fs.readFileSync(path.resolve(__dirname, "../content/content.js"), "utf8");
const CONTENT_CSS = fs.readFileSync(path.resolve(__dirname, "../content/content.css"), "utf8");

// A tiny 1×1 PNG so attachment upload has real bytes.
const PNG_1x1_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

let browser = null;
async function getBrowser() {
  if (browser) return browser;
  const { chromium } = loadPlaywright();
  browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-gpu"],
  });
  return browser;
}
afterAll(async () => { if (browser) await browser.close(); });

/**
 * Open the fixture, install a `chrome` stub that captures the content script's
 * onMessage listener, inject content.js + css, and return a page plus a
 * `send(msg)` helper that invokes the listener exactly the way Chrome would
 * (returns a Promise resolving with whatever the script passes to
 * sendResponse).
 */
async function bootPage(opts = {}) {
  const b = await getBrowser();
  const ctx = await b.newContext({ viewport: { width: 1600, height: 1000 } });
  const page = await ctx.newPage();
  const consoleLines = [];
  page.on("console", (m) => consoleLines.push(m.text()));
  page.on("pageerror", (e) => consoleLines.push("PAGEERROR " + e.message));
  await page.goto(FIXTURE);
  // chrome stub — must exist before content.js evaluates.
  await page.evaluate(() => {
    window.__fliggyListeners = [];
    window.chrome = {
      runtime: {
        onMessage: { addListener: (fn) => window.__fliggyListeners.push(fn) },
        getURL: (p) => "chrome-extension://test/" + p,
      },
    };
    window.__fliggySend = (msg) => new Promise((resolve) => {
      const fn = window.__fliggyListeners[0];
      const keepAlive = fn(msg, {}, resolve);
      if (keepAlive !== true) { /* sync response already delivered via resolve */ }
    });
  });
  await page.addStyleTag({ content: CONTENT_CSS });
  await page.addScriptTag({ content: CONTENT_JS });
  if (opts.openForm) await page.evaluate((t) => window.__fixture.openForm(t), opts.openForm);
  const send = (msg, timeout = 60000) =>
    page.evaluate(([m]) => window.__fliggySend(m), [msg]).then((r) => r); // playwright waits for the promise
  return { page, ctx, send, consoleLines, close: () => ctx.close() };
}

const hotelRecord = {
  type: "hotel", date: "2026-03-29", currency: "CNY", amount: 684.44,
  note: "深圳酒店", city: "深圳", nights: 1, checkin: "2026-03-29", checkout: "2026-03-30",
  source: "深圳酒店1晚684.44.png",
};
const mealRecord = {
  type: "meal", date: "2026-03-30", currency: "CNY", amount: 94,
  note: "太兴深圳宝安机场分店", city: "深圳", nights: null, checkin: null, checkout: null,
  source: "深圳机场餐饮94.PNG",
};
const attachments = {
  [hotelRecord.source]: { data: PNG_1x1_B64, mime: "image/png", size: 68 },
  [mealRecord.source]: { data: PNG_1x1_B64, mime: "image/png", size: 68 },
};

/* ======================= PING ======================= */

test("FLIGGY_PING responds ready with url + top flag", async () => {
  const { send, close } = await bootPage();
  try {
    const r = await send({ type: "FLIGGY_PING" });
    assert.ok(r && r.ok, "ok");
    assert.ok(r.ready, "ready");
    assert.match(r.url, /tae-hotel-form\.html$/);
    assert.eq(r.top, true);
  } finally { await close(); }
});

/* ======================= DIAG ======================= */

test("FLIGGY_DIAG with hotel form open: locates form + resolves amount/currency to the right inputs", async () => {
  const { send, close } = await bootPage({ openForm: "hotel" });
  try {
    const r = await send({ type: "FLIGGY_DIAG", records: [hotelRecord] });
    assert.ok(r.ok, "diag ok");
    const rep = r.report;
    assert.ok(rep.addButton && /新增费用/.test(rep.addButton.text), "add button found");
    assert.ok(rep.categoryForm, "category form found via 保存 anchor");
    assert.ok(rep.categoryForm.rect.w < 700, `form scope should be the drawer, not the page (w=${rep.categoryForm.rect.w})`);
    // pendingRecords carries the payload end-to-end
    assert.eq(rep.pendingRecords.length, 1);
    assert.close(rep.pendingRecords[0].amount, 684.44);
    // amount must resolve to the kuma-input text field — never the checkbox,
    // a select2 search field, or a readonly 汇率 box.
    const res = rep.formProbes && rep.formProbes.amount;
    assert.ok(res, "amount resolved");
    assert.eq(res.tag, "input");
    assert.eq(res.type, "text");
    assert.eq(res.placeholder, "请输入");
    assert.eq(res.readonly, false);
    assert.ok(!/select2-search|kuma-checkbox/.test(res.cls), "not a search field / checkbox: " + res.cls);
    // the deep probe agrees, and shows the trap: the raw text match also hits
    // the field container (its only text is "金额"), but only the innermost
    // label survives.
    const dp = rep.amountDeepProbe;
    assert.ok(dp && dp.resolved, "deep probe resolved");
    assert.eq(dp.resolved.placeholder, "请输入");
    assert.ok(dp.rawTextMatches >= 2, `raw text matches should include the container (got ${dp.rawTextMatches})`);
    assert.eq(dp.innermostVisibleMatches, 1, "exactly one innermost 金额 label");
    // other probes
    assert.eq(rep.formProbes.currency.role, "combobox");
    assert.eq(rep.formProbes.city.role, "combobox");
    assert.eq(rep.formProbes.checkin.readonly, true, "checkin is the readonly calendar input");
    assert.eq(rep.formProbes.checkout.readonly, true);
    assert.eq(rep.formProbes.note.tag, "textarea");
    assert.eq(rep.formProbes.hotelReceipt.type, "file");
    assert.eq(rep.formProbes.attachment.type, "file");
    assert.eq(rep.formTitle, "差旅-住宿");
    assert.ok(rep.lastFillSummary === null, "no fill has run yet");
  } finally { await close(); }
});

test("FLIGGY_DIAG with nothing open: reports no form, no picker", async () => {
  const { send, close } = await bootPage();
  try {
    const r = await send({ type: "FLIGGY_DIAG", records: [] });
    assert.ok(r.ok);
    assert.isNull(r.report.categoryForm);
    assert.eq(r.report.categoryPicker, false);
  } finally { await close(); }
});

/* ======================= FILL — the real thing ======================= */

// Read the fixture's captured state after a fill.
const readFixture = (page) => page.evaluate(() => ({
  state: window.__fixture.state,
  saved: window.__fixture.saved,
  rejected: window.__fixture.rejected,
  calendarOpens: window.__fixture.calendarOpens,
  draftClicks: window.__fixture.draftClicks,
  rows: Array.from(document.querySelectorAll("#expenseRows tr")).map((tr) => tr.textContent.replace(/\s+/g, " ").trim()),
}));

// Run assertions; on the first failure dump the content script's console and
// the fixture's rejected-save log so the failure is diagnosable from CI output.
function expectOrDump(consoleLines, fx, r, fn) {
  try { fn(); } catch (e) {
    console.log("      --- response ---", JSON.stringify(r));
    console.log("      --- content.js console (last 60) ---");
    consoleLines.slice(-60).forEach((l) => console.log("      " + l.replace(/^%c\[FliggyClaim\] color:[^ ]+ /, "[FC] ").replace(/\s+/g, " ").slice(0, 220)));
    console.log("      --- fixture rejected ---", JSON.stringify(fx.rejected, null, 1));
    console.log("      --- fixture saved ---", JSON.stringify(fx.saved, null, 1));
    throw e;
  }
}

test("FLIGGY_FILL: hotel + meal records are fully filled and saved (all required fields, both attachment slots)", async () => {
  const { page, send, consoleLines, close } = await bootPage();
  try {
    const r = await send({ type: "FLIGGY_FILL", records: [hotelRecord, mealRecord], attachments });
    const fx = await readFixture(page);
    expectOrDump(consoleLines, fx, r, () => {
    assert.ok(r && r.ok, "fill responded ok: " + JSON.stringify(r));
    assert.eq(r.filled, 2, "both records filled");
    assert.eq(r.attached, 2, "both records attached");
    assert.deepEq(fx.rejected, [], "no save was rejected for missing required fields");
    assert.eq(fx.saved.length, 2, "two saves captured");
    assert.eq(fx.state, "closed", "drawer closed after last save");

    const h = fx.saved[0];
    assert.eq(h.type, "hotel");
    assert.eq(h.amount, "684.44", "hotel amount written into the kuma-input");
    assert.match(h.currency, /^CNY/, "hotel currency switched from SGD default to CNY");
    assert.eq(h.city, "深圳");
    assert.eq(h.checkin, "2026-03-29", "checkin set via calendar popup");
    assert.eq(h.checkout, "2026-03-30", "checkout = checkin + nights");
    assert.eq(h.receiptFiles, 1, "酒店住宿相关凭证 slot got the file");
    assert.eq(h.attachmentFiles, 1, "附件 slot also got the file (so 📎 shows)");
    assert.eq(h.note, "深圳酒店");
    assert.eq(h.guest, "Zhou, Xiaochen", "pre-filled 住宿人 untouched");

    const m = fx.saved[1];
    assert.eq(m.type, "meal");
    assert.eq(m.amount, "94");
    assert.match(m.currency, /^CNY/);
    assert.eq(m.date, "2026-03-30", "meal 费用发生时间 set");
    assert.eq(m.attachmentFiles, 1);
    assert.eq(m.note, "太兴深圳宝安机场分店");

    assert.ok(fx.calendarOpens >= 3, `calendar opened for checkin, checkout, meal date (got ${fx.calendarOpens})`);
    assert.eq(fx.draftClicks, 0, "保存草稿 decoy never clicked");
    assert.eq(fx.rows.length, 3, "table has original row + 2 new rows");
    assert.match(fx.rows[1], /684\.44 CNY/);
    assert.match(fx.rows[2], /94\.00 CNY/);
    assert.ok(!consoleLines.some((l) => /PAGEERROR|Illegal invocation/.test(l)), "no uncaught page errors");
    });
  } finally { await close(); }
});

test("FLIGGY_FILL: taxi sets 是否网约车=是, flight sets 乘机日期★, train is minimal", async () => {
  const { page, send, consoleLines, close } = await bootPage();
  try {
    const taxi = { type: "taxi", date: "2026-04-01", currency: "CNY", amount: 45.5, note: "深圳打车", city: "深圳", source: "taxi.png" };
    const flight = { type: "flight", date: "2026-04-02", currency: "CNY", amount: 1200, note: "PEK-PVG", city: null, source: "flight.png" };
    const train = { type: "train", date: "2026-04-03", currency: "CNY", amount: 553, note: "北京-上海", city: "北京", source: "train.png" };
    const r = await send({ type: "FLIGGY_FILL", records: [taxi, flight, train], attachments: {} });
    const fx = await readFixture(page);
    expectOrDump(consoleLines, fx, r, () => {
      assert.ok(r.ok, JSON.stringify(r));
      assert.eq(r.filled, 3);
      assert.deepEq(fx.rejected, []);
      assert.eq(fx.saved[0].type, "taxi");
      assert.eq(fx.saved[0].rideshare, "是");
      assert.eq(fx.saved[0].amount, "45.5");
      assert.eq(fx.saved[0].date, "2026-04-01");
      assert.eq(fx.saved[1].type, "flight");
      assert.eq(fx.saved[1].flightDate, "2026-04-02", "乘机日期★ filled");
      assert.eq(fx.saved[1].amount, "1200");
      assert.eq(fx.saved[2].type, "train");
      assert.eq(fx.saved[2].amount, "553");
      assert.match(fx.saved[2].currency, /^CNY/);
      assert.eq(fx.saved[2].note, "北京-上海");
    });
  } finally { await close(); }
});

test("FLIGGY_FILL: a record with amount 0 is rejected by the form; the next record still succeeds", async () => {
  const { page, send, consoleLines, close } = await bootPage();
  try {
    const bad = { ...mealRecord, amount: 0, source: "bad.png" };
    const r = await send({ type: "FLIGGY_FILL", records: [bad, mealRecord], attachments: {} }, 90000);
    const fx = await readFixture(page);
    expectOrDump(consoleLines, fx, r, () => {
      assert.ok(r.ok, "overall ok because one succeeded");
      assert.eq(r.filled, 1);
      assert.eq(fx.saved.length, 1);
      assert.eq(fx.saved[0].amount, "94");
      assert.ok(fx.rejected.length >= 1, "the 0-amount save was rejected by the form");
      assert.ok(fx.rejected[0].missing.some((m) => /amount/.test(m)), "rejected for amount: " + fx.rejected[0].missing);
      assert.eq(fx.state, "closed", "the failed drawer was cancelled so the next record could proceed");
    });
  } finally { await close(); }
});

test("FLIGGY_FILL: currency switch survives — SGD default becomes the record's currency on every form", async () => {
  const { page, send, consoleLines, close } = await bootPage();
  try {
    const usd = { ...mealRecord, currency: "USD", amount: 12.5, source: "usd.png" };
    const hkd = { ...mealRecord, currency: "HKD", amount: 88, source: "hkd.png" };
    const r = await send({ type: "FLIGGY_FILL", records: [usd, hkd], attachments: {} });
    const fx = await readFixture(page);
    expectOrDump(consoleLines, fx, r, () => {
      assert.eq(r.filled, 2);
      assert.match(fx.saved[0].currency, /^USD/);
      assert.eq(fx.saved[0].amount, "12.5");
      assert.match(fx.saved[1].currency, /^HKD/);
      assert.eq(fx.saved[1].amount, "88");
    });
  } finally { await close(); }
});

test("FLIGGY_FILL: empty record list → error response (0 条写入成功)", async () => {
  const { send, close } = await bootPage();
  try {
    const r = await send({ type: "FLIGGY_FILL", records: [], attachments: {} });
    assert.eq(r.ok, false);
    assert.match(r.error, /0 条/);
  } finally { await close(); }
});
