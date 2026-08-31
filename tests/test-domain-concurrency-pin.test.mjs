// Turn P7: test:domain's node --test invocation had unbounded (per-CPU)
// file-level concurrency, which -- combined with several tests that spawn
// their own headless Chrome subprocess -- caused repeated resource
// exhaustion when run in a constrained sandbox (observed independently in
// two prior sessions, both ending in a non-zero-signal kill and orphaned
// Chrome/node processes). The fix is exactly one flag: --test-concurrency=1
// right after `node --test`, inserted into package.json's own test:domain
// script string -- the wrapper script (scripts/run-node-test-with-tmp-cleanup.mjs),
// the test file list, and their order are all otherwise byte-identical to
// before this Turn. This is a static, non-browser regression guard: it
// never itself runs the file list, only parses the script string.
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

function loadPackageJson() {
  return JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
}

test("test:domain pins node --test to --test-concurrency=1, exactly once, immediately after 'node --test'", () => {
  const pkg = loadPackageJson();
  const script = pkg.scripts["test:domain"];
  assert.equal(typeof script, "string");
  const occurrences = script.match(/--test-concurrency=1/g) ?? [];
  assert.equal(occurrences.length, 1, "expected exactly one --test-concurrency=1 flag");
  assert.match(script, /node --test --test-concurrency=1 tests\//, "the flag must sit directly after 'node --test', before the first test file");
});

test("test:domain's own wrapper invocation and file list are otherwise unchanged by the concurrency pin", () => {
  const pkg = loadPackageJson();
  const script = pkg.scripts["test:domain"];
  assert.match(script, /^node scripts\/run-node-test-with-tmp-cleanup\.mjs -- node --test --test-concurrency=1 tests\//, "wrapper invocation shape must be unchanged aside from the one inserted flag");
  // No retry/skip/timeout escalation was smuggled in alongside the
  // concurrency pin -- this Turn's own instruction: "retry/skip/timeout
  // 상향을 추가하지 않는다".
  assert.doesNotMatch(script, /--test-timeout|--test-retry|--test-skip/i);
});

test("test:domain still runs a non-trivial, non-empty file list (the concurrency pin did not accidentally drop files)", () => {
  const pkg = loadPackageJson();
  const script = pkg.scripts["test:domain"];
  const files = script.match(/tests\/[a-zA-Z0-9._-]*\.test\.mjs/g) ?? [];
  assert.ok(files.length > 100, `expected a large test:domain file list, got ${files.length}`);
  assert.equal(new Set(files).size, files.length, "no duplicate test file entries");
});
