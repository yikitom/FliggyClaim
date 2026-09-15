#!/usr/bin/env node
/*
 * Regression tests for lib/parser.js's heuristics.
 *
 * These run on plain node — no jsdom, no browser — because every function
 * under test is pure text→value. Parsing sits UPSTREAM of the form filling:
 * a receipt mis-typed here picks the wrong TAE category, and a mis-read
 * amount is simply a wrong claim, however perfectly the form gets filled.
 *
 * Run:  node scripts/test-parser.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = process.env.FC_PARSER || path.join(HERE, "..", "lib", "parser.js");

// lib/parser.js is an IIFE that only exposes parseFile/fallbackRecord; lift its
// body to reach the heuristics directly.
const src = fs.readFileSync(SRC, "utf8");
const open = "(function (global) {";
const body = src.slice(src.indexOf(open) + open.length, src.lastIndexOf("})("));
const api = new Function(
  "global",
  body + `; return { detectType, guessTypeFromFilename, extractNights, detectAmount,
     detectDate, detectCurrency, normalizeCurrency, runHeuristics, buildNote,
     extractCity, extractRoute, addDays, todayISO, isPlausibleAmount,
     sanitizeRefined, isSafeEndpoint, isValidIsoDate };`,
)({});

// detectAmount logs its candidate list; keep the test output readable.
console.log = () => {};
const say = (...a) => process.stdout.write(a.join(" ") + "\n");

let pass = 0;
let fail = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; say(`  ✓ ${name}`); }
  else { fail++; say(`  ✗ ${name}\n      got ${JSON.stringify(got)} want ${JSON.stringify(want)}`); }
};
const truthy = (name, cond, detail) => {
  if (cond) { pass++; say(`  ✓ ${name}`); }
  else { fail++; say(`  ✗ ${name}${detail ? "\n      " + detail : ""}`); }
};

say("\n费用类型识别:");
eq("「Dinner for 2 at the restaurant」→ meal", api.detectType("Dinner for 2 at the restaurant"), "meal");
// "inn" 是 "dinner" 的子串，曾让这张餐费小票被判成 差旅-住宿
eq("「DINNER RECEIPT」→ meal，不是 hotel", api.detectType("DINNER RECEIPT"), "meal");
eq("「Cabin: Economy」不因 cab 变成打车", api.detectType("Boarding pass Cabin Economy"), "flight");
eq("「Bridge toll」不因 ride 变成打车", api.detectType("Bridge toll"), null);
eq("T3 航站楼的餐费不算打车", api.detectType("深圳宝安机场T3航站楼 餐饮 太兴"), "meal");
eq("真正的 T3出行 仍算打车", api.detectType("T3出行 行程单"), "taxi");
eq("中文关键词仍按子串匹配", api.detectType("深圳某某酒店 住宿费"), "hotel");
eq("电子客票行程单 → flight", api.detectType("电子客票行程单 航班"), "flight");
eq("Hilton 账单 → hotel", api.detectType("Hilton Shenzhen folio"), "hotel");
eq("空文本 → null", api.detectType(""), null);
eq("文件名猜类型同样用词边界", api.guessTypeFromFilename("dinner-2026.jpg"), "meal");

say("\n住宿晚数:");
// 旧正则结尾的 \b 在「晚」后面几乎不成立，只有恰好跟着数字才侥幸匹配
eq("「深圳酒店1晚」", api.extractNights("深圳酒店1晚"), 1);
eq("「深圳酒店1晚68444」", api.extractNights("深圳酒店1晚68444"), 1);
eq("「住宿 2晚」", api.extractNights("住宿 2晚"), 2);
eq("「3 nights」", api.extractNights("3 nights"), 3);
eq("「1 night」", api.extractNights("1 night"), 1);
eq("「三晚」", api.extractNights("三晚"), 3);
eq("没有晚数 → null", api.extractNights("深圳酒店 684.44"), null);

say("\n金额:");
eq("「合计 7.00 526.00」取最大的那个", api.detectAmount("合计 7.00 526.00", "x.png").value, 526);
eq("「实付 -20.00 应付 88.00」跳过折扣", api.detectAmount("实付 -20.00 应付 88.00", "x.png").value, 88);
eq("「¥684.44」", api.detectAmount("消费 ¥684.44", "x.png").value, 684.44);
eq("「85.2元」后缀", api.detectAmount("车费 85.2元", "x.png").value, 85.2);
eq("价税合计优先于普通数字", api.detectAmount("数量 2 单价 100.00 价税合计 226.00", "x.png").value, 226);
truthy("OCR 文本里的金额压过文件名里的数字",
  api.detectAmount("价税合计 684.44", "深圳酒店1晚68444.png").value === 684.44,
  JSON.stringify(api.detectAmount("价税合计 684.44", "深圳酒店1晚68444.png")));
eq("只有文件名时用文件名", api.detectAmount("", "餐饮94.png").value, 94);
eq("文件名里的年份不当金额", api.detectAmount("", "2026-03-30 餐饮94.png").value, 94);
eq("找不到任何金额 → null", api.detectAmount("", "receipt.png"), null);

say("\n币种:");
eq("人民币", api.detectCurrency("金额 人民币 100"), "CNY");
eq("SGD", api.detectCurrency("Total SGD 120.00"), "SGD");
eq("裸 $ 不认（OCR 噪声）", api.detectCurrency("Total $120.00"), null);
// 非 CNY 必须有明确的文字/代码佐证，否则退回 CNY
eq("£ 没有文字佐证时退回 CNY", api.runHeuristics("Total £120.00", "x.png").currency, "CNY");
eq("GBP 有代码佐证时保留", api.runHeuristics("Total GBP 120.00", "x.png").currency, "GBP");

say("\n日期:");
eq("2026-03-30", api.detectDate("开票日期 2026-03-30"), "2026-03-30");
eq("2026年3月30日", api.detectDate("2026年3月30日"), "2026-03-30");
eq("2026/3/9 补零", api.detectDate("2026/3/9"), "2026-03-09");
eq("13 月不算日期", api.detectDate("2026-13-30"), null);
eq("addDays 跨月", api.addDays("2026-03-30", 2), "2026-04-01");
eq("addDays 跨年", api.addDays("2026-12-31", 1), "2027-01-01");
eq("addDays 收到脏数据原样返回", api.addDays("不是日期", 1), "不是日期");

say("\n备注 / 城市:");
eq("商户名", api.buildNote("meal", "太兴深圳宝安机场分店 餐饮", "x.png", 94, "CNY"), "太兴深圳宝安机场分店");
eq("城市", api.extractCity("深圳宝安国际机场"), "深圳");
eq("航线", api.extractRoute("PEK-PVG 航班"), "PEK-PVG");

// todayISO 必须跟着本地时区走：UTC 版本会在 UTC+8 的凌晨给出昨天。
// 把时钟和时区都钉死，否则这条断言只在一天中的某几个小时才有判别力
// （容器跑在 UTC 时两者恰好相等，坏实现也能混过去）。
{
  say("\ntodayISO（本地时区）:");
  const TZ = process.env.TZ;
  const RealDate = Date;
  // UTC 2026-03-29 17:00 = 北京时间 2026-03-30 凌晨 1 点：两个日期不同。
  const FIXED = RealDate.parse("2026-03-29T17:00:00Z");
  process.env.TZ = "Asia/Shanghai";
  globalThis.Date = class extends RealDate {
    constructor(...args) { super(...(args.length ? args : [FIXED])); }
    static now() { return FIXED; }
  };
  try {
    eq("UTC+8 的凌晨给出的是今天而不是昨天", api.todayISO(), "2026-03-30");
  } finally {
    globalThis.Date = RealDate;
    if (TZ === undefined) delete process.env.TZ; else process.env.TZ = TZ;
  }
}

say("\n远程识别接口（可选，用户自配）:");
eq("https 允许", api.isSafeEndpoint("https://ocr.example.com/parse"), true);
eq("本机 http 允许（自建服务）", api.isSafeEndpoint("http://localhost:8000/parse"), true);
eq("127.0.0.1 允许", api.isSafeEndpoint("http://127.0.0.1:8000/parse"), true);
// 明文 http 会把票据图片和 Bearer key 一起裸奔发出去
eq("外网 http 拒绝", api.isSafeEndpoint("http://ocr.example.com/parse"), false);
eq("非法 URL 拒绝", api.isSafeEndpoint("不是地址"), false);
eq("空值拒绝", api.isSafeEndpoint(""), false);

say("\n远程返回值的清洗（接口是第三方代码，返回值直接进报销单）:");
eq("整体非对象 → null", api.sanitizeRefined("oops"), null);
eq("数组 → null", api.sanitizeRefined([1, 2]), null);
eq("合法字段全部保留",
  api.sanitizeRefined({ type: "hotel", date: "2026-03-29", amount: 684.44, currency: "cny", city: "深圳", nights: 2 }),
  { type: "hotel", date: "2026-03-29", amount: 684.44, currency: "CNY", city: "深圳", nights: 2 });
eq("未知类型被丢弃", api.sanitizeRefined({ type: "spaceship", amount: 10 }), { amount: 10 });
eq("非数字金额被丢弃", api.sanitizeRefined({ amount: "abc" }), null);
eq("数字字符串金额可接受", api.sanitizeRefined({ amount: "94.00" }), { amount: 94 });
eq("负数金额被丢弃", api.sanitizeRefined({ amount: -5 }), null);
eq("超大金额被丢弃", api.sanitizeRefined({ amount: 9e9 }), null);
eq("非法日期被丢弃", api.sanitizeRefined({ date: "2026-02-31" }), null);
eq("非 ISO 日期被丢弃", api.sanitizeRefined({ date: "03/29/2026" }), null);
eq("不支持的币种被丢弃", api.sanitizeRefined({ currency: "XYZ" }), null);
eq("夜数超界被丢弃", api.sanitizeRefined({ nights: 999 }), null);
eq("城市被截断", api.sanitizeRefined({ city: "城".repeat(50) }).city.length, 20);
eq("全是垃圾 → null", api.sanitizeRefined({ type: 1, date: 2, amount: {}, currency: [] }), null);

say(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
