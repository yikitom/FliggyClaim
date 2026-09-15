#!/usr/bin/env node
/*
 * Run every suite and summarise. `npm test`.
 *
 *   test-parser     lib/parser.js heuristics — plain node, no deps
 *   test-form-fill  content.js form targeting against a reconstructed TAE DOM
 *   test-popup      the side panel loaded from the real popup.html
 *
 * The last two need jsdom (`npm i`); they exit 2 when it's missing, which is
 * reported as SKIP rather than failure so the dependency-free suite still runs.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SUITES = [
  ["解析 lib/parser.js", "test-parser.mjs"],
  ["填表 content.js", "test-form-fill.mjs"],
  ["侧边栏 popup/", "test-popup.mjs"],
];

const run = (file) =>
  new Promise((resolve) => {
    const p = spawn(process.execPath, [path.join(HERE, file)], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    p.on("close", (code) => resolve({ code, out }));
  });

let failed = 0;
let skipped = 0;
const lines = [];

for (const [label, file] of SUITES) {
  const { code, out } = await run(file);
  const tally = out.match(/(\d+) passed, (\d+) failed/);
  if (code === 2) {
    skipped++;
    lines.push(`  SKIP  ${label} — ${out.trim().split("\n").pop()}`);
    continue;
  }
  if (code !== 0) {
    failed++;
    process.stdout.write(out);
    lines.push(`  FAIL  ${label}${tally ? ` (${tally[2]} failed)` : ""}`);
    continue;
  }
  lines.push(`  ok    ${label} — ${tally ? `${tally[1]} passed` : "passed"}`);
}

console.log("\n" + lines.join("\n"));
if (skipped) console.log("\n（跳过的用例需要 jsdom：npm i）");
process.exit(failed ? 1 : 0);
