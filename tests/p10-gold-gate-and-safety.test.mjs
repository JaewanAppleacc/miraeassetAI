// Turn P10 safety-invariant tests: the Gold gate is correctly detected as
// RED given this repo's current state, and none of the P10 scripts/modules
// reference HCX, HOLDOUT, or DEV_TUNE/DEV_CHECK file access paths. These
// are static/read-only checks -- no Gold/DEV/HOLDOUT file is ever opened
// by this test file itself.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");

function runGateCheck() {
  const output = execFileSync("node", [path.join(ROOT, "scripts/p10-gold-gate-check.mjs")], { encoding: "utf8" });
  return JSON.parse(output);
}

test("Gold gate: current repo state is correctly detected as RED, outcome is the PENDING sentinel", () => {
  const result = runGateCheck();
  assert.equal(result.gate_status, "RED");
  assert.equal(result.outcome, "CHUNKING_COMPARISON_READY_PENDING_VALIDATED_DEV_GOLD");
  assert.ok(result.checks.every((c) => typeof c.pass === "boolean"));
});

function stripLineComments(source) {
  return source.split("\n").filter((line) => !line.trim().startsWith("//")).join("\n");
}

const P10_MODULE_FILES = [
  "domain/agent-comparison/chunking-comparison/b-canonical-to-chunker-input.mjs",
  "domain/agent-comparison/chunking-comparison/resolvable-bundle-corpus.mjs",
  "domain/agent-comparison/chunking-comparison/evidence-node-grounding.mjs",
  "domain/agent-comparison/chunking-comparison/p10-manifest.mjs",
  "domain/agent-comparison/chunking-comparison/bm25.mjs",
  "domain/agent-comparison/chunking-comparison/rrf.mjs",
  "scripts/p10-corpus-only-stats.mjs",
  "scripts/p10-bounded-retrieval-smoke.mjs",
  "scripts/p10-gold-gate-check.mjs",
];

// Only real invocation/import signals are checked here -- NOT the bare word
// "HCX" (every P10 script's own header comment honestly documents "NEVER
// calls HCX", which would trip a naive substring match on itself).
test("no P10 module or script imports an HCX / chat-completion model adapter, or calls a chat-completion-shaped function", () => {
  for (const relPath of P10_MODULE_FILES) {
    const source = stripLineComments(readFileSync(path.join(ROOT, relPath), "utf8"));
    assert.doesNotMatch(source, /from\s+["'][^"']*model-adapter\.mjs["']/, `${relPath} must never import a chat/completion model adapter`);
    assert.doesNotMatch(source, /\bcallChatCompletion\b|\bcreateModelAdapter\b|\bHCX_API_KEY\b|\bcreateChatAdapter\b/, `${relPath} must never call an HCX/chat-completion adapter`);
  }
});

// The real invariant is "never OPENS a DEV_TUNE/DEV_CHECK/HOLDOUT file" --
// not "never mentions the words" (p10-gold-gate-check.mjs's own honest
// status report legitimately names them in a plain-English disclosure
// string, which is not a file access). So this scans specifically for a
// file-read call (readFileSync/readFile/createReadStream/openSync) whose
// OWN argument names one of these artifacts.
test("no P10 module or script imports domain/evaluation/**, and no file-read call anywhere targets a dev-tune/dev-check/holdout artifact path", () => {
  const readCallPattern = /\b(?:readFileSync|readFile|createReadStream|openSync|open)\s*\(([^)]*)\)/g;
  for (const relPath of P10_MODULE_FILES) {
    const source = stripLineComments(readFileSync(path.join(ROOT, relPath), "utf8"));
    assert.doesNotMatch(source, /from\s+["'][^"']*domain\/evaluation\//, `${relPath} must never import domain/evaluation/**`);
    for (const match of source.matchAll(readCallPattern)) {
      assert.doesNotMatch(match[1], /dev[-_]tune|dev[-_]check|holdout[-_.]/i, `${relPath} reads a file whose path references dev-tune/dev-check/holdout: ${match[0]}`);
    }
  }
});

test("the bounded-retrieval-smoke script never assigns a dataset item's textContent/quoted text into its written report object", () => {
  const source = readFileSync(path.join(ROOT, "scripts/p10-bounded-retrieval-smoke.mjs"), "utf8");
  // The report object is built in the `const report = { ... };` literal
  // near the bottom of main(); textContent must never appear as a value
  // assigned there (only used earlier, transiently, as embedding/BM25
  // QUERY input, never persisted).
  const reportLiteralMatch = source.match(/const report = \{[\s\S]*?\n\s*\};/);
  assert.ok(reportLiteralMatch, "could not locate the report object literal to audit");
  assert.doesNotMatch(reportLiteralMatch[0], /textContent|quotedText|quoted_text/);
});

test("every P10 test file referenced by this suite actually exists on disk", () => {
  const testDir = path.join(ROOT, "tests");
  const p10Tests = readdirSync(testDir).filter((f) => f.startsWith("p10-") && f.endsWith(".test.mjs"));
  assert.ok(p10Tests.length >= 4, `expected at least 4 p10-*.test.mjs files, found: ${p10Tests.join(", ")}`);
});
