import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  buildWideCandidatePool,
  WideCandidatePoolInputError,
  BM25_CANDIDATE_K,
  ORIGINAL_DENSE_CANDIDATE_K,
  WIDE_DENSE_CANDIDATE_K,
  RRF_CONSTANT,
  ORIGINAL_OUTPUT_K,
} from "../domain/agent-comparison/four-arm-ac/a4-wide-candidate-pool.mjs";

// All fixtures below are hand-authored and synthetic: fictional chunk/
// document IDs ("chunk_...", "doc_1"), no real packet ID, question
// sentence, Gold value, or Gold locator from this repository. This turn
// never opened Gold, DEV_TUNE, or any real oracle number (see
// A4_WIDE_CANDIDATE_POOL_V1_HANDOFF.md); the only real-artifact bytes this
// file touches are SHA256 checksums of existing result files, used purely
// as an integrity guard that this turn never modified them.

function base(chunkId, { documentId = "doc_1", sha = `sha_${chunkId}`, nodeIndex = null, nodeIndices = [], text = `synthetic text for ${chunkId}`, locator = {}, provenance = {}, metadata = {} } = {}) {
  return {
    chunk_id: chunkId,
    document_id: documentId,
    text,
    chunk_text_sha256: sha,
    node_index: nodeIndex,
    node_indices: nodeIndices,
    locator,
    provenance,
    metadata,
  };
}

// ---------------------------------------------------------------------------
// Shared fixture. RRF(k=60) numbers below are exact (contribution =
// 1/(60+rank)), verified by hand in the handoff doc:
//   chunk_common:          bm25 r1 (1/61) + dense r1 (1/61) = 2/61
//   chunk_bm25_only:       bm25 r2 (1/62)                     = 1/62
//   chunk_dense_only20:    dense r2 (1/62)                    = 1/62  (tie)
//   chunk_bm25_low:        bm25 r3 (1/63)                     = 1/63
//   chunk_dense_wide_only: dense r50 (1/110), r50 > 20 so it
//                          never enters the original-A universe at all.
// original-A order (bm25 top100 + dense's own top-20 subset):
//   1. chunk_common  2. chunk_bm25_only  3. chunk_dense_only20  4. chunk_bm25_low
// wide order (bm25 top100 + dense's full top-100):
//   1. chunk_common  2. chunk_bm25_only  3. chunk_dense_only20
//   4. chunk_bm25_low  5. chunk_dense_wide_only
// chunk_bm25_only vs chunk_dense_only20 is an EXACT tie (both 1/62);
// "chunk_bm25_only" < "chunk_dense_only20" lexicographically, so it wins.
// ---------------------------------------------------------------------------

function buildSharedFixture() {
  const bm25Top100 = [
    { ...base("chunk_common", { nodeIndex: null, nodeIndices: [5, 6] }), rank: 1, score: 9.5 },
    { ...base("chunk_bm25_only"), rank: 2, score: 8.0 },
    { ...base("chunk_bm25_low"), rank: 3, score: 5.0 },
  ];
  const denseTop100 = [
    { ...base("chunk_common", { nodeIndex: 7, nodeIndices: [] }), rank: 1, score: 0.95 },
    { ...base("chunk_dense_only20"), rank: 2, score: 0.90 },
    { ...base("chunk_dense_wide_only"), rank: 50, score: 0.50 },
  ];
  const originalATop20 = [
    { ...base("chunk_common", { nodeIndex: 5, nodeIndices: [5] }), rank: 1 },
    { ...base("chunk_bm25_only"), rank: 2 },
    { ...base("chunk_dense_only20"), rank: 3 },
  ];
  return { original_a_top20: originalATop20, bm25_top100: bm25Top100, dense_top100: denseTop100 };
}

function byId(pool, chunkId) {
  return pool.find((c) => c.chunk_id === chunkId);
}

// ---------------------------------------------------------------------------
// Constants match the frozen config
// ---------------------------------------------------------------------------

test("frozen config constants", () => {
  assert.equal(BM25_CANDIDATE_K, 100);
  assert.equal(ORIGINAL_DENSE_CANDIDATE_K, 20);
  assert.equal(WIDE_DENSE_CANDIDATE_K, 100);
  assert.equal(RRF_CONSTANT, 60);
  assert.equal(ORIGINAL_OUTPUT_K, 20);
});

// ---------------------------------------------------------------------------
// 기존 A top-20 누락 0
// ---------------------------------------------------------------------------

test("기존 A top-20 누락 0: 모든 original_a_top20 candidate가 pool에 포함된다", () => {
  const fixture = buildSharedFixture();
  const { pool } = buildWideCandidatePool(fixture);
  for (const record of fixture.original_a_top20) {
    assert.ok(byId(pool, record.chunk_id), `${record.chunk_id} missing from pool`);
  }
});

// ---------------------------------------------------------------------------
// BM25-only / dense-only inclusion
// ---------------------------------------------------------------------------

test("BM25-only 후보 포함 (dense/original_a_top20에는 없음)", () => {
  const { pool } = buildWideCandidatePool(buildSharedFixture());
  const item = byId(pool, "chunk_bm25_low");
  assert.ok(item);
  assert.deepEqual(item.source_membership, { original_a_top20: false, bm25_top100: true, dense_top100: false });
  assert.equal(item.source_ranks.bm25, 3);
  assert.equal(item.source_ranks.dense, null);
  assert.equal(item.source_scores.dense, null);
});

test("dense-only 후보 포함 (bm25/original_a_top20에는 없음, original_dense_candidate_k 밖)", () => {
  const { pool } = buildWideCandidatePool(buildSharedFixture());
  const item = byId(pool, "chunk_dense_wide_only");
  assert.ok(item);
  assert.deepEqual(item.source_membership, { original_a_top20: false, bm25_top100: false, dense_top100: true });
  assert.equal(item.source_ranks.dense, 50);
  assert.equal(item.source_ranks.bm25, null);
  // rank 50 > ORIGINAL_DENSE_CANDIDATE_K(20) -> never enters the original-A
  // RRF universe at all.
  assert.equal(item.source_ranks.original_a, null);
  assert.equal(item.source_scores.original_a_rrf, null);
  // but it IS part of the wide diagnostic ranking.
  assert.ok(item.source_ranks.wide_rrf !== null);
});

// ---------------------------------------------------------------------------
// 양쪽 공통 후보 정확히 1개로 dedup
// ---------------------------------------------------------------------------

test("양쪽 공통 후보(chunk_common)가 pool에 정확히 1개로 dedup된다", () => {
  const { pool } = buildWideCandidatePool(buildSharedFixture());
  const matches = pool.filter((c) => c.chunk_id === "chunk_common");
  assert.equal(matches.length, 1);
});

// ---------------------------------------------------------------------------
// 모든 source rank 보존
// ---------------------------------------------------------------------------

test("모든 source rank 보존: chunk_common은 bm25/dense/original_a/wide_rrf 랭크를 모두 가진다", () => {
  const { pool } = buildWideCandidatePool(buildSharedFixture());
  const item = byId(pool, "chunk_common");
  assert.equal(item.source_ranks.bm25, 1);
  assert.equal(item.source_ranks.dense, 1);
  assert.equal(item.source_ranks.original_a, 1);
  assert.equal(item.source_ranks.wide_rrf, 1);
  assert.ok(Math.abs(item.source_scores.original_a_rrf - 2 / 61) < 1e-12);
  assert.ok(Math.abs(item.source_scores.wide_rrf - 2 / 61) < 1e-12);
  assert.equal(item.source_scores.bm25, 9.5);
  assert.equal(item.source_scores.dense, 0.95);
});

// ---------------------------------------------------------------------------
// original_a_rank가 기존 A RRF를 정확히 재현한다 (전체 재구성 순서 확인)
// ---------------------------------------------------------------------------

test("original_a_rank가 original_a_top20의 실제 순서를 정확히 재현한다", () => {
  const { pool } = buildWideCandidatePool(buildSharedFixture());
  assert.equal(byId(pool, "chunk_common").source_ranks.original_a, 1);
  assert.equal(byId(pool, "chunk_bm25_only").source_ranks.original_a, 2);
  assert.equal(byId(pool, "chunk_dense_only20").source_ranks.original_a, 3);
  // chunk_bm25_low is not in the given original_a_top20 list, but the
  // recomputed original-A universe (bm25 top100 + dense top20 subset)
  // still ranks it 4th -- a "would-be" diagnostic rank beyond A's own
  // official cutoff, never treated as an actual A output.
  assert.equal(byId(pool, "chunk_bm25_low").source_ranks.original_a, 4);
});

test("wide_rrf_rank는 original_a_rank와 다를 수 있고 최종 순위로 간주되지 않는다", () => {
  const { pool } = buildWideCandidatePool(buildSharedFixture());
  const wideOnly = byId(pool, "chunk_dense_wide_only");
  // wide_rrf_rank exists for a candidate original_a_rank does not.
  assert.equal(wideOnly.source_ranks.original_a, null);
  assert.equal(wideOnly.source_ranks.wide_rrf, 5);
});

// ---------------------------------------------------------------------------
// multi-node provenance 보존
// ---------------------------------------------------------------------------

test("multi-node provenance 보존: node_indices는 세 출처의 합집합이다", () => {
  const { pool } = buildWideCandidatePool(buildSharedFixture());
  const item = byId(pool, "chunk_common");
  // original_a_top20 declared node_indices [5]; bm25_top100 declared [5,6];
  // dense_top100 declared node_index 7, node_indices []. Union = [5,6,7].
  assert.deepEqual(item.node_indices, [5, 6, 7]);
  assert.equal(item.node_index, 5); // smallest of the merged set
});

// ---------------------------------------------------------------------------
// 동점 결과 결정론
// ---------------------------------------------------------------------------

test("동점 결과 결정론: chunk_bm25_only와 chunk_dense_only20의 RRF 점수가 정확히 같고 chunk_id 오름차순으로 타이브레이크된다", () => {
  const { pool } = buildWideCandidatePool(buildSharedFixture());
  const a = byId(pool, "chunk_bm25_only");
  const b = byId(pool, "chunk_dense_only20");
  assert.equal(a.source_scores.original_a_rrf, b.source_scores.original_a_rrf);
  assert.ok(a.source_ranks.original_a < b.source_ranks.original_a);
  assert.equal(a.source_scores.wide_rrf, b.source_scores.wide_rrf);
  assert.ok(a.source_ranks.wide_rrf < b.source_ranks.wide_rrf);
});

// ---------------------------------------------------------------------------
// 입력 순서를 섞어도 byte-identical
// ---------------------------------------------------------------------------

test("입력 순서를 섞어도 byte-identical (rank는 값 필드이지 배열 위치가 아니다)", () => {
  const fixture = buildSharedFixture();
  const shuffled = {
    original_a_top20: [...fixture.original_a_top20].reverse(),
    bm25_top100: [fixture.bm25_top100[2], fixture.bm25_top100[0], fixture.bm25_top100[1]],
    dense_top100: [fixture.dense_top100[2], fixture.dense_top100[1], fixture.dense_top100[0]],
  };
  const r1 = buildWideCandidatePool(fixture);
  const r2 = buildWideCandidatePool(shuffled);
  assert.equal(JSON.stringify(r1), JSON.stringify(r2));
});

// ---------------------------------------------------------------------------
// 동일 입력에 byte-identical 결과
// ---------------------------------------------------------------------------

test("동일 입력에 byte-identical 결과", () => {
  const fixture = buildSharedFixture();
  const r1 = buildWideCandidatePool(fixture);
  const r2 = buildWideCandidatePool(fixture);
  assert.equal(JSON.stringify(r1), JSON.stringify(r2));
});

// ---------------------------------------------------------------------------
// 잘못된 chunk/document/SHA 충돌 시 fail-closed
// ---------------------------------------------------------------------------

test("동일 chunk_id의 document_id 충돌 -> fail-closed", () => {
  assert.throws(
    () => buildWideCandidatePool({
      original_a_top20: [],
      bm25_top100: [{ ...base("chunk_x", { documentId: "doc_A" }), rank: 1, score: 1.0 }],
      dense_top100: [{ ...base("chunk_x", { documentId: "doc_B" }), rank: 1, score: 1.0 }],
    }),
    (err) => err instanceof WideCandidatePoolInputError && err.code === "DOCUMENT_ID_CONFLICT",
  );
});

test("동일 chunk_id의 chunk_text_sha256 충돌 -> fail-closed", () => {
  assert.throws(
    () => buildWideCandidatePool({
      original_a_top20: [],
      bm25_top100: [{ ...base("chunk_y", { sha: "sha_v1" }), rank: 1, score: 1.0 }],
      dense_top100: [{ ...base("chunk_y", { sha: "sha_v2" }), rank: 1, score: 1.0 }],
    }),
    (err) => err instanceof WideCandidatePoolInputError && err.code === "CHUNK_TEXT_SHA256_CONFLICT",
  );
});

test("original_a_top20이 bm25/dense로부터 재현 불가능하면 fail-closed", () => {
  assert.throws(
    () => buildWideCandidatePool({
      original_a_top20: [{ ...base("chunk_not_reachable"), rank: 1 }],
      bm25_top100: [{ ...base("chunk_common"), rank: 1, score: 9.0 }],
      dense_top100: [],
    }),
    (err) => err instanceof WideCandidatePoolInputError && err.code === "ORIGINAL_A_RRF_NOT_REPRODUCIBLE",
  );
});

test("리스트 내 중복 rank -> fail-closed", () => {
  assert.throws(
    () => buildWideCandidatePool({
      original_a_top20: [],
      bm25_top100: [
        { ...base("chunk_p"), rank: 1, score: 1.0 },
        { ...base("chunk_q"), rank: 1, score: 2.0 },
      ],
      dense_top100: [],
    }),
    (err) => err instanceof WideCandidatePoolInputError && err.code === "DUPLICATE_RANK_IN_LIST",
  );
});

test("bm25_top100이 BM25_CANDIDATE_K(100)를 초과하면 fail-closed", () => {
  const oversized = Array.from({ length: 101 }, (_, i) => ({ ...base(`chunk_over_${i}`), rank: i + 1, score: 1.0 }));
  assert.throws(
    () => buildWideCandidatePool({ original_a_top20: [], bm25_top100: oversized, dense_top100: [] }),
    (err) => err instanceof WideCandidatePoolInputError && err.code === "LIST_EXCEEDS_CAPACITY",
  );
});

// ---------------------------------------------------------------------------
// Gold 필드·실제 packet ID 하드코딩 없음 / DB write·network·embedding 호출 없음
// ---------------------------------------------------------------------------

test("구현 소스에 금지된 Gold 필드, 실제 packet ID, I/O 호출이 없음", () => {
  const modulePath = fileURLToPath(
    new URL("../domain/agent-comparison/four-arm-ac/a4-wide-candidate-pool.mjs", import.meta.url),
  );
  const source = readFileSync(modulePath, "utf8");

  for (const forbidden of ["acceptable_sources", "gold_evidence", "gold_answer", "A.results.jsonl", "DEV_TUNE", "oracle"]) {
    assert.ok(!source.toLowerCase().includes(forbidden.toLowerCase()), `module source must not reference "${forbidden}"`);
  }

  // Real packet IDs in this repo follow the shape "u-" + 12 hex chars.
  assert.doesNotMatch(source, /u-[0-9a-f]{12}/);

  // No network/DB/filesystem/embedding call surface of any kind: this
  // module is a pure in-memory function over its arguments only. These are
  // call-shaped tokens (trailing "(" or a require path), not domain
  // vocabulary that may legitimately appear in a comment (e.g. "KURE" is
  // the embedding model this pool's dense leg conceptually came from, not
  // something this module ever calls).
  for (const forbidden of ["fetch(", "require(", "axios(", "new pool(", "new client(", "readfile(", "writefile(", "createwritestream(", ".query("]) {
    assert.ok(!source.toLowerCase().includes(forbidden.toLowerCase()), `module source must not reference "${forbidden}"`);
  }

  // No import statements at all -- this module has zero dependencies.
  assert.doesNotMatch(source, /^import /m);
});

test("테스트 소스 자체에도 금지된 실제 packet ID 패턴이 없음", () => {
  const testPath = fileURLToPath(import.meta.url);
  const source = readFileSync(testPath, "utf8");
  assert.doesNotMatch(source, /u-[0-9a-f]{12}/);
});

// ---------------------------------------------------------------------------
// 기존 A/B/C/D 결과 SHA 불변
// ---------------------------------------------------------------------------

// SHA256 fingerprints of the existing result/run files present on this
// branch, captured before this turn's implementation began. This is a
// structural integrity check only -- it never reads or asserts on the
// files' actual (Gold-derived) content, only that their bytes are
// unchanged by this turn's work.
const EXPECTED_RESULT_SHA256 = Object.freeze({
  "A.results.jsonl": "1132226193290fda5e007c417982a005b3381ac11b07a22d2c388d133d6ce156",
  "A.run.json": "1dd354f6db72845a4c69337453a0713eeb4b55ed51c2cecfe1ddeb8c09d0c395",
  "C.results.jsonl": "898b53e3aa32c86502d54d13bc3de93d27139ae70975ad64e63a9490fe693081",
  "C.run.json": "19e3e044a27d3ea8399851e2224c7430f95562967f9cdd36dba7100712a9eb07",
  "A2.results.jsonl": "3083901a68ae0e79f2c1e7d9c841337384898f8276769ea30483c7923416a773",
  "A2.run.json": "c55d90ab5b66619fe8d75dbe27791fcf846f48bb0463eee611c7e76ee4fc6b40",
  "score.A2.json": "73a6796657a8f3c4a5b9db6999731e3dbb579383d1d9f8de7dfffd0b8a50734a",
});

test("기존 A/A2/C 결과·run 파일의 SHA256이 이번 Turn 이전과 동일하다", () => {
  for (const [fileName, expectedSha] of Object.entries(EXPECTED_RESULT_SHA256)) {
    const filePath = fileURLToPath(
      new URL(`../domain/agent-comparison/four-arm-ac/results/${fileName}`, import.meta.url),
    );
    const bytes = readFileSync(filePath);
    const actualSha = createHash("sha256").update(bytes).digest("hex");
    assert.equal(actualSha, expectedSha, `${fileName} SHA256 changed -- an existing result/run file must never be modified`);
  }
});
