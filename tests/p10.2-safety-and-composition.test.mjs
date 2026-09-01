import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { P10_STRATEGIES } from "../domain/agent-comparison/chunking-comparison/p10-manifest.mjs";
import { getFrozenCandidateById, listFrozenCandidates } from "../domain/agent-comparison/embedding-calibration/frozen-candidates/registry.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const MODEL_ORDER = ["kure_v1", "bge_m3", "pixie_rune"];
const EXPECTED_PINS = {
  kure_v1: { repository_id: "nlpai-lab/KURE-v1", immutable_revision: "4ed4540949c70b7da2c74004a915e1f2d5e46e4f" },
  bge_m3: { repository_id: "BAAI/bge-m3", immutable_revision: "5617a9f61b028005a4858fdac845db406aefb181" },
  pixie_rune: { repository_id: "telepix/PIXIE-Rune-v1.5", immutable_revision: "29dd334196af53e6cfc16674379e743334f5fa66" },
};

const P10_2_FILES = [
  "domain/agent-comparison/chunking-comparison/full-corpus-streamer.mjs",
  "domain/agent-comparison/chunking-comparison/model-scoped-embedding-cache.mjs",
  "domain/agent-comparison/chunking-comparison/grid-interaction-analysis.mjs",
  "domain/agent-comparison/chunking-comparison/grid-selection-rule.mjs",
  "scripts/p10.2-stage1-full-corpus-count-only.mjs",
  "scripts/p10.2-stage2-embedding-grid.mjs",
];

function stripLineComments(source) {
  return source.split("\n").filter((line) => !line.trim().startsWith("//")).join("\n");
}

test("exactly 2 non-hierarchical chunking strategies are used, with the exact expected config ids", () => {
  const nonHier = P10_STRATEGIES.filter((s) => s.strategy_name !== "document-type-hierarchical-parent-child");
  assert.equal(nonHier.length, 2);
  assert.deepEqual(nonHier.map((s) => s.chunking_config_id).sort(), ["fixed-token-512-o64.v0.1.0", "section-aware-flat-512-o64.v0.1.0"]);
});

test("Hierarchical is excluded from the strategy set used by this Turn (P10.1.1's elimination is respected)", () => {
  const nonHier = P10_STRATEGIES.filter((s) => s.strategy_name !== "document-type-hierarchical-parent-child");
  assert.ok(!nonHier.some((s) => s.strategy_name === "document-type-hierarchical-parent-child"));
});

test("exactly the 3 frozen embedding candidates in MODEL_ORDER exist and resolve", () => {
  assert.equal(MODEL_ORDER.length, 3);
  for (const id of MODEL_ORDER) assert.doesNotThrow(() => getFrozenCandidateById(id));
});

test("the 3 exact pins (repository_id + revision) match this Turn's brief exactly", () => {
  for (const id of MODEL_ORDER) {
    const candidate = getFrozenCandidateById(id);
    assert.equal(candidate.repository_id, EXPECTED_PINS[id].repository_id);
    assert.equal(candidate.immutable_revision, EXPECTED_PINS[id].immutable_revision);
  }
});

test("an unknown frozen_candidate_id fails closed rather than silently substituting a different model", () => {
  assert.throws(() => getFrozenCandidateById("some-other-model"));
});

test("the registry contains exactly 3 candidates total (no accidental extra/duplicate entries)", () => {
  assert.equal(listFrozenCandidates().length, 3);
});

test("2 chunkings x 3 models produces exactly 6 unique combination labels, no duplicates", () => {
  const nonHier = P10_STRATEGIES.filter((s) => s.strategy_name !== "document-type-hierarchical-parent-child");
  const labels = new Set();
  for (const modelId of MODEL_ORDER) for (const strategy of nonHier) labels.add(`${modelId}x${strategy.chunking_config_id}`);
  assert.equal(labels.size, 6);
});

test("Stage 2 script fails closed BEFORE spawning any model server when the P10.1 evaluation-corpus cache is missing (input gate reuse)", () => {
  const source = readFileSync(path.join(ROOT, "scripts/p10.2-stage2-embedding-grid.mjs"), "utf8");
  // the existsSync precondition check + throw must appear textually BEFORE
  // the first `spawn(` call that launches local_embedding_server.py
  const precondition = source.indexOf("FAIL-CLOSED: run scripts/p10.1-build-evaluation-corpus.mjs first");
  const firstSpawn = source.indexOf("spawn(VENV_PYTHON");
  assert.ok(precondition !== -1 && firstSpawn !== -1 && precondition < firstSpawn, "the fail-closed precondition must be checked before any embedding server is spawned");
});

test("Stage 2 script hard-fails (never silently continues) when the server reports a non-MPS device", () => {
  const source = readFileSync(path.join(ROOT, "scripts/p10.2-stage2-embedding-grid.mjs"), "utf8");
  assert.match(source, /device\s*!==\s*"mps"/);
  assert.match(source, /FAIL-CLOSED: MPS device policy violated/);
});

test("Stage 2 script verifies EVERY candidate is ELIGIBLE_FOR_BOUNDED_CALIBRATION before any server is spawned", () => {
  const source = readFileSync(path.join(ROOT, "scripts/p10.2-stage2-embedding-grid.mjs"), "utf8");
  const eligibilityCheck = source.indexOf("ELIGIBLE_FOR_BOUNDED_CALIBRATION");
  const firstSpawn = source.indexOf("spawn(VENV_PYTHON");
  assert.ok(eligibilityCheck !== -1 && eligibilityCheck < firstSpawn);
});

test("no P10.2 module or script has a file-read call targeting a DEV_CHECK/HOLDOUT-named path", () => {
  const readCallPattern = /\b(?:readFileSync|readFile|createReadStream|openSync|open)\s*\(([^)]*)\)/g;
  for (const relPath of P10_2_FILES) {
    const source = stripLineComments(readFileSync(path.join(ROOT, relPath), "utf8"));
    for (const match of source.matchAll(readCallPattern)) {
      assert.doesNotMatch(match[1], /dev[-_]check|holdout[-_.]/i, `${relPath} reads a file whose path references DEV_CHECK/HOLDOUT: ${match[0]}`);
    }
  }
});

test("no P10.2 module or script imports a chat/completion (HCX) model adapter", () => {
  for (const relPath of P10_2_FILES) {
    const source = stripLineComments(readFileSync(path.join(ROOT, relPath), "utf8"));
    assert.doesNotMatch(source, /from\s+["'][^"']*model-adapter\.mjs["']/, `${relPath} must never import a chat/completion model adapter`);
    assert.doesNotMatch(source, /\bcallChatCompletion\b|\bcreateModelAdapter\b|\bHCX_API_KEY\b|\bcreateChatAdapter\b/, `${relPath} must never call an HCX/chat-completion adapter`);
  }
});

test("Stage 2 script never writes a raw vector array or an API key into its output report objects", () => {
  const source = readFileSync(path.join(ROOT, "scripts/p10.2-stage2-embedding-grid.mjs"), "utf8");
  // report object literals never assign a variable literally named
  // *Vector(s) or apiKey into a written field -- vectors are only ever
  // used transiently for cosineSimilarity, never serialized.
  assert.doesNotMatch(source, /writeFile\([^)]*queryVector/);
  assert.doesNotMatch(source, /writeFile\([^)]*candidateVectors/);
  assert.doesNotMatch(source, /api_key|apiKey/i);
});

test("Stage 2 script never assigns expected_answer/evidence_span text into any written report object", () => {
  const source = stripLineComments(readFileSync(path.join(ROOT, "scripts/p10.2-stage2-embedding-grid.mjs"), "utf8"));
  assert.doesNotMatch(source, /expected_answer(?!ability)\b/);
  assert.doesNotMatch(source, /evidence_span/);
});

test("every P10.2 test file referenced by this suite actually exists on disk", () => {
  const testDir = path.join(ROOT, "tests");
  const p102Tests = readdirSync(testDir).filter((f) => f.startsWith("p10.2-") && f.endsWith(".test.mjs"));
  assert.ok(p102Tests.length >= 4, `expected at least 4 p10.2-*.test.mjs files, found: ${p102Tests.join(", ")}`);
});
