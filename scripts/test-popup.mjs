#!/usr/bin/env node
/*
 * Smoke tests for the side panel (popup/).
 *
 * Loads the real popup.html + popup.js in jsdom with chrome.* stubbed, so a
 * template/selector mismatch (class renamed in the CSS but not the template,
 * a querySelector that returns null) fails here instead of silently doing
 * nothing in the panel.
 *
 * Run:  npm i jsdom && node scripts/test-popup.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");

let JSDOM;
try {
  ({ JSDOM } = await import("jsdom"));
} catch {
  console.error("需要 jsdom：npm i jsdom（或 npm i -D jsdom）后重试");
  process.exit(2);
}

const calls = { messages: [], query: 0, toasts: [] };

async function boot(records, fileNames = []) {
  calls.messages = [];
  calls.query = 0;
  calls.toasts = [];
  // "dangerously" so popup.js runs as a real classic script — its top-level
  // `const state` then lives in the realm's global lexical scope, which
  // window.eval() can read. (Under window.eval the declaration would be
  // scoped to the eval call and thrown away.) External <script src> tags in
  // popup.html are not fetched, since `resources` is left at the default.
  const dom = new JSDOM(fs.readFileSync(path.join(ROOT, "popup", "popup.html"), "utf8"), {
    runScripts: "dangerously",
  });
  const { window } = dom;
  window.chrome = {
    storage: {
      local: { get: async () => ({}), set: async () => {} },
      sync: { get: async () => ({}), set: async () => {} },
    },
    tabs: {
      query: async () => { calls.query++; return [{ id: 1, url: "https://tae.alibaba-inc.com/expense/x" }]; },
      sendMessage: async (_id, msg) => {
        calls.messages.push(msg && msg.type);
        // ensureContentScript pings first; only FLIGGY_FILL is the import.
        if (msg && msg.type === "FLIGGY_PING") return { ok: true, ready: true };
        return { ok: true, filled: records.length };
      },
    },
    scripting: { insertCSS: async () => {}, executeScript: async () => {} },
    runtime: { sendMessage: async () => ({ ok: true }), getURL: (p) => p },
  };
  window.FliggyParser = { parseFile: async () => ({}), fallbackRecord: () => ({}), terminateOcr: async () => {} };
  const script = window.document.createElement("script");
  script.textContent = fs.readFileSync(path.join(ROOT, "popup", "popup.js"), "utf8");
  window.document.head.appendChild(script);
  window.document.dispatchEvent(new window.Event("DOMContentLoaded"));
  await new Promise((r) => setTimeout(r, 20));

  // `state` is a top-level const of a classic script: reachable via eval in
  // the same realm, not as a window property.
  const state = window.eval("state");
  state.records = records;
  for (const name of fileNames) state.files.set(name, { name, size: 1, lastModified: 1, type: "image/png" });
  window.renderParsed();
  // `function toast()` is a global-object property, so it can be swapped out.
  window.toast = (msg, kind) => calls.toasts.push({ msg, kind });
  return { window, state };
}

let pass = 0;
let fail = 0;
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? "\n      " + detail : ""}`); }
};

const rec = (over = {}) => ({
  type: "meal", date: "2026-03-30", currency: "CNY", amount: 94,
  note: "餐饮", city: "深圳", source: "餐饮94.png",
  _debug: { amountSource: "total-keyword" }, ...over,
});

console.log("\n低置信度金额的提示:");
{
  const { window } = await boot([rec()]);
  const item = window.document.querySelector(".parsed-item");
  check("正常记录不报警", item && !item.classList.contains("is-warn"));
  check("提示标记是隐藏的", item.querySelector(".warn-flag").hidden === true);
}
{
  // 深圳酒店1晚68444.png 在关掉 OCR 时会被解析成 68444 而不是 684.44
  const { window } = await boot([rec({ amount: 68444, _debug: { amountSource: "filename" } })]);
  const item = window.document.querySelector(".parsed-item");
  check("金额来自文件名 → 整行标黄", item.classList.contains("is-warn"));
  check("提示写明原因", /文件名/.test(item.querySelector(".warn-flag").title),
    item.querySelector(".warn-flag").title);
}
{
  const { window } = await boot([rec({ _debug: { amountSource: "bare-decimal" } })]);
  check("金额取自无标签数字 → 提示核对",
    /没有标签/.test(window.document.querySelector(".warn-flag").title));
}
{
  const { window } = await boot([rec({ amount: 0, _debug: { amountSource: "none" } })]);
  check("金额为 0 → 提示手动填写",
    /手动填写/.test(window.document.querySelector(".warn-flag").title));
}

console.log("\n酒店缺原始文件:");
{
  const { window } = await boot([rec({ type: "hotel", source: "深圳酒店.png", nights: 1 })]);
  check("没有这份文件 → 提示凭证必填",
    /凭证/.test(window.document.querySelector(".warn-flag").title),
    window.document.querySelector(".warn-flag").title);
}
{
  const { window } = await boot([rec({ type: "hotel", source: "深圳酒店.png", nights: 1 })], ["深圳酒店.png"]);
  const t = window.document.querySelector(".warn-flag").title;
  check("文件在 → 不再提示凭证", !/凭证/.test(t), t);
}

console.log("\n导入前的金额闸门:");
{
  const { window } = await boot([rec(), rec({ amount: 0 })]);
  await window.importToSystem();
  check("有 0 元记录时不下发 FLIGGY_FILL", calls.messages.length === 0 && calls.query === 0,
    JSON.stringify(calls.messages));
  check("并且明确告诉用户是第几条", calls.toasts.some((t) => /第 2 条/.test(t.msg) && t.kind === "error"),
    JSON.stringify(calls.toasts));
}
{
  const { window } = await boot([rec(), rec({ amount: 52 })]);
  await window.importToSystem();
  check("金额齐全时正常下发", calls.messages.filter((t) => t === "FLIGGY_FILL").length === 1,
    JSON.stringify(calls.messages));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
