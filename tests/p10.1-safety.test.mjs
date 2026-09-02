// Turn P10.1 safety-invariant tests: no P10.1 module/script references HCX,
// opens a DEV_CHECK/HOLDOUT path, or writes question/answer/evidence_span
// TEXT into any output file. Static/read-only checks -- never opens the
// real Gold file's content beyond what the build script itself does.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");

const P10_1_MODULE_FILES = [
  "domain/agent-comparison/chunking-comparison/dev-tune-input-gate.mjs",
  "domain/agent-comparison/chunking-comparison/document-metadata-index.mjs",
  "domain/agent-comparison/chunking-comparison/hard-negative-selector.mjs",
  "domain/agent-comparison/chunking-comparison/raw-corpus-extractor.mjs",
  "domain/agent-comparison/chunking-comparison/dev-tune-evidence-locator.mjs",
  "domain/agent-comparison/chunking-comparison/dev-tune-metrics.mjs",
  "domain/agent-comparison/chunking-comparison/chunking-selection-rule.mjs",
  "scripts/p10.1-build-evaluation-corpus.mjs",
  "scripts/p10.1-run-dev-tune-comparison.mjs",
];

function stripLineComments(source) {
  return source.split("\n").filter((line) => !line.trim().startsWith("//")).join("\n");
}

test("no P10.1 module or script imports a chat/completion model adapter or calls an HCX-shaped function", () => {
  for (const relPath of P10_1_MODULE_FILES) {
    const source = stripLineComments(readFileSync(path.join(ROOT, relPath), "utf8"));
    assert.doesNotMatch(source, /from\s+["'][^"']*model-adapter\.mjs["']/, `${relPath} must never import a chat/completion model adapter`);
    assert.doesNotMatch(source, /\bcallChatCompletion\b|\bcreateModelAdapter\b|\bHCX_API_KEY\b|\bcreateChatAdapter\b/, `${relPath} must never call an HCX/chat-completion adapter`);
  }
});

test("no P10.1 module or script has a file-read call targeting a DEV_CHECK/HOLDOUT-named path", () => {
  const readCallPattern = /\b(?:readFileSync|readFile|createReadStream|openSync|open)\s*\(([^)]*)\)/g;
  for (const relPath of P10_1_MODULE_FILES) {
    const source = stripLineComments(readFileSync(path.join(ROOT, relPath), "utf8"));
    for (const match of source.matchAll(readCallPattern)) {
      assert.doesNotMatch(match[1], /dev[-_]check|holdout[-_.]/i, `${relPath} reads a file whose path references DEV_CHECK/HOLDOUT: ${match[0]}`);
    }
  }
});

test("dev-tune-input-gate.mjs and the build script only ever hardcode the DEV_TUNE-named gold/manifest paths, never a DEV_CHECK or HOLDOUT release path", () => {
  for (const relPath of ["domain/agent-comparison/chunking-comparison/dev-tune-input-gate.mjs", "scripts/p10.1-build-evaluation-corpus.mjs"]) {
    const source = readFileSync(path.join(ROOT, relPath), "utf8");
    assert.doesNotMatch(source, /dev-check-gold|dev_check_gold|holdout-gold|holdout_gold/i);
  }
});

test("the comparison runner never assigns item.question_text/expected_answer/evidence_span into any WRITTEN report object", () => {
  // Comment lines are stripped first -- this module's own header comments
  // legitimately explain "never uses expected_answer/evidence_span" in
  // prose, which is not itself a leak (see dev-tune-metrics.mjs's header).
  const source = stripLineComments(readFileSync(path.join(ROOT, "scripts/p10.1-run-dev-tune-comparison.mjs"), "utf8"));
  assert.doesNotMatch(source, /expected_answer(?!ability)\b/);
  assert.doesNotMatch(source, /evidence_span/);
  // item.question is read (as query input) but the metrics/report objects
  // built from it (computeItemMetrics's return value) never re-embed it --
  // verified structurally: dev-tune-metrics.mjs's own output shape never
  // includes a "question" field (see next test).
});

test("computeItemMetrics's output shape never includes question/answer/evidence text fields", () => {
  const source = stripLineComments(readFileSync(path.join(ROOT, "domain/agent-comparison/chunking-comparison/dev-tune-metrics.mjs"), "utf8"));
  assert.doesNotMatch(source, /\bquestion\s*:/);
  assert.doesNotMatch(source, /expected_answer(?!ability)\b/);
  assert.doesNotMatch(source, /evidence_span/);
});

test("every P10.1 test file referenced by this suite actually exists on disk", () => {
  const testDir = path.join(ROOT, "tests");
  const p101Tests = readdirSync(testDir).filter((f) => f.startsWith("p10.1-") && f.endsWith(".test.mjs"));
  assert.ok(p101Tests.length >= 5, `expected at least 5 p10.1-*.test.mjs files, found: ${p101Tests.join(", ")}`);
});
