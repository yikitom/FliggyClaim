#!/usr/bin/env node
/*
 * Minimal zero-dependency test runner for FliggyClaim.
 *
 *   node tests/run.js            # run every tests/*.test.js
 *   node tests/run.js parser     # only files whose name contains "parser"
 *   FLIGGY_TEST_VERBOSE=1 ...    # print every passing test, not just failures
 *
 * Test files register cases with the global `test(name, fn)`; `fn` may be
 * async. Assertions come from the global `assert` object below. Files can also
 * register `afterAll(fn)` for teardown (used by the browser tests to close
 * Chromium).
 */
"use strict";

const fs = require("fs");
const path = require("path");

const filter = process.argv[2] || "";
const verbose = !!process.env.FLIGGY_TEST_VERBOSE;

// ---------- assertion helpers ----------
class AssertionError extends Error {}
function fmt(v) {
  try { return typeof v === "string" ? JSON.stringify(v) : JSON.stringify(v, null, 0); }
  catch { return String(v); }
}
const assert = {
  ok(cond, msg = "expected truthy") {
    if (!cond) throw new AssertionError(msg);
  },
  eq(actual, expected, msg = "") {
    if (actual !== expected) {
      throw new AssertionError(`${msg ? msg + ": " : ""}expected ${fmt(expected)}, got ${fmt(actual)}`);
    }
  },
  deepEq(actual, expected, msg = "") {
    const a = JSON.stringify(actual), e = JSON.stringify(expected);
    if (a !== e) throw new AssertionError(`${msg ? msg + ": " : ""}expected ${e}, got ${a}`);
  },
  close(actual, expected, eps = 1e-6, msg = "") {
    if (typeof actual !== "number" || Math.abs(actual - expected) > eps) {
      throw new AssertionError(`${msg ? msg + ": " : ""}expected ≈${expected}, got ${fmt(actual)}`);
    }
  },
  match(str, re, msg = "") {
    if (!re.test(String(str))) throw new AssertionError(`${msg ? msg + ": " : ""}${fmt(str)} !~ ${re}`);
  },
  oneOf(actual, list, msg = "") {
    if (!list.includes(actual)) throw new AssertionError(`${msg ? msg + ": " : ""}expected one of ${fmt(list)}, got ${fmt(actual)}`);
  },
  isNull(v, msg = "") {
    if (v !== null && v !== undefined) throw new AssertionError(`${msg ? msg + ": " : ""}expected null/undefined, got ${fmt(v)}`);
  },
  async throws(fn, re, msg = "") {
    try { await fn(); } catch (e) {
      if (re && !re.test(String(e && e.message || e))) {
        throw new AssertionError(`${msg ? msg + ": " : ""}threw ${fmt(String(e))}, expected ${re}`);
      }
      return;
    }
    throw new AssertionError(`${msg ? msg + ": " : ""}expected to throw`);
  },
};

// ---------- registration ----------
const suites = []; // { file, tests: [{name, fn}], afterAll: [] }
let current = null;
global.assert = assert;
global.test = (name, fn) => { current.tests.push({ name, fn }); };
global.afterAll = (fn) => { current.afterAll.push(fn); };

const dir = __dirname;
const files = fs.readdirSync(dir)
  .filter((f) => f.endsWith(".test.js"))
  .filter((f) => !filter || f.includes(filter))
  .sort();

for (const f of files) {
  current = { file: f, tests: [], afterAll: [] };
  suites.push(current);
  require(path.join(dir, f));
}
current = null;

// ---------- run ----------
(async () => {
  let pass = 0, fail = 0;
  const failures = [];
  const t0 = Date.now();
  for (const s of suites) {
    console.log(`\n▶ ${s.file}`);
    for (const t of s.tests) {
      const start = Date.now();
      try {
        await t.fn();
        pass++;
        if (verbose) console.log(`  ✓ ${t.name} (${Date.now() - start}ms)`);
      } catch (e) {
        fail++;
        failures.push({ file: s.file, name: t.name, err: e });
        console.log(`  ✗ ${t.name}`);
        console.log(`      ${String(e && e.stack || e).split("\n").slice(0, 3).join("\n      ")}`);
      }
    }
    for (const fn of s.afterAll) {
      try { await fn(); } catch (e) { console.log(`  (afterAll error: ${e && e.message})`); }
    }
    if (!verbose) console.log(`  ${s.tests.length - s.tests.filter((t) => failures.some((f) => f.file === s.file && f.name === t.name)).length}/${s.tests.length} passed`);
  }
  console.log(`\n${fail === 0 ? "✅" : "❌"} ${pass} passed, ${fail} failed  (${Date.now() - t0}ms)`);
  if (fail) {
    console.log("\nFailures:");
    for (const f of failures) console.log(`  - [${f.file}] ${f.name}: ${f.err && f.err.message}`);
  }
  process.exit(fail ? 1 : 0);
})();
