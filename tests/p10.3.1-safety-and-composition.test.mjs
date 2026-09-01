import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");

const P10_3_1_FILES = [
  "domain/agent-comparison/chunking-comparison/table-locator-authority.mjs",
  "domain/agent-comparison/chunking-comparison/table-audit-classifier.mjs",
  "domain/agent-comparison/chunking-comparison/table-diagnostic-verdict-correction.mjs",
  "scripts/p10.3.1-stage1-2-locator-audit.mjs",
  "scripts/p10.3.1-stage3-corrected-violations.mjs",
  "scripts/p10.3.1-stage4-5-verdict-and-contract.mjs",
];

function stripLineComments(source) {
  return source.split("\n").filter((line) => !line.trim().startsWith("//")).join("\n");
}
function readSource(relPath) { return readFileSync(path.join(ROOT, relPath), "utf8"); }

test("every P10.3.1 source file listed by this suite actually exists on disk", () => {
  for (const relPath of P10_3_1_FILES) assert.doesNotThrow(() => readSource(relPath), `missing: ${relPath}`);
});

test("no P10.3.1 module or script has a file-read call targeting a DEV_CHECK/HOLDOUT-named path", () => {
  const readCallPattern = /\b(?:readFileSync|readFile|createReadStream|openSync|open)\s*\(([^)]*)\)/g;
  for (const relPath of P10_3_1_FILES) {
    const source = stripLineComments(readSource(relPath));
    for (const match of source.matchAll(readCallPattern)) {
      assert.doesNotMatch(match[1], /dev[-_]check|holdout[-_.]/i, `${relPath} reads a file whose path references DEV_CHECK/HOLDOUT: ${match[0]}`);
    }
  }
});

test("no P10.3.1 module or script spawns a model server, calls an embeddings endpoint, or imports an HCX/chat adapter -- zero embedding/model calls guaranteed structurally", () => {
  for (const relPath of P10_3_1_FILES) {
    const source = stripLineComments(readSource(relPath));
    assert.doesNotMatch(source, /spawn\s*\(\s*VENV_PYTHON/, `${relPath} must never spawn a local embedding server`);
    assert.doesNotMatch(source, /local_embedding_server\.py/, `${relPath} must never reference the embedding server script`);
    assert.doesNotMatch(source, /\/v1\/embeddings/, `${relPath} must never call an embeddings endpoint`);
    assert.doesNotMatch(source, /createEmbeddingAdapter/, `${relPath} must never construct an embedding adapter`);
    assert.doesNotMatch(source, /from\s+["'][^"']*model-adapter\.mjs["']/, `${relPath} must never import a chat/completion model adapter`);
    assert.doesNotMatch(source, /\bcallChatCompletion\b|\bcreateModelAdapter\b|\bHCX_API_KEY\b/, `${relPath} must never call an HCX/chat-completion adapter`);
  }
});

test("no P10.3.1 script invokes domain/chunking/chunker.mjs -- no chunking is (re-)run this Turn", () => {
  for (const relPath of P10_3_1_FILES) {
    const source = stripLineComments(readSource(relPath));
    assert.doesNotMatch(source, /chunkDocument/, `${relPath} must never invoke the chunker -- this Turn is audit-only`);
  }
});

test("no P10.3.1 script writes into P10.3's result directory -- input/result files stay unmodified", () => {
  for (const relPath of P10_3_1_FILES) {
    const source = stripLineComments(readSource(relPath));
    const writeCallPattern = /writeFile\s*\(([^,]*),/g;
    for (const match of source.matchAll(writeCallPattern)) {
      assert.doesNotMatch(match[1], /p10\.3-table-diagnostic/, `${relPath} must never write into work/p10.3-table-diagnostic/`);
    }
  }
});

test("Stage 1-2 script never assigns Gold question/expected_answer/evidence_span TEXT into a written report field", () => {
  const source = stripLineComments(readSource("scripts/p10.3.1-stage1-2-locator-audit.mjs"));
  assert.doesNotMatch(source, /\bitem\.question\b/);
  assert.doesNotMatch(source, /expected_answer(?!ability)\b/);
  assert.doesNotMatch(source, /evidence_span\s*:/, "must never assign evidence_span as an object field");
});

test("audit_item_id is a one-way hash of question_id, never the raw question_id itself (anonymization requirement)", () => {
  const source = readSource("scripts/p10.3.1-stage1-2-locator-audit.mjs");
  assert.match(source, /createHash\("sha256"\)\.update\(questionId/);
  assert.doesNotMatch(source, /audit_item_id:\s*item\.question_id/);
  assert.doesNotMatch(source, /audit_item_id:\s*questionId(?!\))/, "audit_item_id must be the hash, not the bare id");
});

test("node_id in audit records is a hash, never the raw source_locator/node_id string", () => {
  const source = readSource("scripts/p10.3.1-stage1-2-locator-audit.mjs");
  assert.match(source, /node_id_hash:\s*createHash/);
});

if (existsSync(path.join(ROOT, "work/p10.3.1-table-locator-audit/corrected-table-critical-violations.v0.1.json"))) {
  test("original vs corrected numbers are kept as SEPARATE, distinctly-labeled fields, never overwritten in place", () => {
    const report = JSON.parse(readFileSync(path.join(ROOT, "work/p10.3.1-table-locator-audit/corrected-table-critical-violations.v0.1.json"), "utf8"));
    for (const strategy of Object.values(report.strategies)) {
      assert.ok("original_critical_violation_count" in strategy);
      assert.ok("corrected_chunking_attributable_count" in strategy);
      assert.notEqual(strategy.original_critical_violation_count, undefined);
    }
  });

  test("real P10.3 figures (162 Fixed / 108 Section) are exactly reproduced as the original_critical_violation_count baseline", () => {
    const report = JSON.parse(readFileSync(path.join(ROOT, "work/p10.3.1-table-locator-audit/corrected-table-critical-violations.v0.1.json"), "utf8"));
    assert.equal(report.strategies["fixed-token-512-o64.v0.1.0"].original_critical_violation_count, 162);
    assert.equal(report.strategies["section-aware-flat-512-o64.v0.1.0"].original_critical_violation_count, 108);
  });
}
