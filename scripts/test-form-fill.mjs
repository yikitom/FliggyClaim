#!/usr/bin/env node
/*
 * Regression tests for content.js's form targeting.
 *
 * Every field the importer writes is found by walking the DOM from a Chinese
 * label, and the failure mode is silent: land on the wrong <input> and the
 * value goes somewhere harmless-looking while 保存 still succeeds. The
 * 2026-04-26 console log had all three variants at once —
 *   • 金额 → <input type="checkbox" class="kuma-checkbox">  (page-wide scope
 *     picked up the master grid's own 「金额」 column header)
 *   • 金额 → <input class="kuma-select2-search__field">      (label lookup
 *     matched the field WRAPPER, then walked into the next field)
 *   • 币种 → left on the report's default currency
 * — and all three were reported as ✓.
 *
 * The fixture is the real TAE DOM (hashed CSS-module class names included)
 * reconstructed from that log.
 *
 * Run:  npm i jsdom && node scripts/test-form-fill.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pageHtml, installCalendarBehavior } from "./fixtures/tae-page.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = process.env.FC_SRC || path.join(HERE, "..", "content", "content.js");

let JSDOM;
try {
  ({ JSDOM } = await import("jsdom"));
} catch {
  console.error("需要 jsdom：npm i jsdom（或 npm i -D jsdom）后重试");
  process.exit(2);
}

function load(kind, calendarOpts) {
  const { window } = new JSDOM(pageHtml(kind), { pretendToBeVisual: true });

  // jsdom does no layout, so every getBoundingClientRect() is 0×0 and
  // isVisible() would reject the whole page. Fake a box for anything not
  // inside a display:none / visibility:hidden subtree — that hidden-subtree
  // rule is the part of isVisible() the selectors actually rely on (kuma
  // parks a typeahead <input> at display:none inside every closed dropdown).
  let seq = 0;
  const boxes = new WeakMap();
  window.Element.prototype.getBoundingClientRect = function () {
    for (let cur = this; cur && cur.nodeType === 1; cur = cur.parentElement) {
      const s = cur.style;
      if (s && (s.display === "none" || s.visibility === "hidden" || s.opacity === "0")) {
        return { width: 0, height: 0, top: 0, bottom: 0, left: 0, right: 0, x: 0, y: 0 };
      }
    }
    if (!boxes.has(this)) {
      const y = (seq += 30);
      boxes.set(this, { width: 160, height: 24, top: y, bottom: y + 24, left: 200, right: 360, x: 200, y });
    }
    return boxes.get(this);
  };

  for (const k of [
    "getComputedStyle", "HTMLInputElement", "HTMLElement", "Element", "Node", "InputEvent",
    "Event", "MouseEvent", "KeyboardEvent", "FocusEvent", "CSS", "DataTransfer", "File",
    // NB: never alias setTimeout/clearTimeout here — jsdom's timers call the
    // environment's global ones, so aliasing them makes jsdom recurse forever.
  ]) globalThis[k] = window[k];
  globalThis.window = window;
  globalThis.document = window.document;
  globalThis.location = window.location;
  globalThis.chrome = { runtime: { onMessage: { addListener() {} } } };

  // content.js is an IIFE with no exports; lift its body so the internals are
  // reachable. `typeof X === "function"` never throws on an undeclared name,
  // so this also loads older revisions (handy for bisecting a regression).
  const src = fs.readFileSync(SRC, "utf8");
  const open = "(() => {";
  const body = src.slice(src.indexOf(open) + open.length, src.lastIndexOf("})();"));
  if (calendarOpts) installCalendarBehavior(window, calendarOpts);

  const names = [
    "findCategoryForm", "isFormReady", "findAmountInput", "findControlByLabel", "collectLabelEls",
    "findFileInputByLabel", "findAddExpenseButton", "findCategoryPicker", "describeInput",
    "isVisible", "pickControl", "readComboSelection", "comboComponent", "sameAmount", "normText",
    "setDateLikeValue", "fillDate", "isRequiredField", "dateStuck",
  ];
  const exports = `; return { LABELS, ${names
    .map((n) => `${n}: (typeof ${n} === "function" ? ${n} : null)`)
    .join(", ")} };`;
  const api = new Function(body + exports)();
  const missing = names.filter((n) => !api[n]);
  if (missing.length) throw new Error(`content.js 缺少: ${missing.join(", ")}`);
  return api;
}

let pass = 0;
let fail = 0;
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? "\n      " + detail : ""}`); }
};
const desc = (el) => (el ? `<${el.tagName.toLowerCase()} type=${el.type || "-"} class="${el.className}">` : "null");
const rowOf = (label) => Array.from(document.querySelectorAll(".field_PlvYD"))
  .find((f) => f.querySelector(".label_3OUma")?.textContent.startsWith(label));

/* ---------- 差旅-餐费 ---------- */
{
  console.log("\n差旅-餐费 表单:");
  const api = load("meal");
  const form = api.findCategoryForm();
  check("表单作用域不含左侧列表 / 新增费用", form && !form.contains(api.findAddExpenseButton()), desc(form));
  check("表单作用域含「保存」", form && /保存/.test(form.textContent));
  check("isFormReady() 为真", api.isFormReady(form));

  const amt = api.findAmountInput(form);
  check("金额 → NumberInput，而不是币种下拉的搜索框",
    amt === document.querySelector(".numberInputWrapper_cWTb2 input"), `got ${desc(amt)}`);

  const cur = api.findControlByLabel(form, api.LABELS.currency, "combobox");
  check("币种 → 本行内可见的 select2 选择框",
    !!cur && rowOf("币种").contains(cur) && /select2-selection/.test(cur.className), `got ${desc(cur)}`);
  check("能读出币种当前选中值", api.readComboSelection(api.comboComponent(cur)) === "SGD (新加坡元）");
  check("全角括号的「CNY (人民币）」能匹配 CNY", api.normText("CNY (人民币）").includes(api.normText("CNY")));

  const note = api.findControlByLabel(form, api.LABELS.note, "textarea");
  check("详细说明 → textarea", note === document.querySelector("textarea"), `got ${desc(note)}`);

  const date = api.findControlByLabel(form, api.LABELS.date, "date");
  check("费用发生时间 → 日历输入框",
    date === document.querySelector(".kuma-calendar-picker-input input"), `got ${desc(date)}`);

  check("附件 → 本表单的 file input",
    api.findFileInputByLabel(form, api.LABELS.attachment) === document.getElementById("meal-attach"));
}

/* ---------- 差旅-住宿 ---------- */
{
  console.log("\n差旅-住宿 表单:");
  const api = load("hotel");
  const form = api.findCategoryForm();
  const amt = api.findAmountInput(form);
  check("金额 → 金额行的输入框，不是表格勾选框",
    !!amt && rowOf("金额").contains(amt) && amt.type === "text", `got ${desc(amt)}`);
  check("金额 没有落到「间夜数」", amt !== rowOf("间夜数").querySelector("input"));

  const ci = api.findControlByLabel(form, api.LABELS.checkin, "date");
  const co = api.findControlByLabel(form, api.LABELS.checkout, "date");
  check("入住时间 / 离店时间 是两个不同的日历", !!ci && !!co && ci !== co);
  check("入住时间 在自己那一行", !!ci && rowOf("入住时间").contains(ci), desc(ci));

  const city = api.findControlByLabel(form, api.LABELS.city, "combobox");
  check("费用发生城市 → 自己那一行的 select2", !!city && rowOf("费用发生城市").contains(city), desc(city));

  check("酒店住宿相关凭证 → 必填的凭证槽位",
    api.findFileInputByLabel(form, api.LABELS.hotelReceipt) === document.getElementById("hotel-receipt"));
  check("附件 → 另一个可选槽位",
    api.findFileInputByLabel(form, api.LABELS.attachment) === document.getElementById("hotel-attach"));
}

/* ---------- 抽屉已开、字段未渲染（记录 1 的竞态） ---------- */
{
  console.log("\n抽屉已开但字段还没渲染:");
  const api = load("skeleton");
  const form = api.findCategoryForm();
  check("绝不返回包含左侧列表的作用域", !form || !form.contains(api.findAddExpenseButton()), desc(form));
  check("isFormReady() 为假，waitFor 会继续轮询", !api.isFormReady(form));
  if (form) check("不会从表格里编造出一个金额框", api.findAmountInput(form)?.type !== "checkbox");
}

/* ---------- 费用类型选择抽屉 ---------- */
{
  console.log("\n费用类型选择抽屉:");
  const api = load("picker");
  check("findCategoryPicker() 能找到", !!api.findCategoryPicker());
  check("findCategoryForm() 返回 null（没有保存按钮）", api.findCategoryForm() === null);
}

/* ---------- 金额校验 ---------- */
{
  console.log("\n金额校验:");
  const api = load("meal");
  check("空值不算写入成功", !api.sameAmount("", 94));
  check("勾选框的 'on' 不算 684.44", !api.sameAmount("on", 684.44));
  check("'684.44' == 684.44", api.sameAmount("684.44", 684.44));
  check("'1,234.50' == 1234.5", api.sameAmount("1,234.50", 1234.5));
}

/* ---------- 日期：readonly 输入框只能靠日历面板写 ---------- */
{
  console.log("\n日期写入（kuma 日历，输入框 readonly）:");
  // 面板默认停在 2026-04，记录是 2026-03-30 —— 必须翻月
  const api = load("meal", { openMonth: "2026-04" });
  const form = api.findCategoryForm();
  const el = api.findControlByLabel(form, api.LABELS.date, "date");
  check("拿到的是 readonly 的日历输入框", !!el && el.readOnly);
  check("写入前是空的", el.value === "");
  const ok = await api.setDateLikeValue(el, "2026-03-30");
  check("setDateLikeValue 返回 true", ok === true);
  check("值真的落到了 2026-03-30", el.value === "2026-03-30", `got "${el.value}"`);
  check("日历面板已关闭", !document.querySelector(".kuma-calendar-picker-container"));
}
{
  console.log("\n日期：同月 / 无 title / 面板自带输入框:");
  {
    const api = load("meal", { openMonth: "2026-03" });
    const el = api.findControlByLabel(api.findCategoryForm(), api.LABELS.date, "date");
    await api.setDateLikeValue(el, "2026-03-30");
    check("同月直接点单元格", el.value === "2026-03-30", `got "${el.value}"`);
  }
  {
    const api = load("meal", { openMonth: "2026-04", titles: false });
    const el = api.findControlByLabel(api.findCategoryForm(), api.LABELS.date, "date");
    await api.setDateLikeValue(el, "2026-03-30");
    check("单元格没有 title 时按日号兜底", el.value === "2026-03-30", `got "${el.value}"`);
  }
  {
    const api = load("meal", { openMonth: "2026-04", panelInput: true });
    const el = api.findControlByLabel(api.findCategoryForm(), api.LABELS.date, "date");
    await api.setDateLikeValue(el, "2026-03-30");
    check("面板自带输入框时直接输入", el.value === "2026-03-30", `got "${el.value}"`);
  }
}
{
  console.log("\n日期写不进去时:");
  const api = load("hotel", { broken: true });
  const form = api.findCategoryForm();
  const el = api.findControlByLabel(form, api.LABELS.checkin, "date");
  check("setDateLikeValue 如实返回 false", (await api.setDateLikeValue(el, "2026-03-29")) === false);
  check("入住时间被识别为必填", api.isRequiredField(el));
  check("费用发生时间（选填）不被误判为必填",
    !api.isRequiredField(load("meal").findControlByLabel(load("meal").findCategoryForm(), api.LABELS.date, "date")));
  let threw = null;
  try {
    await api.fillDate(form, api.LABELS.checkin, "2026-03-29", "入住时间");
  } catch (e) { threw = e.message; }
  check("必填日期写不进去 → 抛错，不保存该条", !!threw && /入住时间/.test(threw), threw || "没抛错");
}
{
  console.log("\n选填日期写不进去时:");
  const api = load("meal", { broken: true });
  const form = api.findCategoryForm();
  let threw = null;
  try {
    const r = await api.fillDate(form, api.LABELS.date, "2026-03-30", "费用发生时间");
    check("返回 false 而不是抛错", r === false);
  } catch (e) { threw = e.message; }
  check("选填日期失败不影响这条记录", !threw, threw || "");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
