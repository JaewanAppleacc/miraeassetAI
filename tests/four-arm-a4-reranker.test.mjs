import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { extractFeatures, FEATURE_KEYS } from "../domain/agent-comparison/four-arm-ac/a4-reranker-features.mjs";
import {
  rerankCandidates, rankCandidatePool, selectWithStableRefill, REFILL_DECISIONS,
  validateConfig, assertValidConfig, TOP_K, MAX_POOL_SIZE,
} from "../domain/agent-comparison/four-arm-ac/a4-reranker-engine.mjs";
import { buildWideCandidatePool } from "../domain/agent-comparison/four-arm-ac/a4-wide-candidate-pool.mjs";

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
// this file. Shape matches buildWideCandidatePool()'s REAL output exactly
// (source_membership / source_ranks / source_scores, plain integer ranks,
// document_id -- no doc_id/row/col/locator_status/is_table top-level
// fields, since the real producer does not emit them; see
// A4_RERANKER_V1_CONTRACT.md section 2's disclosed gap).
// ---------------------------------------------------------------------------

function makeCandidate(overrides = {}) {
  return {
    chunk_id: "chunk_synthetic_0000000000000000",
    document_id: "holding_99999999999999",
    text: "합성 테스트 문서 발행주식총수 100000주 관련 내용입니다",
    chunk_text_sha256: "0".repeat(64),
    node_index: 3,
    node_indices: [3, 4, 5],
    locator: {},
    provenance: {},
    metadata: {
      corp_code: "00999999",
      doc_group: "holding",
      doc_subtype: "대량보유상황보고서",
      base_year: 2024,
      base_month: 3,
    },
    source_membership: {
      original_a_top20: false,
      bm25_top100: true,
      dense_top100: true,
    },
    source_ranks: {
      bm25: 4,
      dense: 6,
      original_a: 9,
      wide_rrf: 5,
    },
    source_scores: {
      bm25: 12.3,
      dense: 0.71,
      original_a_rrf: 0.02,
      wide_rrf: 0.025,
    },
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

// Models the real A4 wide-pool shape: the first min(n,100) candidates are
// "found by both legs" (bm25 rank == dense rank == i+1, both <= 100,
// matching the heavy BM25/dense overlap the A3 ceiling audit measured),
// and any candidates beyond 100 (up to MAX_POOL_SIZE=200) are dense-only
// tail entries (dense rank wraps back into [1,100], bm25 absent) -- never
// out-of-range ranks on either leg.
function makePool(n, factory = makeCandidate) {
  return Array.from({ length: n }, (_, i) => {
    const inBothLegs = i < 100;
    return factory({
      chunk_id: `chunk_synthetic_${String(i).padStart(20, "0")}`,
      source_membership: {
        original_a_top20: i < 20,
        bm25_top100: inBothLegs,
        dense_top100: true,
      },
      source_ranks: {
        bm25: inBothLegs ? i + 1 : null,
        dense: inBothLegs ? i + 1 : (i - 100) + 1,
        original_a: i < 20 ? i + 1 : null,
        wide_rrf: i + 1,
      },
      source_scores: {
        bm25: inBothLegs ? 100 - i : null,
        dense: inBothLegs ? 1 - i / 100 : 0.5 - ((i - 100) / 200),
        original_a_rrf: i < 20 ? 0.03 - i * 0.001 : null,
        wide_rrf: 0.03 - i * 0.0002,
      },
    });
  });
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

test("rerankCandidates: refuses a pool larger than the 200-candidate wide-pool ceiling", () => {
  const pool = makePool(MAX_POOL_SIZE + 1);
  assert.throws(() => rerankCandidates(pool, makeQuestionContext(), R1), RangeError);
});

test("rerankCandidates: accepts exactly 100/101/199/200 candidates, rejects 201", () => {
  assert.equal(MAX_POOL_SIZE, 200, "this test assumes the pre-registered 200-candidate ceiling");
  for (const size of [100, 101, 199, 200]) {
    const pool = makePool(size);
    assert.doesNotThrow(() => rerankCandidates(pool, makeQuestionContext(), R1), `pool of size ${size} must be accepted`);
    const out = rerankCandidates(pool, makeQuestionContext(), R1);
    assert.equal(out.length, TOP_K);
  }
  const oversized = makePool(201);
  assert.throws(() => rerankCandidates(oversized, makeQuestionContext(), R1), RangeError, "pool of size 201 must be rejected");
});

test("rerankCandidates: scores every candidate in a 200-wide pool before truncating -- no pre-scoring cut to 100", () => {
  const pool = makePool(200); // candidates 0..99: both legs; 100..199: dense-only tail
  // makePool's own index-0 candidate also happens to carry dense rank=1
  // (the best possible dense feature value) -- neutralize it so the
  // planted tail winner below is the UNIQUE top dense-rank candidate,
  // rather than tying with index 0 and being decided by tie-break instead
  // of by the dense feature this test is actually exercising.
  pool[0] = { ...pool[0], source_ranks: { ...pool[0].source_ranks, dense: 50 }, source_scores: { ...pool[0].source_scores, dense: 0.1 } };
  // Plant a dense-only tail candidate (index 150, well past any 100-item
  // pre-truncation) that should win outright under a dense-heavy config.
  pool[150] = makeCandidate({
    chunk_id: "chunk_tail_winner_000000000000",
    source_membership: { original_a_top20: false, bm25_top100: false, dense_top100: true },
    source_ranks: { bm25: null, dense: 1, original_a: null, wide_rrf: 1 },
    source_scores: { bm25: null, dense: 0.999, original_a_rrf: null, wide_rrf: 0.05 },
  });
  const denseHeavy = { config_id: "dense_heavy_test", weights: { dense: 1 } };
  const out = rerankCandidates(pool, makeQuestionContext(), denseHeavy);
  assert.equal(out[0].chunk_id, "chunk_tail_winner_000000000000", "a candidate beyond index 100 must still be reachable for rank 1 -- proves the full 200-candidate pool was scored, not truncated to 100 first");
});

test("rerankCandidates: rejects a candidate with neither source_membership.bm25_top100 nor source_membership.dense_top100 set", () => {
  const orphan = makeCandidate({
    chunk_id: "chunk_orphan_00000000000000000",
    source_membership: { original_a_top20: false, bm25_top100: false, dense_top100: false },
  });
  assert.throws(() => rerankCandidates([orphan], makeQuestionContext(), R1), RangeError);
});

test("rerankCandidates: accepts a candidate found by only one leg (the other flag false)", () => {
  const bm25OnlyFlagged = makeCandidate({
    chunk_id: "chunk_flagbm25_0000000000000000",
    source_membership: { original_a_top20: false, bm25_top100: true, dense_top100: false },
  });
  const denseOnlyFlagged = makeCandidate({
    chunk_id: "chunk_flagdense_000000000000000",
    source_membership: { original_a_top20: false, bm25_top100: false, dense_top100: true },
  });
  assert.doesNotThrow(() => rerankCandidates([bm25OnlyFlagged, denseOnlyFlagged], makeQuestionContext(), R1));
});

test("rerankCandidates: validates source_ranks.bm25/dense range (1-100 or null), fail-closed", () => {
  for (const badRank of [0, -1, 101, 1.5, "3", NaN, Infinity]) {
    const bad = makeCandidate({ source_ranks: { bm25: badRank, dense: null, original_a: null, wide_rrf: null } });
    assert.throws(() => rerankCandidates([bad], makeQuestionContext(), R1), RangeError, `bm25 rank ${badRank} must be rejected`);
    const badDense = makeCandidate({ source_ranks: { bm25: null, dense: badRank, original_a: null, wide_rrf: null } });
    assert.throws(() => rerankCandidates([badDense], makeQuestionContext(), R1), RangeError, `dense rank ${badRank} must be rejected`);
  }
  for (const okRank of [1, 50, 100, null]) {
    const ok = makeCandidate({ source_ranks: { bm25: okRank, dense: okRank, original_a: null, wide_rrf: null } });
    assert.doesNotThrow(() => rerankCandidates([ok], makeQuestionContext(), R1), `bm25/dense rank ${okRank} must be accepted`);
  }
});

test("rerankCandidates: validates source_ranks.wide_rrf range (1-200 or null), fail-closed", () => {
  for (const badRank of [0, -1, 201, 2.5, NaN, Infinity]) {
    const bad = makeCandidate({ source_ranks: { bm25: null, dense: null, original_a: null, wide_rrf: badRank } });
    assert.throws(() => rerankCandidates([bad], makeQuestionContext(), R1), RangeError, `wide_rrf rank ${badRank} must be rejected`);
  }
  for (const okRank of [1, 100, 200, null]) {
    const ok = makeCandidate({ source_ranks: { bm25: null, dense: null, original_a: null, wide_rrf: okRank } });
    assert.doesNotThrow(() => rerankCandidates([ok], makeQuestionContext(), R1), `wide_rrf rank ${okRank} must be accepted`);
  }
});

test("rerankCandidates: validates source_ranks.original_a -- general positive-integer-or-null, but [1,20] required only when source_membership.original_a_top20=true", () => {
  // Regardless of the top20 flag, a present rank must be a positive integer.
  for (const badRank of [0, -1, 2.5, "3", NaN, Infinity]) {
    const bad = makeCandidate({
      source_membership: { original_a_top20: false, bm25_top100: true, dense_top100: true },
      source_ranks: { bm25: null, dense: null, original_a: badRank, wide_rrf: null },
    });
    assert.throws(() => rerankCandidates([bad], makeQuestionContext(), R1), RangeError, `original_a rank ${badRank} must always be rejected`);
  }
  // When original_a_top20 is NOT true, original_a may exceed 20 (it is the
  // full, uncapped "would-be" RRF rank -- see A4_RERANKER_V1_CONTRACT.md).
  for (const okRank of [1, 20, 21, 45, 150, null]) {
    const ok = makeCandidate({
      source_membership: { original_a_top20: false, bm25_top100: true, dense_top100: true },
      source_ranks: { bm25: null, dense: null, original_a: okRank, wide_rrf: null },
    });
    assert.doesNotThrow(() => rerankCandidates([ok], makeQuestionContext(), R1), `original_a rank ${okRank} must be accepted when original_a_top20 is not true`);
  }
  // When original_a_top20 IS true, a rank is required and must be in [1,20].
  for (const badTop20Rank of [null, 0, 21, 100]) {
    const bad = makeCandidate({
      source_membership: { original_a_top20: true, bm25_top100: true, dense_top100: true },
      source_ranks: { bm25: null, dense: null, original_a: badTop20Rank, wide_rrf: null },
    });
    assert.throws(() => rerankCandidates([bad], makeQuestionContext(), R1), RangeError, `original_a rank ${badTop20Rank} with original_a_top20=true must be rejected`);
  }
  for (const okTop20Rank of [1, 10, 20]) {
    const ok = makeCandidate({
      source_membership: { original_a_top20: true, bm25_top100: true, dense_top100: true },
      source_ranks: { bm25: null, dense: null, original_a: okTop20Rank, wide_rrf: null },
    });
    assert.doesNotThrow(() => rerankCandidates([ok], makeQuestionContext(), R1), `original_a rank ${okTop20Rank} with original_a_top20=true must be accepted`);
  }
});

test("rerankCandidates: does not mutate input candidate objects", () => {
  const pool = makePool(5).map((c) => Object.freeze({
    ...c,
    source_membership: Object.freeze({ ...c.source_membership }),
    source_ranks: Object.freeze({ ...c.source_ranks }),
    source_scores: Object.freeze({ ...c.source_scores }),
    metadata: Object.freeze({ ...c.metadata }),
  }));
  const before = JSON.parse(JSON.stringify(pool));
  assert.doesNotThrow(() => rerankCandidates(pool, makeQuestionContext(), R1));
  assert.deepEqual(JSON.parse(JSON.stringify(pool)), before);
});

test("rerankCandidates: candidates with missing/sparse fields are scored, never dropped", () => {
  const sparse = makeCandidate({
    chunk_id: "chunk_sparse_0000000000000000",
    text: null,
    metadata: null,
    source_membership: { original_a_top20: false, bm25_top100: false, dense_top100: true },
    source_ranks: { bm25: null, dense: 3, original_a: null, wide_rrf: 10 },
    source_scores: { bm25: null, dense: 0.5, original_a_rrf: null, wide_rrf: 0.01 },
  });
  const pool = [sparse, ...makePool(3)];
  const out = rerankCandidates(pool, makeQuestionContext(), R1);
  assert.ok(out.some((c) => c.chunk_id === sparse.chunk_id), "sparse candidate must survive into the output");
  const features = out.find((c) => c.chunk_id === sparse.chunk_id).features;
  assert.equal(features.bm25, 0); // legitimate absence, not neutral
  assert.equal(features.lexical_overlap, 0.5); // missing text -> neutral
  assert.equal(features.metadata_match, 0.5); // missing metadata -> neutral
  assert.equal(features.table_context, 0.5); // no top-level row/col on the real shape -> always neutral (disclosed gap)
  assert.equal(features.provenance_completeness, 0.5); // no top-level locator_status on the real shape -> always neutral (disclosed gap)
});

test("rerankCandidates: BM25-only and dense-only candidates are both handled without error", () => {
  const bm25Only = makeCandidate({
    chunk_id: "chunk_bm25only_000000000000000",
    source_membership: { original_a_top20: false, bm25_top100: true, dense_top100: false },
    source_ranks: { bm25: 1, dense: null, original_a: null, wide_rrf: 1 },
    source_scores: { bm25: 40, dense: null, original_a_rrf: null, wide_rrf: 0.016 },
  });
  const denseOnly = makeCandidate({
    chunk_id: "chunk_denseonly_00000000000000",
    source_membership: { original_a_top20: false, bm25_top100: false, dense_top100: true },
    source_ranks: { bm25: null, dense: 1, original_a: null, wide_rrf: 2 },
    source_scores: { bm25: null, dense: 0.9, original_a_rrf: null, wide_rrf: 0.016 },
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
    source_membership: { original_a_top20: true, bm25_top100: true, dense_top100: true },
    source_ranks: { bm25: 90, dense: 90, original_a: 5, wide_rrf: 80 },
    source_scores: { bm25: 1, dense: 0.1, original_a_rrf: 0.02, wide_rrf: 0.005 },
  });
  const notInTop20 = makeCandidate({
    chunk_id: "chunk_nottop20_0000000000000000",
    source_membership: { original_a_top20: false, bm25_top100: true, dense_top100: true },
    source_ranks: { bm25: 1, dense: 1, original_a: null, wide_rrf: 1 },
    source_scores: { bm25: 99, dense: 0.99, original_a_rrf: null, wide_rrf: 0.03 },
  });
  const out = rerankCandidates([inTop20, notInTop20], makeQuestionContext(), r0);
  assert.equal(out[0].chunk_id, inTop20.chunk_id, "R0 (original-A-priority) must rank the original top-20 candidate first despite weaker BM25/dense");
});

test("tie-break: reranker_score ties fall through to original_a_top20, then original_a rank (only for top20 members), then wide_rrf rank, then chunk_id", () => {
  const zeroWeights = { config_id: "zero", weights: {} }; // every feature weight 0 -> every candidate scores exactly 0
  const a = makeCandidate({
    chunk_id: "chunk_zzz",
    source_membership: { original_a_top20: false, bm25_top100: true, dense_top100: true },
    source_ranks: { bm25: null, dense: null, original_a: null, wide_rrf: 5 },
  });
  const b = makeCandidate({
    chunk_id: "chunk_aaa",
    source_membership: { original_a_top20: true, bm25_top100: true, dense_top100: true },
    source_ranks: { bm25: null, dense: null, original_a: 3, wide_rrf: 9 },
  });
  const c = makeCandidate({
    chunk_id: "chunk_bbb",
    source_membership: { original_a_top20: true, bm25_top100: true, dense_top100: true },
    source_ranks: { bm25: null, dense: null, original_a: 1, wide_rrf: 2 },
  });
  const out = rerankCandidates([a, b, c], makeQuestionContext(), zeroWeights);
  // c: top20=true, original_a rank=1 -- must win over b (top20=true, rank=3) and a (top20=false).
  assert.deepEqual(out.map((x) => x.chunk_id), ["chunk_bbb", "chunk_aaa", "chunk_zzz"]);
});

test("tie-break: a non-top20 candidate's original_a rank is never used as a protective signal, even when numerically better than another non-top20 candidate's", () => {
  const zeroWeights = { config_id: "zero", weights: {} };
  // Neither is in A's official top-20. d's original_a rank (1, diagnostic
  // only) is numerically better than e's (50), but since neither carries
  // original_a_top20=true, that number must NOT act as a tie-break
  // protection -- the comparison must fall straight through to wide_rrf
  // rank instead, where e (wide_rrf=1) beats d (wide_rrf=9).
  const d = makeCandidate({
    chunk_id: "chunk_ddd",
    source_membership: { original_a_top20: false, bm25_top100: true, dense_top100: true },
    source_ranks: { bm25: null, dense: null, original_a: 1, wide_rrf: 9 },
  });
  const e = makeCandidate({
    chunk_id: "chunk_eee",
    source_membership: { original_a_top20: false, bm25_top100: true, dense_top100: true },
    source_ranks: { bm25: null, dense: null, original_a: 50, wide_rrf: 1 },
  });
  const out = rerankCandidates([d, e], makeQuestionContext(), zeroWeights);
  assert.deepEqual(out.map((x) => x.chunk_id), ["chunk_eee", "chunk_ddd"]);
});

test("tie-break: final tiebreaker is chunk_id bytewise ascending when everything else ties", () => {
  const zeroWeights = { config_id: "zero", weights: {} };
  const candidates = ["chunk_c", "chunk_a", "chunk_b"].map((id) => makeCandidate({
    chunk_id: id,
    source_membership: { original_a_top20: false, bm25_top100: true, dense_top100: true },
    source_ranks: { bm25: null, dense: null, original_a: null, wide_rrf: null },
  }));
  const out = rerankCandidates(candidates, makeQuestionContext(), zeroWeights);
  assert.deepEqual(out.map((x) => x.chunk_id), ["chunk_a", "chunk_b", "chunk_c"]);
});

test("multi-node provenance is preserved unchanged through reranking", () => {
  const candidate = makeCandidate({
    chunk_id: "chunk_multinode_00000000000000",
    node_index: 2,
    node_indices: [2, 3, 4, 5, 6, 7],
  });
  const out = rerankCandidates([candidate, ...makePool(3)], makeQuestionContext(), R1);
  const found = out.find((c) => c.chunk_id === candidate.chunk_id);
  assert.deepEqual(found.node_indices, [2, 3, 4, 5, 6, 7]);
  assert.equal(found.node_index, 2);
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
// Full ranking (Turn A4-RERANKER-FULL-RANKING-REFILL-V1): rankCandidatePool()
// returns EVERY candidate, ranked, never truncated; rerankCandidates() is a
// thin top-K wrapper over the same full ranking.
// ---------------------------------------------------------------------------

test("rankCandidatePool: a 200-candidate pool returns all 200, ranked", () => {
  const pool = makePool(200);
  const full = rankCandidatePool(pool, makeQuestionContext(), R1);
  assert.equal(full.length, 200);
});

test("rankCandidatePool: accepts exactly 100/101/199/200 candidates, rejects 201", () => {
  for (const size of [100, 101, 199, 200]) {
    const pool = makePool(size);
    const full = rankCandidatePool(pool, makeQuestionContext(), R1);
    assert.equal(full.length, size, `pool of size ${size} must return exactly ${size} ranked entries`);
  }
  const oversized = makePool(201);
  assert.throws(() => rankCandidatePool(oversized, makeQuestionContext(), R1), RangeError, "pool of size 201 must be rejected");
});

test("rankCandidatePool: empty pool returns an empty array", () => {
  assert.deepEqual(rankCandidatePool([], makeQuestionContext(), R1), []);
});

test("rankCandidatePool: no hidden top-100 cut before scoring -- a candidate at index 150 can become the overall rank 1", () => {
  const pool = makePool(200);
  pool[0] = { ...pool[0], source_ranks: { ...pool[0].source_ranks, dense: 50 }, source_scores: { ...pool[0].source_scores, dense: 0.1 } };
  pool[150] = makeCandidate({
    chunk_id: "chunk_tail_winner_000000000000",
    source_membership: { original_a_top20: false, bm25_top100: false, dense_top100: true },
    source_ranks: { bm25: null, dense: 1, original_a: null, wide_rrf: 1 },
    source_scores: { bm25: null, dense: 0.999, original_a_rrf: null, wide_rrf: 0.05 },
  });
  const denseHeavy = { config_id: "dense_heavy_test", weights: { dense: 1 } };
  const full = rankCandidatePool(pool, makeQuestionContext(), denseHeavy);
  assert.equal(full.length, 200);
  assert.equal(full[0].chunk_id, "chunk_tail_winner_000000000000");
  assert.equal(full[0].rank, 1);
});

test("rankCandidatePool: rank runs 1..pool.length contiguously with no gaps or repeats", () => {
  const pool = makePool(77);
  const full = rankCandidatePool(pool, makeQuestionContext(), R1);
  assert.deepEqual(full.map((c) => c.rank), Array.from({ length: 77 }, (_, i) => i + 1));
});

test("rankCandidatePool: same input produces byte-identical output across repeated calls", () => {
  const pool = makePool(55);
  const qc = makeQuestionContext();
  const out1 = rankCandidatePool(structuredClone(pool), structuredClone(qc), R1);
  const out2 = rankCandidatePool(structuredClone(pool), structuredClone(qc), R1);
  assert.equal(JSON.stringify(out1), JSON.stringify(out2));
});

test("rankCandidatePool: does not mutate the input pool or its candidates", () => {
  const pool = makePool(10).map((c) => Object.freeze({
    ...c,
    source_membership: Object.freeze({ ...c.source_membership }),
    source_ranks: Object.freeze({ ...c.source_ranks }),
    source_scores: Object.freeze({ ...c.source_scores }),
    metadata: Object.freeze({ ...c.metadata }),
  }));
  const before = JSON.parse(JSON.stringify(pool));
  assert.doesNotThrow(() => rankCandidatePool(pool, makeQuestionContext(), R1));
  assert.deepEqual(JSON.parse(JSON.stringify(pool)), before);
});

test("rerankCandidates: is exactly the first TOP_K entries of rankCandidatePool's full ranking, never a separate computation", () => {
  const pool = makePool(85);
  const qc = makeQuestionContext();
  const full = rankCandidatePool(pool, qc, R1);
  const top = rerankCandidates(pool, qc, R1);
  assert.deepEqual(top, full.slice(0, TOP_K));
});

test("rankCandidatePool: all six pre-registered R0-R5 configs run without error on the same pool", async () => {
  const registry = await loadConfigs();
  const pool = makePool(120);
  for (const config of registry.configs) {
    const full = rankCandidatePool(pool, makeQuestionContext(), config);
    assert.equal(full.length, 120, `config ${config.config_id} must rank every candidate`);
    assert.ok(full.every((c) => Number.isFinite(c.reranker_score)), `config ${config.config_id} must produce a finite score for every candidate`);
  }
});

// ---------------------------------------------------------------------------
// Stable refill (Turn A4-RERANKER-FULL-RANKING-REFILL-V1, section E): a
// generic, A3-agnostic pure consumer of an already-made PASS/REJECT/
// KEEP_UNKNOWN decision map. Imports no A3 module anywhere in this file.
// ---------------------------------------------------------------------------

function makeRankedPool(n) {
  return rankCandidatePool(makePool(n), makeQuestionContext(), R1);
}

function decisionsAllPass(rankedPool) {
  return Object.fromEntries(rankedPool.map((c) => [c.chunk_id, "PASS"]));
}

test("selectWithStableRefill: rejecting rank 3 in the top-20 backfills with the original rank 21", () => {
  const ranked = makeRankedPool(30);
  const decisions = decisionsAllPass(ranked);
  decisions[ranked[2].chunk_id] = "REJECT"; // rank 3 (0-indexed 2)
  const out = selectWithStableRefill(ranked, decisions, { outputK: 20 });
  assert.equal(out.length, 20);
  assert.deepEqual(out.map((c) => c.chunk_id), [
    ...ranked.slice(0, 2).map((c) => c.chunk_id),
    ...ranked.slice(3, 21).map((c) => c.chunk_id), // rank 21 (index 20) backfills the gap
  ]);
});

test("selectWithStableRefill: rejecting 3 candidates in the top-20 backfills ranks 21-23 in order", () => {
  const ranked = makeRankedPool(30);
  const decisions = decisionsAllPass(ranked);
  for (const idx of [1, 5, 10]) decisions[ranked[idx].chunk_id] = "REJECT"; // ranks 2, 6, 11
  const out = selectWithStableRefill(ranked, decisions, { outputK: 20 });
  assert.equal(out.length, 20);
  const expectedIds = ranked.filter((c) => decisions[c.chunk_id] !== "REJECT").slice(0, 20).map((c) => c.chunk_id);
  assert.deepEqual(out.map((c) => c.chunk_id), expectedIds);
  // The three backfilled entries must be the original ranks 21, 22, 23.
  assert.deepEqual(out.slice(-3).map((c) => c.chunk_id), [ranked[20].chunk_id, ranked[21].chunk_id, ranked[22].chunk_id]);
});

test("selectWithStableRefill: KEEP_UNKNOWN candidates are never removed", () => {
  const ranked = makeRankedPool(25);
  const decisions = decisionsAllPass(ranked);
  decisions[ranked[4].chunk_id] = "KEEP_UNKNOWN";
  const out = selectWithStableRefill(ranked, decisions, { outputK: 20 });
  assert.ok(out.some((c) => c.chunk_id === ranked[4].chunk_id));
});

test("selectWithStableRefill: PASS candidates are never removed", () => {
  const ranked = makeRankedPool(25);
  const decisions = decisionsAllPass(ranked);
  const out = selectWithStableRefill(ranked, decisions, { outputK: 20 });
  assert.equal(out.length, 20);
  for (const c of ranked.slice(0, 20)) assert.ok(out.some((o) => o.chunk_id === c.chunk_id));
});

test("selectWithStableRefill: 25 REJECTs out of a larger pool selects as many survivors as the later ranks allow", () => {
  const ranked = makeRankedPool(40);
  const decisions = decisionsAllPass(ranked);
  for (let i = 0; i < 25; i += 1) decisions[ranked[i].chunk_id] = "REJECT";
  const out = selectWithStableRefill(ranked, decisions, { outputK: 20 });
  // 40 - 25 = 15 survivors total, all must be selected (fewer than outputK=20).
  assert.equal(out.length, 15);
  assert.deepEqual(out.map((c) => c.chunk_id), ranked.slice(25).map((c) => c.chunk_id));
});

test("selectWithStableRefill: every candidate REJECTed returns an empty array, never padded or fabricated", () => {
  const ranked = makeRankedPool(20);
  const decisions = Object.fromEntries(ranked.map((c) => [c.chunk_id, "REJECT"]));
  const out = selectWithStableRefill(ranked, decisions, { outputK: 20 });
  assert.deepEqual(out, []);
});

test("selectWithStableRefill: a missing decision for any rankedPool chunk_id fails closed", () => {
  const ranked = makeRankedPool(10);
  const decisions = decisionsAllPass(ranked);
  delete decisions[ranked[3].chunk_id];
  assert.throws(() => selectWithStableRefill(ranked, decisions, { outputK: 20 }), RangeError);
});

test("selectWithStableRefill: an unknown decision value fails closed", () => {
  const ranked = makeRankedPool(10);
  const decisions = decisionsAllPass(ranked);
  decisions[ranked[3].chunk_id] = "MAYBE";
  assert.throws(() => selectWithStableRefill(ranked, decisions, { outputK: 20 }), RangeError);
  for (const bad of ["pass", "reject", "", null, 1, "keep_unknown"]) {
    const d2 = decisionsAllPass(ranked);
    d2[ranked[0].chunk_id] = bad;
    assert.throws(() => selectWithStableRefill(ranked, d2, { outputK: 20 }), RangeError, `decision ${JSON.stringify(bad)} must be rejected`);
  }
  assert.deepEqual(REFILL_DECISIONS, ["PASS", "REJECT", "KEEP_UNKNOWN"]);
});

test("selectWithStableRefill: a duplicate chunk_id in rankedPool fails closed", () => {
  const ranked = makeRankedPool(5);
  const duped = [...ranked, ranked[0]];
  const decisions = decisionsAllPass(ranked);
  assert.throws(() => selectWithStableRefill(duped, decisions, { outputK: 20 }), RangeError);
});

test("selectWithStableRefill: never reorders survivors -- relative order after refill is unchanged from rankedPool's own order", () => {
  const ranked = makeRankedPool(30);
  const decisions = decisionsAllPass(ranked);
  for (const idx of [0, 7, 15]) decisions[ranked[idx].chunk_id] = "REJECT";
  const out = selectWithStableRefill(ranked, decisions, { outputK: 20 });
  const survivorOrderInRankedPool = ranked.filter((c) => decisions[c.chunk_id] !== "REJECT").map((c) => c.chunk_id);
  assert.deepEqual(out.map((c) => c.chunk_id), survivorOrderInRankedPool.slice(0, 20));
});

test("selectWithStableRefill: never fabricates a candidate outside rankedPool, and never mutates its inputs", () => {
  const ranked = makeRankedPool(25).map((c) => Object.freeze(c));
  const decisions = Object.freeze(decisionsAllPass(ranked));
  const rankedBefore = JSON.parse(JSON.stringify(ranked));
  const decisionsBefore = JSON.parse(JSON.stringify(decisions));
  const out = selectWithStableRefill(ranked, decisions, { outputK: 20 });
  const rankedIds = new Set(ranked.map((c) => c.chunk_id));
  assert.ok(out.every((c) => rankedIds.has(c.chunk_id)));
  assert.deepEqual(JSON.parse(JSON.stringify(ranked)), rankedBefore);
  assert.deepEqual(JSON.parse(JSON.stringify(decisions)), decisionsBefore);
});

// ---------------------------------------------------------------------------
// Wide-pool contract integration: the real buildWideCandidatePool() output
// (codex/fourarm-a4-wide-pool-v01 @ defd73302bd2b4fd6007283c968a87b3bbf49d0b,
// a4-wide-candidate-pool.mjs, brought into this branch byte-identical) fed
// DIRECTLY into rerankCandidates() -- no remapping, no adapter, no field
// renaming anywhere in this test.
// ---------------------------------------------------------------------------

function makeWidePoolBaseRecord(i) {
  return {
    chunk_id: `chunk_wide_${String(i).padStart(20, "0")}`,
    document_id: `holding_${9000000000000 + i}`,
    text: `합성 wide-pool 문서 ${i} 발행주식총수 관련 내용`,
    chunk_text_sha256: sha256Hex(Buffer.from(`wide-pool-fixture-${i}`)),
    node_index: i % 5,
    node_indices: [i % 5],
    locator: {},
    provenance: {},
    metadata: { corp_code: "00999999", doc_group: "holding" },
  };
}

test("wide-pool contract integration: real buildWideCandidatePool() output feeds rerankCandidates() with zero remapping (200-wide, disjoint legs)", () => {
  const bm25List = Array.from({ length: 100 }, (_, i) => ({ ...makeWidePoolBaseRecord(i), rank: i + 1, score: 100 - i }));
  const denseList = Array.from({ length: 100 }, (_, i) => ({ ...makeWidePoolBaseRecord(100 + i), rank: i + 1, score: 1 - i / 100 }));

  const { pool } = buildWideCandidatePool({ bm25_top100: bm25List, dense_top100: denseList });
  assert.ok(pool.length <= MAX_POOL_SIZE);
  assert.equal(pool.length, 200, "fully disjoint bm25/dense legs must union to exactly 200 distinct candidates");

  // The critical step: pool goes into rerankCandidates() completely as-is.
  const out = rerankCandidates(pool, makeQuestionContext(), R1);
  assert.ok(out.length > 0 && out.length <= TOP_K);
  const poolIds = new Set(pool.map((c) => c.chunk_id));
  for (const item of out) assert.ok(poolIds.has(item.chunk_id), `output chunk_id ${item.chunk_id} must come from the real pool`);
  out.forEach((item, index) => assert.equal(item.rank, index + 1));
});

test("wide-pool contract integration: real buildWideCandidatePool() output feeds rankCandidatePool() and selectWithStableRefill() end-to-end, zero remapping", () => {
  const bm25List = Array.from({ length: 100 }, (_, i) => ({ ...makeWidePoolBaseRecord(i), rank: i + 1, score: 100 - i }));
  const denseList = Array.from({ length: 100 }, (_, i) => ({ ...makeWidePoolBaseRecord(100 + i), rank: i + 1, score: 1 - i / 100 }));
  const { pool } = buildWideCandidatePool({ bm25_top100: bm25List, dense_top100: denseList });

  // rankCandidatePool() consumes the real pool object directly -- full ranking, no truncation.
  const full = rankCandidatePool(pool, makeQuestionContext(), R1);
  assert.equal(full.length, pool.length);
  assert.deepEqual(full.map((c) => c.rank), Array.from({ length: pool.length }, (_, i) => i + 1));

  // A downstream stage rejects the 3rd-ranked candidate; selectWithStableRefill
  // backfills from the real full ranking with no remapping and no re-scoring.
  const decisions = Object.fromEntries(full.map((c) => [c.chunk_id, "PASS"]));
  decisions[full[2].chunk_id] = "REJECT";
  const finalTop20 = selectWithStableRefill(full, decisions, { outputK: 20 });
  assert.equal(finalTop20.length, 20);
  assert.deepEqual(finalTop20.map((c) => c.chunk_id), [
    full[0].chunk_id, full[1].chunk_id,
    ...full.slice(3, 21).map((c) => c.chunk_id),
  ]);
});

test("wide-pool contract integration: real buildWideCandidatePool() output feeds rerankCandidates() with zero remapping (partial overlap, under 200)", () => {
  // 60 candidates found by both legs, 40 bm25-only, 40 dense-only -> 140 total.
  const shared = Array.from({ length: 60 }, (_, i) => makeWidePoolBaseRecord(i));
  const bm25Only = Array.from({ length: 40 }, (_, i) => makeWidePoolBaseRecord(200 + i));
  const denseOnly = Array.from({ length: 40 }, (_, i) => makeWidePoolBaseRecord(300 + i));
  const bm25List = [
    ...shared.map((r, i) => ({ ...r, rank: i + 1, score: 100 - i })),
    ...bm25Only.map((r, i) => ({ ...r, rank: 61 + i, score: 40 - i })),
  ];
  const denseList = [
    ...shared.map((r, i) => ({ ...r, rank: i + 1, score: 1 - i / 100 })),
    ...denseOnly.map((r, i) => ({ ...r, rank: 61 + i, score: 0.4 - i / 200 })),
  ];

  const { pool } = buildWideCandidatePool({ bm25_top100: bm25List, dense_top100: denseList });
  assert.equal(pool.length, 140);

  const out = rerankCandidates(pool, makeQuestionContext(), R1);
  assert.ok(out.length > 0 && out.length <= TOP_K);
  const poolIds = new Set(pool.map((c) => c.chunk_id));
  assert.ok(out.every((item) => poolIds.has(item.chunk_id)));
});

test("wide-pool contract integration: a real, reproducible original_a_top20 survives into source_membership.original_a_top20 and the tie-break protection", async () => {
  const bm25List = Array.from({ length: 100 }, (_, i) => ({ ...makeWidePoolBaseRecord(i), rank: i + 1, score: 100 - i }));
  const denseList = Array.from({ length: 100 }, (_, i) => ({ ...makeWidePoolBaseRecord(100 + i), rank: i + 1, score: 1 - i / 100 }));

  // Step 1: compute the pool WITHOUT an original_a_top20 input, to derive
  // the real, formula-computed original_a ranking (never hand-computed by
  // this test).
  const first = buildWideCandidatePool({ bm25_top100: bm25List, dense_top100: denseList });
  const top20FromFormula = [...first.pool]
    .filter((c) => c.source_ranks.original_a !== null)
    .sort((a, b) => a.source_ranks.original_a - b.source_ranks.original_a)
    .slice(0, 20);
  assert.equal(top20FromFormula.length, 20);

  // Step 2: rebuild original_a_top20 input records from that real ranking
  // (base fields copied straight from the pool item; rank = its own
  // already-computed original_a rank, which for the leading 20 fused
  // entries is exactly 1..20 by construction of buildWideCandidatePool's
  // own sequential-rank assignment).
  const originalATop20Input = top20FromFormula.map((c) => ({
    chunk_id: c.chunk_id, document_id: c.document_id, text: c.text,
    chunk_text_sha256: c.chunk_text_sha256, node_index: c.node_index,
    node_indices: c.node_indices, locator: c.locator, provenance: c.provenance,
    metadata: c.metadata, rank: c.source_ranks.original_a,
  }));

  // Step 3: rebuild the pool WITH that reproducible original_a_top20 --
  // buildWideCandidatePool's own fail-closed reproducibility check must
  // pass (it throws WideCandidatePoolInputError otherwise).
  const second = buildWideCandidatePool({ original_a_top20: originalATop20Input, bm25_top100: bm25List, dense_top100: denseList });
  const flagged = second.pool.filter((c) => c.source_membership.original_a_top20 === true);
  assert.equal(flagged.length, 20);
  for (const c of flagged) {
    assert.ok(c.source_ranks.original_a >= 1 && c.source_ranks.original_a <= 20, `flagged candidate ${c.chunk_id} must have original_a in [1,20], got ${c.source_ranks.original_a}`);
  }

  // Step 4: feed the real pool directly into rerankCandidates() under R0
  // (original-A-priority) and confirm every flagged candidate outranks
  // every non-flagged candidate that made it into the top-20 output.
  const registry = await loadConfigs();
  const r0 = registry.configs.find((c) => c.family === "R0");
  const out = rerankCandidates(second.pool, makeQuestionContext(), r0);
  const flaggedIds = new Set(flagged.map((c) => c.chunk_id));
  const lastFlaggedRank = Math.max(...out.filter((c) => flaggedIds.has(c.chunk_id)).map((c) => c.rank));
  const firstUnflaggedRank = Math.min(...out.filter((c) => !flaggedIds.has(c.chunk_id)).map((c) => c.rank), Infinity);
  assert.ok(lastFlaggedRank < firstUnflaggedRank, "every original-A top-20 candidate must outrank every non-top-20 candidate under R0");
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
