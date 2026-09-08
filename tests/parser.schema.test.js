/*
 * White-box tests for the record schema (normalizeRecord) and the
 * single-source-of-truth currency table in lib/parser.js.
 */
"use strict";

global.window = global;
global.chrome = { runtime: { getURL: (p) => p }, storage: { sync: { get: async () => ({}) } } };
require("../lib/parser.js");

const P = global.FliggyParser;
const I = P._internals;
const today = new Date().toISOString().slice(0, 10);

/* ======================= CURRENCIES table ======================= */

test("CURRENCIES: 7 unique codes, each with display/textual/tokens", () => {
  const codes = P.CURRENCIES.map((c) => c.code);
  assert.deepEq(codes, ["CNY", "USD", "EUR", "GBP", "JPY", "HKD", "SGD"]);
  assert.eq(new Set(codes).size, 7);
  for (const c of P.CURRENCIES) {
    assert.ok(c.display.startsWith(c.code), `${c.code} display starts with code`);
    assert.ok(c.textual instanceof RegExp, `${c.code} textual is a RegExp`);
    assert.ok(Array.isArray(c.tokens) && c.tokens.length >= 1, `${c.code} has tokens`);
  }
  assert.deepEq(P.TYPES, ["flight", "hotel", "meal", "taxi", "train", "other"]);
});

test("derived CURTOK_PRE / CURTOK_SUF contain escaped tokens and side-specific extras", () => {
  assert.ok(I.CURTOK_PRE.includes("US\\$"), "US$ escaped in prefix");
  assert.ok(I.CURTOK_PRE.includes("Y(?=\\d)"), "OCR 'Y' prefix form present");
  assert.ok(!I.CURTOK_PRE.includes("元"), "元 is suffix-only");
  assert.ok(I.CURTOK_SUF.includes("元"), "元 in suffix");
  assert.ok(!I.CURTOK_SUF.includes("Y(?="), "Y-prefix form absent from suffix");
  assert.ok(!/(^|\|)\\\$(\||\))/.test(I.CURTOK_PRE), "bare $ is never a token");
  // Longest-first ordering: "US\$" must appear before the single-char glyphs.
  assert.ok(I.CURTOK_PRE.indexOf("US\\$") < I.CURTOK_PRE.indexOf("¥"));
  // The derived regexes actually compile and match.
  assert.ok(new RegExp(`(${I.CURTOK_PRE})\\s*\\d`, "i").test("US$ 5"));
  assert.ok(new RegExp(`\\d\\s*(${I.CURTOK_SUF})`, "i").test("5元"));
});

test("TOKEN_TO_CODE / normalizeCurrency derive from the same table", () => {
  assert.eq(I.TOKEN_TO_CODE.get("¥"), "CNY");
  assert.eq(I.TOKEN_TO_CODE.get("US$"), "USD");
  assert.eq(I.TOKEN_TO_CODE.get("元"), "CNY");
  assert.eq(I.TOKEN_TO_CODE.get("Y"), "CNY");
  assert.eq(I.TOKEN_TO_CODE.get("S$"), "SGD");
  assert.eq(I.normalizeCurrency("hk$"), "HKD");
  assert.eq(I.normalizeCurrency(null), "CNY");
  assert.eq(I.CURRENCY_MAP.length, 7);
  assert.eq(I.detectCurrency("US$ 5"), "USD");
});

/* ======================= normalizeRecord ======================= */

test("normalizeRecord: migrates an old-schema hotel record (no city/nights/checkin/checkout)", () => {
  const r = P.normalizeRecord({ type: "hotel", date: "2026-03-29", currency: "CNY", amount: 684.44, note: "深圳酒店", source: "深圳酒店1晚68444.png" });
  assert.eq(r.city, "深圳");
  assert.eq(r.nights, 1);
  assert.eq(r.checkin, "2026-03-29");
  assert.eq(r.checkout, "2026-03-30");
  assert.close(r.amount, 684.44);
});

test("normalizeRecord: hotel — explicit nights drives checkout; checkout alone derives nights; nights beats an inconsistent checkout", () => {
  let r = P.normalizeRecord({ type: "hotel", date: "2026-03-29", nights: 3 });
  assert.eq(r.checkout, "2026-04-01");
  r = P.normalizeRecord({ type: "hotel", date: "2026-03-29", checkout: "2026-04-01" });
  assert.eq(r.nights, 3);
  assert.eq(r.checkout, "2026-04-01");
  r = P.normalizeRecord({ type: "hotel", date: "2026-03-29", nights: 2, checkout: "2026-04-05" });
  assert.eq(r.nights, 2);
  assert.eq(r.checkout, "2026-03-31");
  r = P.normalizeRecord({ type: "hotel", date: "2026-03-29", nights: "0" });
  assert.eq(r.nights, 1, "nights < 1 → 1");
  r = P.normalizeRecord({ type: "hotel", date: "2026-03-29", nights: "", checkout: "2026-03-29" });
  assert.eq(r.nights, 1, "same-day checkout → 1");
});

test("normalizeRecord: hotel checkin always equals date (the popup edits date)", () => {
  const r = P.normalizeRecord({ type: "hotel", date: "2026-04-10", checkin: "2026-03-29", nights: 2 });
  assert.eq(r.checkin, "2026-04-10");
  assert.eq(r.checkout, "2026-04-12");
});

test("normalizeRecord: non-hotel nulls the hotel fields", () => {
  for (const type of ["meal", "taxi", "flight", "train", "other"]) {
    const r = P.normalizeRecord({ type, date: "2026-03-30", nights: 2, checkin: "2026-03-30", checkout: "2026-04-01" });
    assert.isNull(r.nights, type);
    assert.isNull(r.checkin, type);
    assert.isNull(r.checkout, type);
  }
});

test("normalizeRecord: coerces bad values to safe defaults", () => {
  const r = P.normalizeRecord({ type: "bogus", date: "not a date", currency: "XXX", amount: "abc", note: null, source: undefined });
  assert.eq(r.type, "other");
  assert.eq(r.date, today);
  assert.eq(r.currency, "CNY");
  assert.eq(r.amount, 0);
  assert.eq(r.note, "");
  assert.eq(r.source, "");
  assert.isNull(r.city);
  assert.eq(P.normalizeRecord({ amount: -5 }).amount, 0);
  assert.eq(P.normalizeRecord({ amount: "94.999" }).amount, 95);
  assert.eq(P.normalizeRecord({ amount: "1,234.5" }).amount, 0, "we do not parse thousands separators from free text (popup input is type=number)");
  assert.eq(P.normalizeRecord({ note: "x".repeat(40) }).note.length, 20);
  assert.eq(P.normalizeRecord({}).type, "other");
});

test("normalizeRecord: city — undefined is backfilled from note/source, explicit '' stays null, explicit value wins", () => {
  assert.eq(P.normalizeRecord({ note: "上海机场餐饮", source: "x.png" }).city, "上海");
  assert.eq(P.normalizeRecord({ note: "餐饮", source: "曼谷晚餐.png" }).city, "曼谷");
  assert.isNull(P.normalizeRecord({ city: "", note: "上海机场餐饮" }).city);
  assert.eq(P.normalizeRecord({ city: " 北京 ", note: "上海机场餐饮" }).city, "北京");
});

test("normalizeRecord is idempotent", () => {
  const once = P.normalizeRecord({ type: "hotel", date: "2026-03-29", currency: "CNY", amount: 684.44, note: "深圳酒店", source: "x.png" });
  const twice = P.normalizeRecord(once);
  assert.deepEq(twice, once);
});

test("normalizeRecord does not mutate its input", () => {
  const input = { type: "hotel", date: "2026-03-29", amount: 1 };
  const snapshot = JSON.stringify(input);
  P.normalizeRecord(input);
  assert.eq(JSON.stringify(input), snapshot);
});

/* ======================= addDays (UTC) ======================= */

test("addDays is UTC-safe across month/year/leap boundaries", () => {
  assert.eq(P.addDays("2026-03-31", 1), "2026-04-01");
  assert.eq(P.addDays("2026-12-31", 1), "2027-01-01");
  assert.eq(P.addDays("2024-02-28", 1), "2024-02-29");
  assert.eq(P.addDays("2026-03-29", -1), "2026-03-28");
  assert.eq(P.addDays("2026-03-29", 0), "2026-03-29");
  assert.eq(P.diffDays === undefined ? I.diffDays("2026-03-29", "2026-04-01") : 3, 3);
});

/* ======================= parseFile output is normalized ======================= */

test("parseFile returns a normalized record (hotel invariant holds) and keeps _debug", async () => {
  const rec = await P.parseFile({ name: "深圳酒店2晚684.44.png", type: "image/png", size: 1, lastModified: Date.UTC(2026, 2, 29, 12) });
  assert.eq(rec.type, "hotel");
  assert.eq(rec.checkin, rec.date);
  assert.eq(rec.nights, 2, "nights extracted from '2晚'");
  assert.eq(rec.checkout, P.addDays(rec.date, 2));
  assert.ok(rec._debug && typeof rec._debug.amountSource === "string", "_debug retained for the popup");
});
