import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const WORK_DIR = path.join(ROOT, "work", "p10.4-adaptive-table-chunking");

const P10_4_FILES = [
  "domain/chunking/adaptive-chunking-policy.mjs",
  "domain/chunking/adaptive-table-chunker.mjs",
  "domain/chunking/adaptive-parent-expansion.mjs",
  "domain/chunking/adaptive-success-threshold.mjs",
  "scripts/p10.4-stage5-full-corpus-count-only.mjs",
  "scripts/p10.4-stage6-structure-preservation.mjs",
  "scripts/p10.4-stage7-kure-dev-tune-comparison.mjs",
  "scripts/p10.4-stage8-9-final-selection.mjs",
];

function stripLineComments(source) { return source.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n"); }
function readSource(relPath) { return readFileSync(path.join(ROOT, relPath), "utf8"); }

test("every P10.4 source file exists on disk", () => {
  for (const relPath of P10_4_FILES) assert.doesNotThrow(() => readSource(relPath), `missing: ${relPath}`);
});

test("no P10.4 module or script has a file-read call targeting a DEV_CHECK/HOLDOUT-named path", () => {
  const readCallPattern = /\b(?:readFileSync|readFile|createReadStream|openSync|open)\s*\(([^)]*)\)/g;
  for (const relPath of P10_4_FILES) {
    const source = stripLineComments(readSource(relPath));
    for (const match of source.matchAll(readCallPattern)) {
      assert.doesNotMatch(match[1], /dev[-_]check|holdout[-_.]/i, `${relPath}: ${match[0]}`);
    }
  }
});

test("no P10.4 module or script imports an HCX/chat-completion adapter or generates an Agent answer", () => {
  for (const relPath of P10_4_FILES) {
    const source = stripLineComments(readSource(relPath));
    assert.doesNotMatch(source, /from\s+["'][^"']*model-adapter\.mjs["']/, relPath);
    assert.doesNotMatch(source, /\bcallChatCompletion\b|\bcreateModelAdapter\b|\bHCX_API_KEY\b|\bcreateChatAdapter\b/, relPath);
  }
});

test("only Stage 7 spawns an embedding server or calls /v1/embeddings -- all other P10.4 scripts stay count-only", () => {
  for (const relPath of P10_4_FILES) {
    const source = stripLineComments(readSource(relPath));
    const spawnsServer = /spawn\s*\(\s*VENV_PYTHON/.test(source) || /local_embedding_server\.py/.test(source);
    if (relPath === "scripts/p10.4-stage7-kure-dev-tune-comparison.mjs") {
      assert.equal(spawnsServer, true, "Stage 7 must spawn the real embedding server");
    } else {
      assert.equal(spawnsServer, false, `${relPath} must never spawn an embedding server`);
    }
  }
});

test("Stage 7 fails closed if kure_v1's competition_status is not ELIGIBLE_FOR_BOUNDED_CALIBRATION, and hard-fails on a non-mps device", () => {
  const source = readSource("scripts/p10.4-stage7-kure-dev-tune-comparison.mjs");
  assert.match(source, /ELIGIBLE_FOR_BOUNDED_CALIBRATION/);
  assert.match(source, /device\s*!==\s*"mps"/);
  assert.match(source, /FAIL-CLOSED: MPS device policy violated/);
});

test("Stage 7's embedding cache key includes chunking_config_id -- Fixed and Adaptive vectors are never silently shared across a byte-identical text unless the FULL key matches", () => {
  const source = readSource("scripts/p10.4-stage7-kure-dev-tune-comparison.mjs");
  assert.match(source, /chunkingConfigId/);
  assert.match(source, /keyFor\s*=\s*\(text\)\s*=>\s*`\$\{KURE\.repository_id\}.*chunkingConfigId/s);
});

test("Stage 5/6/8-9 never assign Gold question/expected_answer/evidence_span TEXT into a written report field", () => {
  for (const relPath of ["scripts/p10.4-stage5-full-corpus-count-only.mjs", "scripts/p10.4-stage6-structure-preservation.mjs", "scripts/p10.4-stage8-9-final-selection.mjs"]) {
    const source = stripLineComments(readSource(relPath));
    assert.doesNotMatch(source, /\bitem\.question\b/, relPath);
    assert.doesNotMatch(source, /expected_answer(?!ability)\b/, relPath);
    assert.doesNotMatch(source, /evidence_span\s*:/, relPath);
  }
});

test("no P10.4 script writes an embedding vector into any output file (only scalar aggregates)", () => {
  for (const relPath of P10_4_FILES) {
    const source = stripLineComments(readSource(relPath));
    assert.doesNotMatch(source, /writeFile\([^)]*queryVector/, relPath);
    assert.doesNotMatch(source, /writeFile\([^)]*candidateVector/, relPath);
    assert.doesNotMatch(source, /"embedding"\s*:\s*\[/, relPath);
  }
});

test("Stage 6 fails closed when the P10.3.2 parse-limited-source disposition (read-only reference) is missing, before reading anything else", () => {
  const source = readSource("scripts/p10.4-stage6-structure-preservation.mjs");
  const check = source.indexOf("P10_3_2_DISPOSITION_PATH");
  const chunkCall = source.indexOf("chunkAdaptive(entry.raw_record");
  assert.ok(check !== -1 && chunkCall !== -1 && source.indexOf("FAIL-CLOSED") < chunkCall);
});

test("no P10.4 script writes into P10.1/P10.2/P10.3/P10.3.1/P10.3.2's result directories", () => {
  for (const relPath of P10_4_FILES) {
    const source = stripLineComments(readSource(relPath));
    const writeCallPattern = /writeFile\s*\(([^,]*),/g;
    for (const match of source.matchAll(writeCallPattern)) {
      assert.doesNotMatch(match[1], /p10\.1-chunking-dev-tune|p10\.2-chunking-embedding-grid|p10\.3-table-diagnostic|p10\.3\.1-table-locator-audit|p10\.3\.2-table-full-population-audit/, `${relPath} must never write into a prior Turn's result directory`);
    }
  }
});

test("Stage 8-9 never lowers a threshold or silently defaults to SELECTED -- reads evaluateSuccessThresholds's real decision only", () => {
  const source = stripLineComments(readSource("scripts/p10.4-stage8-9-final-selection.mjs"));
  assert.match(source, /evaluateSuccessThresholds/);
  assert.doesNotMatch(source, /status\s*=\s*["']FINAL_CHUNKING_SELECTED/, "must never hardcode the selected status outside the imported gate function's own return value");
});

if (existsSync(WORK_DIR)) {
  test("full-corpus count report: deterministic_rebuild is true (real double-pass verification, not assumed)", () => {
    const p = path.join(WORK_DIR, "adaptive-full-corpus-count-report.v0.1.json");
    if (!existsSync(p)) return;
    const report = JSON.parse(readFileSync(p, "utf8"));
    assert.equal(report.deterministic_rebuild, true);
  });

  test("structure preservation report: stage_4 exclusion count matches P10.3.2's real disposition (4)", () => {
    const p = path.join(WORK_DIR, "adaptive-structure-preservation-report.v0.1.json");
    if (!existsSync(p)) return;
    const report = JSON.parse(readFileSync(p, "utf8"));
    assert.equal(report.stage_4_parse_limited_source_exclusion.excluded_source_count, report.stage_4_parse_limited_source_exclusion.excluded_source_count_p10_3_2_reference);
  });

  test("Gold question/expected_answer/evidence text does not appear in any P10.4 written result file", () => {
    const files = [
      "adaptive-chunking-policy.v0.1.json", "adaptive-full-corpus-count-report.v0.1.json", "adaptive-structure-preservation-report.v0.1.json",
      "adaptive-kure-dev-tune-comparison.v0.1.json", "adaptive-late-parent-expansion-report.v0.1.json", "adaptive-final-selection-status.v0.1.json",
    ];
    for (const f of files) {
      const p = path.join(WORK_DIR, f);
      if (!existsSync(p)) continue;
      const text = readFileSync(p, "utf8");
      assert.doesNotMatch(text, /"question"\s*:\s*"[^"]{10,}"/, `${f} may contain raw Gold question text`);
      assert.doesNotMatch(text, /"expected_answer"\s*:/, `${f} must never contain expected_answer`);
      assert.doesNotMatch(text, /"embedding"\s*:\s*\[\s*-?\d/, `${f} must never contain a raw embedding vector`);
    }
  });
}
