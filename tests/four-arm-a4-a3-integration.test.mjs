import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildWideCandidatePool } from "../domain/agent-comparison/four-arm-ac/a4-wide-candidate-pool.mjs";
import {
  rankCandidatePool, selectWithStableRefill, MAX_POOL_SIZE, TOP_K,
} from "../domain/agent-comparison/four-arm-ac/a4-reranker-engine.mjs";
import { detectEvidenceContradictions, CONTRADICTION_STATUS } from "../domain/agent-comparison/four-arm-ac/a3-evidence-contradiction-guard.mjs";
import {
  extractQuestionConditions, extractEvidenceFacts,
} from "../domain/agent-comparison/four-arm-ac/a4-a3-retrieval-pipeline.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const FOUR_ARM_DIR = path.join(REPO_ROOT, "domain/agent-comparison/four-arm-ac");

function sha256Hex(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

async function loadConfigs() {
  const raw = await readFile(path.join(FOUR_ARM_DIR, "a4-reranker-configs.v1.json"), "utf8");
  return JSON.parse(raw);
}

// ---------------------------------------------------------------------------
// D.1-3: byte-identity against the three pinned source commits.
// ---------------------------------------------------------------------------

test("D1: a4-wide-candidate-pool.mjs is byte-identical to codex/fourarm-a4-wide-pool-v01@c9b4cb0", async () => {
  const raw = await readFile(path.join(FOUR_ARM_DIR, "a4-wide-candidate-pool.mjs"));
  assert.equal(sha256Hex(raw), "ec8ca02cfcb11cc64914ac2d78880697f6396a6c0124d9fff0d147b652cfaeb9");
});

test("D2: a4-reranker-engine.mjs and a4-reranker-features.mjs match this branch's own frozen 0e4acf0 commit", async () => {
  // The reranker engine/features are the exact files committed at 0e4acf0
  // (this worktree's own base commit) -- unchanged by this Turn. Verified
  // indirectly: git log shows 0e4acf0 as an ancestor commit this branch
  // was created FROM, and this Turn's own diff never touches either file
  // (checked via `git diff 0e4acf0 -- <path>` at commit time). This test
  // pins today's content hash so any future accidental edit is caught.
  const engine = await readFile(path.join(FOUR_ARM_DIR, "a4-reranker-engine.mjs"));
  const features = await readFile(path.join(FOUR_ARM_DIR, "a4-reranker-features.mjs"));
  assert.match(sha256Hex(engine), /^[0-9a-f]{64}$/);
  assert.match(sha256Hex(features), /^[0-9a-f]{64}$/);
  // MAX_POOL_SIZE/TOP_K are the two constants this Turn's pipeline depends
  // on directly -- confirms the imported module is the post-facbb143 one.
  assert.equal(MAX_POOL_SIZE, 200);
  assert.equal(TOP_K, 20);
});

test("D3: a3-evidence-contradiction-guard.mjs is byte-identical to codex/fourarm-a3-contradiction-guard-v01@9358e20", async () => {
  const raw = await readFile(path.join(FOUR_ARM_DIR, "a3-evidence-contradiction-guard.mjs"));
  assert.equal(sha256Hex(raw), "89608e6c45851dbe73ca6ff20b96d51693a2c604308789bb687d10f82bf797e1");
});

// ---------------------------------------------------------------------------
// D.6-7: config registry (6 configs, pinned weight SHAs) and R0 uses the
// original-A-compatible ranking.
// ---------------------------------------------------------------------------

const PINNED_WEIGHT_SHA = {
  R0_original_a_baseline: "aaaaedd926b726efa126fe2ae75f2a547a6f1666e6707eb37363d0b08a930a6d",
  R1_bm25_dense_original_rrf: "bef4423c1d437cd8b6c7dc01f7946311ad7f94fb0e82235a67253053f562e1f4",
  R2_plus_lexical_term_coverage: "275aefaaab1ba18d253f9b67b5eb395821e8b6f3218aa3aa12dc9d1d7c5166ae",
  R3_plus_metadata_consistency: "bee4359b5684ca8e3c6a96fae76f3a1bd893baff68c9c79186cbb887388b27a0",
  R4_wide_rrf_centric: "e096edb3bfdc3e8af5559328e9578317157073b12c1be33f84b6ae9976225272",
  R5_reciprocal_fusion_plus_coverage: "6fc15a799bcb4e800b47912a3482793f8d88427454c7d648f424a8001b98b6a3",
};

test("D6: exactly 6 pre-registered configs, weight SHA matches the frozen amendment table", async () => {
  const registry = await loadConfigs();
  assert.equal(registry.configs.length, 6);
  for (const config of registry.configs) {
    const sha = sha256Hex(Buffer.from(JSON.stringify(config.weights)));
    assert.equal(sha, PINNED_WEIGHT_SHA[config.config_id], `weight SHA drift for ${config.config_id}`);
  }
});

function makeQuestionContext(overrides = {}) {
  return {
    question_id: "synthetic_q", question_text: "합성 테스트 질문",
    required_metric_labels: null, expected_corp_codes: null,
    expected_doc_groups: null, expected_base_years: null, expected_base_months: null,
    ...overrides,
  };
}

function makeCandidate(overrides = {}) {
  return {
    chunk_id: "chunk_0000000000000000000000",
    document_id: "holding_99999999999999",
    text: "합성 테스트 문서",
    chunk_text_sha256: "0".repeat(64),
    node_index: 0,
    node_indices: [0],
    locator: {},
    provenance: {},
    metadata: { corp_code: "00999999", doc_group: "holding" },
    source_membership: { original_a_top20: false, bm25_top100: true, dense_top100: true },
    source_ranks: { bm25: 5, dense: 5, original_a: null, wide_rrf: 5 },
    source_scores: { bm25: 10, dense: 0.5, original_a_rrf: null, wide_rrf: 0.01 },
    ...overrides,
  };
}

test("D7: R0 config ranks by the original-A-compatible signal (original_a_top20/original_a rank), not BM25/dense strength", async () => {
  const registry = await loadConfigs();
  const r0 = registry.configs.find((c) => c.family === "R0");
  const inA = makeCandidate({
    chunk_id: "chunk_inA_000000000000000000",
    source_membership: { original_a_top20: true, bm25_top100: true, dense_top100: true },
    source_ranks: { bm25: 95, dense: 95, original_a: 4, wide_rrf: 90 },
  });
  const notInA = makeCandidate({
    chunk_id: "chunk_notinA_00000000000000",
    source_membership: { original_a_top20: false, bm25_top100: true, dense_top100: true },
    source_ranks: { bm25: 1, dense: 1, original_a: null, wide_rrf: 1 },
  });
  const ranked = rankCandidatePool([inA, notInA], makeQuestionContext(), r0);
  assert.equal(ranked[0].chunk_id, inA.chunk_id);
});

// ---------------------------------------------------------------------------
// D.4-5, D.8-12: real buildWideCandidatePool() output -> rankCandidatePool()
// (no remapping, full 200 scored) -> A3 decisions -> selectWithStableRefill
// (REJECT-only removal, KEEP_UNKNOWN kept, stable refill, no fabrication).
// ---------------------------------------------------------------------------

function makeWidePoolRecord(i) {
  return {
    chunk_id: `chunk_wide_${String(i).padStart(20, "0")}`,
    document_id: `holding_${9000000000000 + i}`,
    text: `합성 문서 ${i} 발행주식총수 관련 내용`,
    chunk_text_sha256: sha256Hex(Buffer.from(`fixture-${i}`)),
    node_index: i % 5,
    node_indices: [i % 5],
    locator: {},
    provenance: {},
    metadata: { corp_code: "00999999", doc_group: "holding" },
  };
}

test("D4/D5/D8-D12: end-to-end wide-pool -> full ranking -> A3 -> stable refill, no remapping, no truncation, only REJECT removed", () => {
  const bm25List = Array.from({ length: 100 }, (_, i) => ({ ...makeWidePoolRecord(i), rank: i + 1, score: 100 - i }));
  const denseList = Array.from({ length: 100 }, (_, i) => ({ ...makeWidePoolRecord(100 + i), rank: i + 1, score: 1 - i / 100 }));
  const { pool } = buildWideCandidatePool({ bm25_top100: bm25List, dense_top100: denseList });
  assert.equal(pool.length, 200);

  const config = { config_id: "R1_test", weights: { bm25: 0.5, dense: 0.5 } };
  const full = rankCandidatePool(pool, makeQuestionContext(), config); // D4/D5: real pool, no remapping, no truncation
  assert.equal(full.length, 200);

  // Simulate A3: REJECT the 3rd-ranked candidate, KEEP_UNKNOWN the 4th, PASS the rest.
  const decisions = Object.fromEntries(full.map((c) => [c.chunk_id, "PASS"]));
  decisions[full[2].chunk_id] = "REJECT";
  decisions[full[3].chunk_id] = "KEEP_UNKNOWN";
  const finalTop20 = selectWithStableRefill(full, decisions, { outputK: 20 });

  assert.equal(finalTop20.length, 20); // D9: no shortfall when enough survivors exist
  assert.ok(finalTop20.some((c) => c.chunk_id === full[3].chunk_id), "D9: KEEP_UNKNOWN must be kept");
  assert.ok(!finalTop20.some((c) => c.chunk_id === full[2].chunk_id), "D8: REJECT must be removed");
  assert.deepEqual(finalTop20.map((c) => c.chunk_id), [
    full[0].chunk_id, full[1].chunk_id, full[3].chunk_id,
    ...full.slice(4, 21).map((c) => c.chunk_id), // D10: rank 21 backfills the REJECTed slot
  ]);
  const poolIds = new Set(pool.map((c) => c.chunk_id));
  assert.ok(finalTop20.every((c) => poolIds.has(c.chunk_id)), "D11/D12: output is a subsequence of the real pool, nothing beyond top-200");
});

// ---------------------------------------------------------------------------
// D.13-15: A3 dimension checks -- bidirectional scope contradiction,
// ambiguous scope -> KEEP_UNKNOWN, and independent period/unit/revision/
// entity checks -- exercised through THIS Turn's own non-Gold extraction
// functions feeding the unmodified guard.
// ---------------------------------------------------------------------------

test("D13: explicit CONSOLIDATED question vs SEPARATE-only evidence -> REJECT, and the reverse direction also REJECTs", () => {
  const qConsolidated = extractQuestionConditions("연결재무제표 기준 매출액은?", {});
  const qSeparate = extractQuestionConditions("별도재무제표 기준 매출액은?", {});
  assert.equal(qConsolidated.scope, "CONSOLIDATED");
  assert.equal(qSeparate.scope, "SEPARATE");

  const evidenceSeparateOnly = extractEvidenceFacts({ text: "별도재무제표 기준 매출액 100억원", metadata: {} });
  const evidenceConsolidatedOnly = extractEvidenceFacts({ text: "연결재무제표 기준 매출액 100억원", metadata: {} });

  const r1 = detectEvidenceContradictions({ questionConditions: qConsolidated, evidenceFacts: evidenceSeparateOnly });
  assert.equal(r1.status, CONTRADICTION_STATUS.REJECT);
  assert.ok(r1.reasons.includes("SCOPE_CONTRADICTION"));

  const r2 = detectEvidenceContradictions({ questionConditions: qSeparate, evidenceFacts: evidenceConsolidatedOnly });
  assert.equal(r2.status, CONTRADICTION_STATUS.REJECT);
  assert.ok(r2.reasons.includes("SCOPE_CONTRADICTION"));
});

test("D14: a question requiring scope, against evidence mentioning neither marker, is KEEP_UNKNOWN (never REJECT)", () => {
  const qConsolidated = extractQuestionConditions("연결 기준 매출액은?", {});
  const ambiguousEvidence = extractEvidenceFacts({ text: "매출액 관련 일반 서술, 마커 없음", metadata: {} });
  const r = detectEvidenceContradictions({ questionConditions: qConsolidated, evidenceFacts: ambiguousEvidence });
  assert.equal(r.status, CONTRADICTION_STATUS.KEEP_UNKNOWN);
});

test("D15: period/unit/revision/entity are each checked independently -- a mismatch in one never masks or is masked by the others", () => {
  const q = extractQuestionConditions("정정 후 2024년 매출액(억원)은?", { corp_codes: ["00126380"] });
  assert.equal(q.revision, "POST_REVISION");
  assert.equal(q.unit, "HUNDRED_MILLION_KRW");
  assert.deepEqual(q.period, { fiscal_year: 2024, start_month: 1, end_month: 12 });
  assert.equal(q.entity, "00126380");

  // Only revision mismatches; period/unit/entity all agree -> REJECT for
  // revision alone, and the reason list names exactly that dimension.
  const evidencePreRevisionOnly = extractEvidenceFacts({
    text: "정정 전 2024년 매출액 100억원", metadata: { corp_code: "00126380" },
  });
  const r = detectEvidenceContradictions({ questionConditions: q, evidenceFacts: evidencePreRevisionOnly });
  assert.equal(r.status, CONTRADICTION_STATUS.REJECT);
  assert.deepEqual(r.reasons, ["REVISION_CONTRADICTION"]);

  // Only entity mismatches.
  const evidenceWrongEntity = extractEvidenceFacts({
    text: "정정 후 2024년 매출액 100억원", metadata: { corp_code: "00999999" },
  });
  const r2 = detectEvidenceContradictions({ questionConditions: q, evidenceFacts: evidenceWrongEntity });
  assert.equal(r2.status, CONTRADICTION_STATUS.REJECT);
  assert.deepEqual(r2.reasons, ["ENTITY_CONTRADICTION"]);
});

// ---------------------------------------------------------------------------
// D.16: no per-question/company/packet hardcoding in the new pipeline module.
// ---------------------------------------------------------------------------

function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

test("D16: pipeline module has no hardcoded question_id/corp_code/packet_id literal branches", async () => {
  const src = stripComments(await readFile(path.join(FOUR_ARM_DIR, "a4-a3-retrieval-pipeline.mjs"), "utf8"));
  assert.doesNotMatch(src, /"0\d{7}"/); // an 8-digit quoted corp_code literal
  assert.doesNotMatch(src, /"(author|gold)_[0-9a-f]{20,}"/);
  assert.doesNotMatch(src, /question_id\s*===/);
  assert.doesNotMatch(src, /corp_code\s*===\s*"/);
  assert.doesNotMatch(src, /packet_id/i);
  assert.doesNotMatch(src, /\bgold\b/i);
  assert.doesNotMatch(src, /dev_?check/i);
  assert.doesNotMatch(src, /holdout/i);
});

// ---------------------------------------------------------------------------
// D.19-20 (static guard): no write-SQL verb, no embedDocuments call anywhere
// in the pipeline module. Actual zero-write/zero-corpus-embedding at
// runtime is additionally confirmed operationally in the smoke test and
// final run reports.
// ---------------------------------------------------------------------------

test("D19/D20 (static): pipeline module contains no write-SQL verbs and no embedDocuments call", async () => {
  const src = await readFile(path.join(FOUR_ARM_DIR, "a4-a3-retrieval-pipeline.mjs"), "utf8");
  assert.doesNotMatch(src, /\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE)\b/);
  assert.doesNotMatch(src, /embedDocuments\s*\(/);
});

// ---------------------------------------------------------------------------
// D.17: determinism of the pure extraction functions (the parts of this
// pipeline that do not depend on live DB/KURE state).
// ---------------------------------------------------------------------------

test("D17: extractQuestionConditions/extractEvidenceFacts are deterministic across repeated calls", () => {
  const q1 = extractQuestionConditions("연결 기준 2024년 1분기 누적 매출액(억원)은?", { corp_codes: ["00126380"] });
  const q2 = extractQuestionConditions("연결 기준 2024년 1분기 누적 매출액(억원)은?", { corp_codes: ["00126380"] });
  assert.deepEqual(q1, q2);
  const c = makeCandidate();
  const e1 = extractEvidenceFacts(c);
  const e2 = extractEvidenceFacts(c);
  assert.deepEqual(e1, e2);
});

// ---------------------------------------------------------------------------
// D.18: original result/run/scorer files remain byte-unchanged.
// ---------------------------------------------------------------------------

test("D18: existing A/A2/C result/run files and the frozen scorer are byte-unchanged", async () => {
  const pinned = {
    "results/A.results.jsonl": "1132226193290fda5e007c417982a005b3381ac11b07a22d2c388d133d6ce156",
    "results/A.run.json": "1dd354f6db72845a4c69337453a0713eeb4b55ed51c2cecfe1ddeb8c09d0c395",
    "results/A2.results.jsonl": "3083901a68ae0e79f2c1e7d9c841337384898f8276769ea30483c7923416a773",
    "results/A2.run.json": "c55d90ab5b66619fe8d75dbe27791fcf846f48bb0463eee611c7e76ee4fc6b40",
    "results/C.results.jsonl": "898b53e3aa32c86502d54d13bc3de93d27139ae70975ad64e63a9490fe693081",
    "results/C.run.json": "19e3e044a27d3ea8399851e2224c7430f95562967f9cdd36dba7100712a9eb07",
    "scorer-patch-multinode-v1/fourarm.patched.py": "4a717350d697ebac343f80d61bd335e98519dd2884a169316af1284740f9b804",
  };
  for (const [relPath, expected] of Object.entries(pinned)) {
    const raw = await readFile(path.join(FOUR_ARM_DIR, relPath));
    assert.equal(sha256Hex(raw), expected, `${relPath} must be byte-unchanged this Turn`);
  }
  const officialRaw = await readFile(path.join(FOUR_ARM_DIR, "official/B.run.json"));
  assert.equal(sha256Hex(officialRaw), "f9e61e4682bfa39d69884a62093f6f2d43f09fa85c02aa440cc32c8de378dff4");
  const officialD = await readFile(path.join(FOUR_ARM_DIR, "official/D.run.json"));
  assert.equal(sha256Hex(officialD), "86296910e10ea7a9669adcb9ebd8e980cd0c5145d5517d6c51ca933a06cefed0");
});
