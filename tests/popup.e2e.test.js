/*
 * Black-box tests for popup/popup.html + popup.js in real headless Chromium.
 *
 * A `chrome` stub is installed via addInitScript (before any page script):
 *   storage.local  → in-memory object (seeded per test)
 *   storage.sync   → {}
 *   tabs.query     → one TAE tab
 *   tabs.sendMessage → captured; PING/DIAG/FILL answered
 *   scripting.*    → no-op
 * pdf.js / tesseract load from lib/ as in production; parser.js is real.
 */
"use strict";

const path = require("path");
const { execSync } = require("child_process");

function loadPlaywright() {
  try { return require("playwright"); } catch {}
  return require(path.join(execSync("npm root -g").toString().trim(), "playwright"));
}

const POPUP = "file://" + path.resolve(__dirname, "../popup/popup.html");

let browser = null;
async function getBrowser() {
  if (!browser) {
    const { chromium } = loadPlaywright();
    browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-gpu"] });
  }
  return browser;
}
afterAll(async () => { if (browser) await browser.close(); });

async function bootPopup(seedRecords) {
  const b = await getBrowser();
  const ctx = await b.newContext({ viewport: { width: 420, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.addInitScript((seed) => {
    const store = { "fliggy.parsedRecords": seed };
    window.__store = store;
    window.__sent = [];
    window.chrome = {
      runtime: {
        getURL: (p) => p,
        openOptionsPage: () => { window.__optionsOpened = true; },
        onMessage: { addListener() {} },
      },
      storage: {
        local: {
          get: async (k) => (typeof k === "string" ? { [k]: store[k] } : { ...store }),
          set: async (obj) => { Object.assign(store, JSON.parse(JSON.stringify(obj))); },
        },
        sync: { get: async () => ({}) },
      },
      tabs: {
        query: async () => [{ id: 7, url: "https://tae.alibaba-inc.com/expense/pc.html#/tr/1/edit" }],
        sendMessage: async (_id, msg) => {
          window.__sent.push(JSON.parse(JSON.stringify(msg)));
          if (msg.type === "FLIGGY_PING") return { ok: true, ready: true };
          if (msg.type === "FLIGGY_FILL") return { ok: true, filled: msg.records.length, attached: 0 };
          if (msg.type === "FLIGGY_DIAG") return { ok: true, report: { echoed: msg.records.length } };
          return { ok: false };
        },
      },
      scripting: { insertCSS: async () => {}, executeScript: async () => {} },
    };
  }, seedRecords);
  await page.goto(POPUP);
  await page.waitForSelector("#parsedList", { state: "attached" });
  // The popup opens on the 上传凭证 tab; switch to 费用明细 so the rows are
  // visible/actionable, then wait for init() (async: awaits restoreParsed)
  // to have rendered exactly the seeded rows.
  await page.click("#tabParsed");
  await page.waitForFunction((n) => document.querySelectorAll("#parsedList .parsed-item").length === n, seedRecords.length);
  return { page, ctx, errors, close: () => ctx.close() };
}

const readRow = (page, i = 0) => page.evaluate((idx) => {
  const row = document.querySelectorAll("#parsedList .parsed-item")[idx];
  if (!row) return null;
  const q = (s) => row.querySelector(s);
  return {
    type: q(".type").value, date: q(".date").value, currency: q(".currency").value, amount: q(".amount").value,
    city: q(".city").value, nights: q(".nights").value, nightsHidden: q(".nights").hidden, note: q(".note").value,
    src: q(".src-name").textContent, currencyOptions: Array.from(q(".currency").options).map((o) => o.value),
  };
}, i);
const readStore = (page) => page.evaluate(() => JSON.parse(JSON.stringify(window.__store["fliggy.parsedRecords"])));
const readTotals = (page) => page.evaluate(() => ({ count: document.getElementById("totalCount").textContent, amount: document.getElementById("totalAmount").textContent, currency: document.getElementById("totalCurrency").textContent }));

// A record persisted by an old version: no city / nights / checkin / checkout.
const OLD_HOTEL = { type: "hotel", date: "2026-03-29", currency: "CNY", amount: 684.44, note: "深圳酒店", source: "深圳酒店1晚68444.png" };
const OLD_MEAL = { type: "meal", date: "2026-03-30", currency: "CNY", amount: 94, note: "太兴深圳宝安机场分店", source: "深圳机场餐饮94.PNG" };

test("popup loads without page errors and migrates old-schema records on restore", async () => {
  const { page, errors, close } = await bootPopup([OLD_HOTEL, OLD_MEAL]);
  try {
    assert.deepEq(errors, [], "no page errors");
    const row = await readRow(page, 0);
    assert.eq(row.type, "hotel");
    assert.eq(row.city, "深圳", "city backfilled from note");
    assert.eq(row.nights, "1", "nights backfilled");
    assert.eq(row.nightsHidden, false);
    assert.eq(row.amount, "684.44");
    const row2 = await readRow(page, 1);
    assert.eq(row2.type, "meal");
    assert.eq(row2.nightsHidden, true, "nights hidden on non-hotel");
    assert.eq(row2.city, "深圳", "meal city also backfilled from note");
    const store = await readStore(page);
    // restore only normalizes in memory; persistence happens on the first edit
    assert.eq(store.length, 2);
  } finally { await close(); }
});

test("currency <select> is generated from FliggyParser.CURRENCIES", async () => {
  const { page, close } = await bootPopup([OLD_HOTEL]);
  try {
    const row = await readRow(page, 0);
    assert.deepEq(row.currencyOptions, ["CNY", "USD", "EUR", "GBP", "JPY", "HKD", "SGD"]);
    assert.eq(row.currency, "CNY");
  } finally { await close(); }
});

test("totals reflect amounts by dominant currency", async () => {
  const { page, close } = await bootPopup([OLD_HOTEL, OLD_MEAL]);
  try {
    const t = await readTotals(page);
    assert.eq(t.count, "2");
    assert.eq(t.amount, "778.44");
    assert.eq(t.currency, "CNY");
  } finally { await close(); }
});

test("type toggle hotel→meal→hotel keeps the schema invariants and persists", async () => {
  const { page, close } = await bootPopup([OLD_HOTEL]);
  try {
    await page.selectOption("#parsedList .parsed-item .type", "meal");
    let store = await readStore(page);
    assert.eq(store[0].type, "meal");
    assert.isNull(store[0].nights);
    assert.isNull(store[0].checkin);
    assert.isNull(store[0].checkout);
    assert.eq((await readRow(page, 0)).nightsHidden, true);

    await page.selectOption("#parsedList .parsed-item .type", "hotel");
    store = await readStore(page);
    assert.eq(store[0].type, "hotel");
    assert.eq(store[0].nights, 1);
    assert.eq(store[0].checkin, "2026-03-29");
    assert.eq(store[0].checkout, "2026-03-30");
    const row = await readRow(page, 0);
    assert.eq(row.nights, "1");
    assert.eq(row.nightsHidden, false);
  } finally { await close(); }
});

test("editing date / nights recomputes checkout; editing amount updates totals", async () => {
  const { page, close } = await bootPopup([OLD_HOTEL]);
  try {
    await page.fill("#parsedList .parsed-item .date", "2026-04-10");
    await page.dispatchEvent("#parsedList .parsed-item .date", "change");
    let store = await readStore(page);
    assert.eq(store[0].date, "2026-04-10");
    assert.eq(store[0].checkin, "2026-04-10", "checkin follows date");
    assert.eq(store[0].checkout, "2026-04-11");

    await page.fill("#parsedList .parsed-item .nights", "3");
    await page.dispatchEvent("#parsedList .parsed-item .nights", "change");
    store = await readStore(page);
    assert.eq(store[0].nights, 3);
    assert.eq(store[0].checkout, "2026-04-13");

    await page.fill("#parsedList .parsed-item .amount", "100.5");
    await page.dispatchEvent("#parsedList .parsed-item .amount", "change");
    store = await readStore(page);
    assert.eq(store[0].amount, 100.5);
    assert.eq((await readTotals(page)).amount, "100.50");
  } finally { await close(); }
});

test("clearing city keeps it empty in state, but the fill payload backfills it from note", async () => {
  const { page, close } = await bootPopup([OLD_HOTEL]);
  try {
    await page.fill("#parsedList .parsed-item .city", "");
    await page.dispatchEvent("#parsedList .parsed-item .city", "change");
    const store = await readStore(page);
    assert.isNull(store[0].city, "explicitly cleared → null in state");
    await page.click("#importBtn");
    await page.waitForFunction(() => window.__sent.some((m) => m.type === "FLIGGY_FILL"));
    const fill = await page.evaluate(() => window.__sent.find((m) => m.type === "FLIGGY_FILL"));
    assert.eq(fill.records[0].city, "深圳", "payload city backfilled for the required field");
  } finally { await close(); }
});

test("import sends normalized records without _debug, with checkin/checkout; toast reports the result", async () => {
  const seed = [{ ...OLD_HOTEL, _debug: { textPreview: "big blob", textLength: 9999 } }, OLD_MEAL];
  const { page, close } = await bootPopup(seed);
  try {
    await page.click("#importBtn");
    await page.waitForFunction(() => window.__sent.some((m) => m.type === "FLIGGY_FILL"));
    const sent = await page.evaluate(() => window.__sent);
    assert.ok(sent.some((m) => m.type === "FLIGGY_PING"), "pinged the content script first");
    const fill = sent.find((m) => m.type === "FLIGGY_FILL");
    assert.eq(fill.records.length, 2);
    const h = fill.records[0];
    assert.eq(h.type, "hotel");
    assert.eq(h.city, "深圳");
    assert.eq(h.nights, 1);
    assert.eq(h.checkin, "2026-03-29");
    assert.eq(h.checkout, "2026-03-30");
    assert.eq("_debug" in h, false, "_debug stripped from the payload");
    assert.eq(fill.records[1].nights, null);
    assert.deepEq(fill.attachments, {}, "no File objects in this session → no attachments");
    await page.waitForFunction(() => /已写入 2 \/ 2/.test(document.getElementById("toast").textContent));
  } finally { await close(); }
});

test("diagnostics sends the same normalized payload", async () => {
  const { page, close } = await bootPopup([OLD_HOTEL]);
  try {
    await page.click("#diagBtn");
    await page.waitForFunction(() => window.__sent.some((m) => m.type === "FLIGGY_DIAG"));
    const diag = await page.evaluate(() => window.__sent.find((m) => m.type === "FLIGGY_DIAG"));
    assert.eq(diag.records.length, 1);
    assert.eq(diag.records[0].checkout, "2026-03-30");
  } finally { await close(); }
});

test("empty state when nothing is persisted; import disabled", async () => {
  const { page, close } = await bootPopup([]);
  try {
    const disabled = await page.evaluate(() => document.getElementById("importBtn").disabled);
    assert.eq(disabled, true);
    const t = await readTotals(page);
    assert.eq(t.count, "0");
  } finally { await close(); }
});
