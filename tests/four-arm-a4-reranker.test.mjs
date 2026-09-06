import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { extractFeatures, FEATURE_KEYS } from "../domain/agent-comparison/four-arm-ac/a4-reranker-features.mjs";
import {
  rerankCandidates, validateConfig, assertValidConfig, TOP_K, MAX_POOL_SIZE,
} from "../domain/agent-comparison/four-arm-ac/a4-reranker-engine.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const FOUR_ARM_DIR = path.join(REPO_ROOT, "domain/agent-comparison/four-arm-ac");

async function loadConfigs() {
  const raw = await readFile(path.join(FOUR_ARM_DIR, "a4-reranker-configs.v1.json"), "utf8");
  return JSON.parse(raw);
}

function sha256Hex(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

// ---------------------------------------------------------------------------
// Synthetic fixtures only -- no real DEV_TUNE/Gold/A/oracle data anywhere in
// this file.
// ---------------------------------------------------------------------------

function makeCandidate(overrides = {}) {
  return {
    chunk_id: "chunk_synthetic_0000000000000000",
    doc_id: "holding_99999999999999",
    node_index: 3,
    node_indices: [3, 4, 5],
    locator: "holding_99999999999999::99999999999999.xml::n3",
    locator_status: "NODE_AND_ROW_RESOLVED",
    row: null,
    col: null,
    is_table: false,
    text: "합성 테스트 문서 발행주식총수 100000주 관련 내용입니다",
    chunk_text_sha256: "0".repeat(64),
    metadata: {
      corp_code: "00999999",
      doc_group: "holding",
      doc_subtype: "대량보유상황보고서",
      base_year: 2024,
      base_month: 3,
      receipt_date: "2024-03-22",
      is_correction: false,
    },
    scores: {
      bm25: { score: 12.3, rank: 4 },
      dense: { score: 0.71, rank: 6 },
      original_a_rrf: { score: 0.02, rank: 9 },
      wide_rrf: { score: 0.025, rank: 5 },
    },
    in_original_a_top20: false,
    ...overrides,
  };
}

function makeQuestionContext(overrides = {}) {
  return {
    question_id: "synthetic_q_0001",
    question_text: "발행주식총수 관련 합성 테스트 질문입니다",
    required_metric_labels: ["발행주식총수"],
    expected_corp_codes: ["00999999"],
    expected_doc_groups: ["holding"],
    expected_base_years: [2024],
    expected_base_months: [3],
    ...overrides,
  };
}

function makePool(n, factory = makeCandidate) {
  return Array.from({ length: n }, (_, i) => factory({
    chunk_id: `chunk_synthetic_${String(i).padStart(20, "0")}`,
    scores: {
      bm25: { score: 100 - i, rank: i + 1 },
      dense: { score: 1 - i / n, rank: i + 1 },
      original_a_rrf: i < 20 ? { score: 0.03 - i * 0.001, rank: i + 1 } : null,
      wide_rrf: { score: 0.03 - i * 0.0005, rank: i + 1 },
    },
    in_original_a_top20: i < 20,
  }));
}

// ---------------------------------------------------------------------------
// Config registry
// ---------------------------------------------------------------------------

test("config registry: at most 12 pre-registered configs, each valid", async () => {
  const registry = await loadConfigs();
  assert.ok(Array.isArray(registry.configs));
  assert.ok(registry.configs.length <= 12, `expected <=12 configs, found ${registry.configs.length}`);
  assert.ok(registry.configs.length >= 1);
  const ids = new Set();
  for (const config of registry.configs) {
    const errors = validateConfig(config);
    assert.deepEqual(errors, [], `config ${config.config_id} should be valid`);
    assert.equal(ids.has(config.config_id), false, `duplicate config_id ${config.config_id}`);
    ids.add(config.config_id);
  }
});

test("config registry: covers the six pre-registered families R0-R5", async () => {
  const registry = await loadConfigs();
  const families = new Set(registry.configs.map((c) => c.family));
  for (const f of ["R0", "R1", "R2", "R3", "R4", "R5"]) assert.ok(families.has(f), `missing family ${f}`);
});

test("config validation: rejects NaN/Infinity/negative weights and unknown keys (fail-closed)", () => {
  const base = { config_id: "bad", weights: { bm25: 0.5 } };
  assert.deepEqual(validateConfig({ ...base, weights: { bm25: NaN } }).length > 0, true);
  assert.deepEqual(validateConfig({ ...base, weights: { bm25: Infinity } }).length > 0, true);
  assert.deepEqual(validateConfig({ ...base, weights: { bm25: -0.1 } }).length > 0, true);
  assert.deepEqual(validateConfig({ ...base, weights: { not_a_feature: 1 } }).length > 0, true);
  assert.deepEqual(validateConfig({ weights: { bm25: 1 } }).length > 0, true); // missing config_id
  assert.deepEqual(validateConfig(null).length > 0, true);
  assert.deepEqual(validateConfig({ config_id: "ok", weights: { bm25: 1 } }), []);
  assert.throws(() => assertValidConfig({ config_id: "bad", weights: { bm25: NaN } }), RangeError);
});

// ---------------------------------------------------------------------------
// Engine behavior
// ---------------------------------------------------------------------------

const R1 = { config_id: "R1_test", weights: { bm25: 0.35, dense: 0.35, original_rrf: 0.3 } };

test("rerankCandidates: same input produces byte-identical output", () => {
  const pool = makePool(40);
  const qc = makeQuestionContext();
  const out1 = rerankCandidates(structuredClone(pool), structuredClone(qc), R1);
  const out2 = rerankCandidates(structuredClone(pool), structuredClone(qc), R1);
  assert.equal(JSON.stringify(out1), JSON.stringify(out2));
});

test("rerankCandidates: output is a stable subset of the input pool, max top-20", () => {
  const pool = makePool(60);
  const out = rerankCandidates(pool, makeQuestionContext(), R1);
  assert.ok(out.length <= TOP_K);
  const inputIds = new Set(pool.map((c) => c.chunk_id));
  for (const item of out) assert.ok(inputIds.has(item.chunk_id), `output chunk_id ${item.chunk_id} not in input pool`);
  const outputIds = out.map((c) => c.chunk_id);
  assert.equal(new Set(outputIds).size, outputIds.length, "output must not repeat a chunk_id");
});

test("rerankCandidates: never fabricates a candidate beyond the input pool", () => {
  const pool = makePool(15);
  const out = rerankCandidates(pool, makeQuestionContext(), R1);
  assert.equal(out.length, 15); // fewer than 20 available -> output is exactly the pool, reordered
  const inputIds = new Set(pool.map((c) => c.chunk_id));
  assert.ok(out.every((c) => inputIds.has(c.chunk_id)));
});

test("rerankCandidates: refuses a pool larger than the top-100 ceiling", () => {
  const pool = makePool(MAX_POOL_SIZE + 1);
  assert.throws(() => rerankCandidates(pool, makeQuestionContext(), R1), RangeError);
});

test("rerankCandidates: exactly top-100 is accepted", () => {
  const pool = makePool(MAX_POOL_SIZE);
  const out = rerankCandidates(pool, makeQuestionContext(), R1);
  assert.equal(out.length, TOP_K);
});

test("rerankCandidates: does not mutate input candidate objects", () => {
  const pool = makePool(5).map((c) => Object.freeze({ ...c, scores: Object.freeze({ ...c.scores }), metadata: Object.freeze({ ...c.metadata }) }));
  const before = JSON.parse(JSON.stringify(pool));
  assert.doesNotThrow(() => rerankCandidates(pool, makeQuestionContext(), R1));
  assert.deepEqual(JSON.parse(JSON.stringify(pool)), before);
});

test("rerankCandidates: candidates with missing/sparse fields are scored, never dropped", () => {
  const sparse = makeCandidate({
    chunk_id: "chunk_sparse_0000000000000000",
    text: null,
    metadata: null,
    row: null,
    col: null,
    is_table: null,
    locator_status: null,
    scores: { bm25: null, dense: { score: 0.5, rank: 3 }, original_a_rrf: null, wide_rrf: { score: 0.01, rank: 10 } },
  });
  const pool = [sparse, ...makePool(3)];
  const out = rerankCandidates(pool, makeQuestionContext(), R1);
  assert.ok(out.some((c) => c.chunk_id === sparse.chunk_id), "sparse candidate must survive into the output");
  const features = out.find((c) => c.chunk_id === sparse.chunk_id).features;
  assert.equal(features.bm25, 0); // legitimate absence, not neutral
  assert.equal(features.lexical_overlap, 0.5); // missing text -> neutral
  assert.equal(features.metadata_match, 0.5); // missing metadata -> neutral
  assert.equal(features.table_context, 0.5);
  assert.equal(features.provenance_completeness, 0.5);
});

test("rerankCandidates: BM25-only and dense-only candidates are both handled without error", () => {
  const bm25Only = makeCandidate({
    chunk_id: "chunk_bm25only_000000000000000",
    scores: { bm25: { score: 40, rank: 1 }, dense: null, original_a_rrf: null, wide_rrf: { score: 0.016, rank: 1 } },
  });
  const denseOnly = makeCandidate({
    chunk_id: "chunk_denseonly_00000000000000",
    scores: { bm25: null, dense: { score: 0.9, rank: 1 }, original_a_rrf: null, wide_rrf: { score: 0.016, rank: 2 } },
  });
  const out = rerankCandidates([bm25Only, denseOnly], makeQuestionContext(), R1);
  assert.equal(out.length, 2);
  const f1 = extractFeatures(bm25Only, makeQuestionContext());
  const f2 = extractFeatures(denseOnly, makeQuestionContext());
  assert.equal(f1.dense, 0);
  assert.ok(f1.bm25 > 0);
  assert.equal(f2.bm25, 0);
  assert.ok(f2.dense > 0);
});

test("original-A protective signal: R0 config keeps an original-top20 candidate above a non-top20 candidate with a stronger BM25/dense score", async () => {
  const registry = await loadConfigs();
  const r0 = registry.configs.find((c) => c.family === "R0");
  const inTop20 = makeCandidate({
    chunk_id: "chunk_intop20_0000000000000000",
    in_original_a_top20: true,
    scores: { bm25: { score: 1, rank: 90 }, dense: { score: 0.1, rank: 90 }, original_a_rrf: { score: 0.02, rank: 5 }, wide_rrf: { score: 0.005, rank: 80 } },
  });
  const notInTop20 = makeCandidate({
    chunk_id: "chunk_nottop20_0000000000000000",
    in_original_a_top20: false,
    scores: { bm25: { score: 99, rank: 1 }, dense: { score: 0.99, rank: 1 }, original_a_rrf: null, wide_rrf: { score: 0.03, rank: 1 } },
  });
  const out = rerankCandidates([inTop20, notInTop20], makeQuestionContext(), r0);
  assert.equal(out[0].chunk_id, inTop20.chunk_id, "R0 (original-A-priority) must rank the original top-20 candidate first despite weaker BM25/dense");
});

test("tie-break: reranker_score ties fall through to in_original_a_top20, then original_a_rank, then wide_rrf_rank, then chunk_id", () => {
  const zeroWeights = { config_id: "zero", weights: {} }; // every feature weight 0 -> every candidate scores exactly 0
  const a = makeCandidate({ chunk_id: "chunk_zzz", in_original_a_top20: false, scores: { bm25: null, dense: null, original_a_rrf: null, wide_rrf: { score: 0, rank: 5 } } });
  const b = makeCandidate({ chunk_id: "chunk_aaa", in_original_a_top20: true, scores: { bm25: null, dense: null, original_a_rrf: { score: 0, rank: 3 }, wide_rrf: { score: 0, rank: 9 } } });
  const c = makeCandidate({ chunk_id: "chunk_bbb", in_original_a_top20: true, scores: { bm25: null, dense: null, original_a_rrf: { score: 0, rank: 1 }, wide_rrf: { score: 0, rank: 2 } } });
  const out = rerankCandidates([a, b, c], makeQuestionContext(), zeroWeights);
  // c: top20=true, original_a_rank=1 -- must win over b (top20=true, rank=3) and a (top20=false).
  assert.deepEqual(out.map((x) => x.chunk_id), ["chunk_bbb", "chunk_aaa", "chunk_zzz"]);
});

test("tie-break: final tiebreaker is chunk_id bytewise ascending when everything else ties", () => {
  const zeroWeights = { config_id: "zero", weights: {} };
  const candidates = ["chunk_c", "chunk_a", "chunk_b"].map((id) => makeCandidate({
    chunk_id: id, in_original_a_top20: false,
    scores: { bm25: null, dense: null, original_a_rrf: null, wide_rrf: null },
  }));
  const out = rerankCandidates(candidates, makeQuestionContext(), zeroWeights);
  assert.deepEqual(out.map((x) => x.chunk_id), ["chunk_a", "chunk_b", "chunk_c"]);
});

test("multi-node provenance is preserved unchanged through reranking", () => {
  const candidate = makeCandidate({
    chunk_id: "chunk_multinode_00000000000000",
    node_index: 2,
    node_indices: [2, 3, 4, 5, 6, 7],
    locator_status: "MULTI_NODE_AMBIGUOUS",
  });
  const out = rerankCandidates([candidate, ...makePool(3)], makeQuestionContext(), R1);
  const found = out.find((c) => c.chunk_id === candidate.chunk_id);
  assert.deepEqual(found.node_indices, [2, 3, 4, 5, 6, 7]);
  assert.equal(found.node_index, 2);
  assert.equal(found.locator_status, "MULTI_NODE_AMBIGUOUS");
});

test("no per-question special-casing: identical candidates under two different question_ids score identically", () => {
  const pool = makePool(5);
  const outA = rerankCandidates(pool, makeQuestionContext({ question_id: "synthetic_q_A" }), R1);
  const outB = rerankCandidates(pool, makeQuestionContext({ question_id: "synthetic_q_B" }), R1);
  assert.deepEqual(outA.map((c) => ({ chunk_id: c.chunk_id, score: c.reranker_score })),
    outB.map((c) => ({ chunk_id: c.chunk_id, score: c.reranker_score })));
});

test("feature extraction: every feature is finite and in [0,1] across a randomized synthetic pool", () => {
  const pool = makePool(30);
  const qc = makeQuestionContext();
  for (const candidate of pool) {
    const features = extractFeatures(candidate, qc);
    for (const key of FEATURE_KEYS) {
      assert.equal(typeof features[key], "number");
      assert.ok(Number.isFinite(features[key]), `${key} must be finite`);
      assert.ok(features[key] >= 0 && features[key] <= 1, `${key}=${features[key]} out of [0,1]`);
    }
  }
});

// ---------------------------------------------------------------------------
// Isolation guarantees: no Gold, no A3 Guard, no QA, no DB, no KURE, no
// hardcoded packet/company ids anywhere in the engine or feature source.
// ---------------------------------------------------------------------------

const FORBIDDEN_PATTERNS = [
  /gold/i,
  /acceptable_sources/i,
  /evidence_span/i,
  /expected_answer/i,
  /contradiction[-_]?guard/i,
  /a3[-_]guard/i,
  /dev_?check/i,
  /holdout/i,
  /\bpg\b/,
  /node:pg/,
  /reference-vector-retrieval/i,
  /embedding-adapter/i,
  /bm25Search\s*\(/, // no live BM25 index calls -- only reads pre-computed scores/ranks
  /createArmRetrieverAdapter/i,
  /createPostgresVectorRetrievalRepository/i,
  /DATABASE_URL/,
  /P11F0_KURE_SERVER_URL/,
];

// Strips comments before pattern-matching -- this Turn's own source files
// deliberately DOCUMENT the prohibitions in prose ("never reads a Gold
// field", "no DEV_CHECK/HOLDOUT access", …), which would otherwise trip
// these same regexes. The isolation guarantee this test enforces is about
// actual CODE references (imports, data access, literals), not about
// avoiding the word in a comment describing the boundary.
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

test("source isolation: engine module has zero Gold/A3-Guard/QA/DB/KURE code references", async () => {
  const src = stripComments(await readFile(path.join(FOUR_ARM_DIR, "a4-reranker-engine.mjs"), "utf8"));
  for (const pattern of FORBIDDEN_PATTERNS) {
    assert.doesNotMatch(src, pattern, `engine source must not match ${pattern}`);
  }
});

test("source isolation: features module has zero Gold/A3-Guard/QA/DB/KURE code references", async () => {
  const src = stripComments(await readFile(path.join(FOUR_ARM_DIR, "a4-reranker-features.mjs"), "utf8"));
  for (const pattern of FORBIDDEN_PATTERNS) {
    assert.doesNotMatch(src, pattern, `features source must not match ${pattern}`);
  }
});

test("source isolation: no hardcoded company/corp_code or question_id literal branches", async () => {
  const engineSrc = stripComments(await readFile(path.join(FOUR_ARM_DIR, "a4-reranker-engine.mjs"), "utf8"));
  const featuresSrc = stripComments(await readFile(path.join(FOUR_ARM_DIR, "a4-reranker-features.mjs"), "utf8"));
  // A hardcoded corp_code literal would be an 8-digit-quoted string compared
  // with === inside an if/switch; a hardcoded question_id would be an
  // "author_..."/"gold_..." string literal. Neither pattern occurs anywhere.
  assert.doesNotMatch(engineSrc + featuresSrc, /"0\d{7}"/);
  assert.doesNotMatch(engineSrc + featuresSrc, /"(author|gold)_[0-9a-f]{20,}"/);
  assert.doesNotMatch(engineSrc + featuresSrc, /question_id\s*===/);
  assert.doesNotMatch(engineSrc + featuresSrc, /corp_code\s*===\s*"/);
});

test("existing result files are byte-unchanged (regression guard pinned before this Turn's implementation work)", async () => {
  const pinned = {
    "results/A.results.jsonl": "1132226193290fda5e007c417982a005b3381ac11b07a22d2c388d133d6ce156",
    "results/A.run.json": "1dd354f6db72845a4c69337453a0713eeb4b55ed51c2cecfe1ddeb8c09d0c395",
    "results/A2.results.jsonl": "3083901a68ae0e79f2c1e7d9c841337384898f8276769ea30483c7923416a773",
    "results/A2.run.json": "c55d90ab5b66619fe8d75dbe27791fcf846f48bb0463eee611c7e76ee4fc6b40",
  };
  for (const [relPath, expected] of Object.entries(pinned)) {
    const raw = await readFile(path.join(FOUR_ARM_DIR, relPath));
    assert.equal(sha256Hex(raw), expected, `${relPath} must be byte-unchanged this Turn`);
  }
});
