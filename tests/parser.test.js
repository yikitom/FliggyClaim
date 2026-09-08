/*
 * White-box tests for lib/parser.js heuristics.
 *
 * These load parser.js into Node with a stub `window`/`chrome`, then exercise
 * the pure internals exposed via FliggyParser._internals. They double as the
 * SPEC for the extraction rules — if a rule changes intentionally, update the
 * expectation here, otherwise a red test is a regression.
 */
"use strict";

// ---- load parser.js with the minimum globals it touches at module scope ----
global.window = global;
global.chrome = {
  runtime: { getURL: (p) => `chrome-extension://test/${p}` },
  storage: { sync: { get: async () => ({}) } },
};
// Tesseract / pdfjsLib deliberately undefined → OCR + PDF paths are skipped.
require("../lib/parser.js");

const P = global.FliggyParser;
const I = P._internals;

test("module exports parseFile / fallbackRecord / terminateOcr / _internals", () => {
  assert.eq(typeof P.parseFile, "function");
  assert.eq(typeof P.fallbackRecord, "function");
  assert.eq(typeof P.terminateOcr, "function");
  assert.ok(I && typeof I.detectAmount === "function", "_internals hook present");
});

/* ======================= currency ======================= */

test("detectCurrency: CNY default — no textual marker returns null", () => {
  assert.isNull(I.detectCurrency("上海机场餐饮52.JPG"));
  assert.isNull(I.detectCurrency("深圳酒店1晚684.44"));
  assert.isNull(I.detectCurrency(""));
});

test("detectCurrency: bare glyphs are NOT evidence (OCR ¥↔£ misreads)", () => {
  assert.isNull(I.detectCurrency("£35.00"), "£ alone");
  assert.isNull(I.detectCurrency("€ 12"), "€ alone");
  assert.isNull(I.detectCurrency("$ 99"), "$ alone");
  assert.isNull(I.detectCurrency("¥ 30"), "¥ alone");
});

test("detectCurrency: ISO codes + Chinese names + 2-char prefixes ARE evidence", () => {
  assert.eq(I.detectCurrency("USD 94"), "USD");
  assert.eq(I.detectCurrency("US$ 94"), "USD");
  assert.eq(I.detectCurrency("美元 94"), "USD");
  assert.eq(I.detectCurrency("英镑 35"), "GBP");
  assert.eq(I.detectCurrency("GBP 35"), "GBP");
  assert.eq(I.detectCurrency("HK$ 120"), "HKD");
  assert.eq(I.detectCurrency("港元"), "HKD");
  assert.eq(I.detectCurrency("新加坡元"), "SGD");
  assert.eq(I.detectCurrency("欧元"), "EUR");
  assert.eq(I.detectCurrency("日元"), "JPY");
  assert.eq(I.detectCurrency("人民币"), "CNY");
  assert.eq(I.detectCurrency("RMB 30"), "CNY");
  assert.eq(I.detectCurrency("cny 30"), "CNY", "case-insensitive");
});

test("detectCurrency: word boundaries — 'USDX' or 'BCNY' do not match", () => {
  assert.isNull(I.detectCurrency("USDX"));
  assert.isNull(I.detectCurrency("xCNYx"));
});

test("normalizeCurrency: glyph → code (used only when a glyph sits next to a number)", () => {
  assert.eq(I.normalizeCurrency("¥"), "CNY");
  assert.eq(I.normalizeCurrency("￥"), "CNY");
  assert.eq(I.normalizeCurrency("元"), "CNY");
  assert.eq(I.normalizeCurrency("Y"), "CNY");
  assert.eq(I.normalizeCurrency("RMB"), "CNY");
  assert.eq(I.normalizeCurrency("US$"), "USD");
  assert.eq(I.normalizeCurrency("usd"), "USD");
  assert.eq(I.normalizeCurrency("£"), "GBP");
  assert.eq(I.normalizeCurrency("€"), "EUR");
  assert.eq(I.normalizeCurrency("HK$"), "HKD");
  assert.eq(I.normalizeCurrency("S$"), "SGD");
  assert.eq(I.normalizeCurrency("JPY"), "JPY");
  assert.eq(I.normalizeCurrency("???"), "CNY", "unknown → CNY");
});

/* ======================= amount ======================= */

test("detectAmount: currency-prefix '¥35.00' → 35 CNY", () => {
  const r = I.detectAmount("¥35.00", "");
  assert.close(r.value, 35);
  assert.eq(r.currency, "CNY");
  assert.eq(r.why, "currency-prefix");
});

test("detectAmount: currency-suffix '684.44 CNY' and '85.2元'", () => {
  let r = I.detectAmount("总价 684.44 CNY", "");
  assert.close(r.value, 684.44);
  assert.eq(r.currency, "CNY");
  r = I.detectAmount("车费 85.2元", "");
  assert.close(r.value, 85.2);
  assert.eq(r.currency, "CNY");
});

test("detectAmount: suffix token must not be part of a longer word (元宝)", () => {
  const r = I.detectAmount("获得 100元宝", "");
  // "100元" would be a suffix match but 元宝 is a word; the NOT_LETTER guard
  // rejects it, leaving no currency-tagged candidate.
  assert.ok(!r || r.why !== "currency-suffix", "元宝 should not register as a 元 suffix");
});

test("detectAmount: total keyword picks the LARGEST number in its window", () => {
  // Tabular receipt row: "合计  7.00  526.00" — 7 is item count, 526 is total.
  const r = I.detectAmount("合计 7.00 526.00", "");
  assert.close(r.value, 526);
  assert.eq(r.why, "total-keyword");
});

test("detectAmount: total keyword beats a bare decimal elsewhere", () => {
  const r = I.detectAmount("单价 12.50\n价税合计 ¥ 684.44", "");
  assert.close(r.value, 684.44);
  assert.eq(r.why, "total-keyword");
  assert.eq(r.currency, "CNY");
});

test("detectAmount: OCR whitespace inside Chinese keywords is tolerated ('合 计')", () => {
  const r = I.detectAmount("合 计  333.00", "");
  assert.close(r.value, 333);
  assert.eq(r.why, "total-keyword");
});

test("detectAmount: negative numbers are discounts, not totals", () => {
  const r = I.detectAmount("优惠 -50.00", "");
  assert.ok(!r || r.value !== 50, "−50 must not be picked");
});

test("detectAmount: bare-decimal fallback when no label and no glyph", () => {
  const r = I.detectAmount("Latte 42.00", "");
  assert.close(r.value, 42);
  assert.eq(r.why, "bare-decimal");
  assert.eq(r.currency, "CNY");
});

test("detectAmount: filename fallback '深圳酒店1晚684.44.png' → 684.44", () => {
  const r = I.detectAmount("深圳酒店1晚684.44.png\n", "深圳酒店1晚684.44.png");
  assert.close(r.value, 684.44);
  assert.eq(r.currency, "CNY");
  assert.oneOf(r.why, ["bare-decimal", "filename"]);
});

test("detectAmount: filename fallback ignores dates / years (no fragment leaks)", () => {
  assert.isNull(I.detectAmount("", "餐饮2026-03-30.jpg"), "2026-03-30 → no candidate at all");
  assert.isNull(I.detectAmount("", "IMG_20260330.jpg"), "YYYYMMDD → none");
  assert.isNull(I.detectAmount("", "票据2026年3月30日.png"), "年月日 → none");
  assert.isNull(I.detectAmount("", "2026.png"), "bare year → none");
  // But a real amount next to a date still survives.
  const r = I.detectAmount("", "餐饮2026-03-30_94.5.jpg");
  assert.close(r.value, 94.5);
});

test("looksLikeDate: overlap semantics", () => {
  const stem = "餐饮2026-03-30";
  assert.ok(I.looksLikeDate("30", stem, stem.length - 2), "trailing DD overlaps the date span");
  assert.ok(I.looksLikeDate("03", stem, stem.indexOf("03")), "MM overlaps");
  assert.ok(I.looksLikeDate("2026", stem, 2), "year");
  assert.ok(!I.looksLikeDate("94", "餐饮94", 2), "plain number is not a date");
});

test("detectAmount: implausible values are rejected (>1,000,000, ≤0)", () => {
  assert.ok(I.isPlausibleAmount(684.44));
  assert.ok(!I.isPlausibleAmount(0));
  assert.ok(!I.isPlausibleAmount(-5));
  assert.ok(!I.isPlausibleAmount(1_000_001));
  assert.ok(!I.isPlausibleAmount(NaN));
});

test("detectAmount: returns null when nothing looks like money", () => {
  assert.isNull(I.detectAmount("no numbers here", ""));
  assert.isNull(I.detectAmount("", ""));
});

/* ======================= runHeuristics — currency confidence guard ======================= */

test("runHeuristics: 'USD 94' keeps USD (glyph-less code is textual evidence)", () => {
  const h = I.runHeuristics("USD 94", "x.png");
  assert.close(h.amount, 94);
  assert.eq(h.currency, "USD");
});

test("runHeuristics: '£35.00' alone falls back to CNY — glyph without textual marker", () => {
  const h = I.runHeuristics("£35.00", "x.png");
  assert.close(h.amount, 35);
  assert.eq(h.currency, "CNY", "confidence guard must override the £ glyph");
});

test("runHeuristics: '£35.00 GBP' keeps GBP — glyph corroborated by code", () => {
  const h = I.runHeuristics("£35.00 GBP", "x.png");
  assert.eq(h.currency, "GBP");
});

test("runHeuristics: a stray '£' in OCR noise does not flip a CNY receipt", () => {
  const h = I.runHeuristics("深圳酒店 £\n价税合计 684.44", "深圳酒店.png");
  assert.close(h.amount, 684.44);
  assert.eq(h.currency, "CNY");
});

/* ======================= type ======================= */

test("detectType: hotel / meal / taxi / flight / train / null", () => {
  assert.eq(I.detectType("深圳酒店1晚"), "hotel");
  assert.eq(I.detectType("上海机场餐饮52"), "meal");
  assert.eq(I.detectType("滴滴出行 行程单"), "taxi");
  assert.eq(I.detectType("国航 电子客票 PEK-PVG"), "flight");
  assert.eq(I.detectType("高铁 G1234 北京-上海"), "train");
  assert.eq(I.detectType("12306 车次 D305"), "train");
  assert.isNull(I.detectType("nothing recognizable"));
});

test("detectType: score-based — more keyword hits wins", () => {
  // "hotel" appears once, but "餐厅 lunch dinner" gives meal 3 hits.
  assert.eq(I.detectType("hotel 餐厅 lunch dinner"), "meal");
});

test("guessTypeFromFilename mirrors detectType on the filename alone", () => {
  assert.eq(I.guessTypeFromFilename("深圳酒店1晚68444.png"), "hotel");
  assert.eq(I.guessTypeFromFilename("高铁北京-上海.pdf"), "train");
  assert.isNull(I.guessTypeFromFilename("IMG_0001.jpg"));
});

/* ======================= date ======================= */

test("detectDate: ISO, slash, dot, 年月日, and DD/MM/YYYY", () => {
  assert.eq(I.detectDate("2026-03-29"), "2026-03-29");
  assert.eq(I.detectDate("2026/3/29"), "2026-03-29");
  assert.eq(I.detectDate("2026.03.29"), "2026-03-29");
  assert.eq(I.detectDate("2026年3月29日"), "2026-03-29");
  assert.eq(I.detectDate("29/03/2026"), "2026-03-29");
});

test("detectDate: rejects impossible months/days", () => {
  assert.isNull(I.detectDate("2026/13/01"));
  assert.isNull(I.detectDate("2026-00-10"));
  assert.isNull(I.detectDate("no date"));
});

test("addDays: rolls over month/year; passes through falsy/invalid", () => {
  assert.eq(I.addDays("2026-03-29", 1), "2026-03-30");
  assert.eq(I.addDays("2026-03-31", 1), "2026-04-01");
  assert.eq(I.addDays("2026-12-31", 1), "2027-01-01");
  assert.eq(I.addDays("2026-03-29", 3), "2026-04-01");
  assert.eq(I.addDays("2026-03-29", 0), "2026-03-29");
  assert.isNull(I.addDays(null, 1));
  assert.eq(I.addDays("not-a-date", 1), "not-a-date");
});

/* ======================= city / nights / merchant / route ======================= */

test("extractCity: first matching city, mainland + APAC + EU/US hubs", () => {
  assert.eq(I.extractCity("深圳酒店1晚"), "深圳");
  assert.eq(I.extractCity("上海机场餐饮"), "上海");
  assert.eq(I.extractCity("曼谷 Grand Hyatt"), "曼谷");
  assert.eq(I.extractCity("Singapore 新加坡"), "新加坡");
  assert.eq(I.extractCity("伦敦"), "伦敦");
  assert.isNull(I.extractCity("no city"));
  assert.isNull(I.extractCity(""));
  assert.isNull(I.extractCity(null));
});

test("extractNights: '1晚' / '2 nights' / '三晚' / none", () => {
  assert.eq(I.extractNights("深圳酒店1晚684.44"), 1, "digit after 晚");
  assert.eq(I.extractNights("深圳酒店1晚"), 1, "end of string after 晚 (CJK is not \\w — must not rely on \\b)");
  assert.eq(I.extractNights("酒店2晚.png"), 2, "punctuation after 晚");
  assert.eq(I.extractNights("2 nights stay"), 2);
  assert.isNull(I.extractNights("2nightsXYZ"), "ASCII form still needs a word edge");
  assert.eq(I.extractNights("3 night"), 3);
  assert.eq(I.extractNights("三晚"), 3);
  assert.eq(I.extractNights("十晚"), 10);
  assert.isNull(I.extractNights("no nights"));
});

test("extractMerchant: 'XX酒店' / 'XX餐厅' / 'XX店'", () => {
  assert.eq(I.extractMerchant("欢迎光临 深圳万豪酒店"), "深圳万豪酒店");
  assert.eq(I.extractMerchant("太兴深圳宝安机场分店 收据"), "太兴深圳宝安机场分店");
  assert.isNull(I.extractMerchant("no merchant"));
});

test("extractRoute: IATA and Chinese city pairs", () => {
  assert.eq(I.extractRoute("PEK-PVG"), "PEK-PVG");
  assert.eq(I.extractRoute("北京 → 上海"), "北京-上海");
  assert.isNull(I.extractRoute("no route"));
});

/* ======================= buildNote ======================= */

test("buildNote: type-driven ≤20-char summary", () => {
  assert.eq(I.buildNote("hotel", "深圳万豪酒店 1晚", "x.png", 684.44, "CNY"), "深圳万豪酒店");
  assert.eq(I.buildNote("meal", "太兴深圳宝安机场分店", "x.png", 94, "CNY"), "太兴深圳宝安机场分店");
  assert.eq(I.buildNote("meal", "no merchant", "x.png", 94, "CNY"), "餐饮");
  assert.eq(I.buildNote("taxi", "深圳 打车", "x.png", 30, "CNY"), "深圳打车");
  assert.eq(I.buildNote("taxi", "打车", "x.png", 30, "CNY"), "市内打车");
  assert.eq(I.buildNote("flight", "PEK-PVG", "x.png", 1000, "CNY"), "PEK-PVG");
  assert.ok(I.buildNote("other", "x", "a-very-long-file-name-that-exceeds-limits.png", 1, "CNY").length <= 20);
});

/* ======================= fallbackRecord ======================= */

test("fallbackRecord: hotel carries nights/checkin/checkout; others null them", () => {
  const f = (name) => ({ name, size: 1, lastModified: Date.UTC(2026, 2, 29), type: "image/png" });
  const h = P.fallbackRecord(f("深圳酒店1晚684.44.png"), null);
  assert.eq(h.type, "hotel");
  assert.eq(h.currency, "CNY");
  assert.eq(h.amount, 0);
  assert.eq(h.city, "深圳");
  assert.eq(h.nights, 1);
  assert.eq(h.checkin, h.date);
  assert.eq(h.checkout, I.addDays(h.date, 1));

  const m = P.fallbackRecord(f("上海机场餐饮52.JPG"), null);
  assert.eq(m.type, "meal");
  assert.eq(m.city, "上海");
  assert.isNull(m.nights);
  assert.isNull(m.checkin);
  assert.isNull(m.checkout);

  const t = P.fallbackRecord(f("高铁北京-上海.pdf"), null);
  assert.eq(t.type, "train");

  const e = P.fallbackRecord(f("x.png"), "boom");
  assert.match(e.note, /^解析失败/);
  assert.ok(e.note.length <= 20);
});

/* ======================= parseFile (filename-only path, no OCR/PDF) ======================= */

test("parseFile: image without OCR falls back to filename heuristics end-to-end", async () => {
  const file = {
    name: "深圳酒店1晚684.44.png",
    type: "image/png",
    size: 1234,
    lastModified: Date.UTC(2026, 2, 29, 12), // → 2026-03-29
  };
  const rec = await P.parseFile(file);
  assert.eq(rec.type, "hotel");
  assert.close(rec.amount, 684.44);
  assert.eq(rec.currency, "CNY");
  assert.eq(rec.city, "深圳");
  assert.eq(rec.date, "2026-03-29");
  assert.eq(rec.checkin, "2026-03-29");
  assert.eq(rec.nights, 1);
  assert.eq(rec.checkout, "2026-03-30");
  assert.eq(rec.source, file.name);
  assert.ok(rec.note.length <= 20);
});

test("parseFile: meal image → no hotel fields, CNY, amount from filename", async () => {
  const file = { name: "上海机场餐饮52.JPG", type: "image/jpeg", size: 1, lastModified: Date.UTC(2026, 2, 30, 12), slice() { return { arrayBuffer: async () => new ArrayBuffer(0) }; } };
  const rec = await P.parseFile(file);
  assert.eq(rec.type, "meal");
  assert.close(rec.amount, 52);
  assert.eq(rec.currency, "CNY");
  assert.eq(rec.city, "上海");
  assert.isNull(rec.nights);
  assert.isNull(rec.checkin);
  assert.isNull(rec.checkout);
});
