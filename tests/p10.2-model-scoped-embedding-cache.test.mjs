import test from "node:test";
import assert from "node:assert/strict";
import { buildCacheKey, createModelScopedEmbeddingCache } from "../domain/agent-comparison/chunking-comparison/model-scoped-embedding-cache.mjs";

const BASE = { repositoryId: "BAAI/bge-m3", revision: "abc123", dimension: 1024, role: "document", prefix: "", text: "동일한 텍스트", chunkingConfigId: "fixed-token-512-o64.v0.1.0" };

test("buildCacheKey requires role to be exactly 'query' or 'document'", () => {
  assert.throws(() => buildCacheKey({ ...BASE, role: "other" }), TypeError);
});

test("cache: a hit requires EVERY key field to match -- different repository_id misses", () => {
  const cache = createModelScopedEmbeddingCache();
  cache.set(BASE, [1, 2, 3]);
  assert.ok(cache.has(BASE));
  assert.ok(!cache.has({ ...BASE, repositoryId: "nlpai-lab/KURE-v1" }));
});

test("cache: different revision misses (a model version bump must never silently reuse a stale vector)", () => {
  const cache = createModelScopedEmbeddingCache();
  cache.set(BASE, [1, 2, 3]);
  assert.ok(!cache.has({ ...BASE, revision: "def456" }));
});

test("cache: different dimension misses", () => {
  const cache = createModelScopedEmbeddingCache();
  cache.set(BASE, [1, 2, 3]);
  assert.ok(!cache.has({ ...BASE, dimension: 768 }));
});

test("cache: query role and document role are isolated even for the identical text", () => {
  const cache = createModelScopedEmbeddingCache();
  cache.set({ ...BASE, role: "document" }, [1, 1, 1]);
  assert.ok(!cache.has({ ...BASE, role: "query" }));
});

test("cache: different prefix misses -- a candidate whose query_prefix differs from document_prefix must never cross-hit", () => {
  const cache = createModelScopedEmbeddingCache();
  cache.set({ ...BASE, role: "query", prefix: "query: " }, [1, 1, 1]);
  assert.ok(!cache.has({ ...BASE, role: "query", prefix: "" }));
});

test("cache: different chunking_config_id misses -- the same raw text under a different strategy is a different cache entry", () => {
  const cache = createModelScopedEmbeddingCache();
  cache.set(BASE, [1, 2, 3]);
  assert.ok(!cache.has({ ...BASE, chunkingConfigId: "section-aware-flat-512-o64.v0.1.0" }));
});

test("cache: identical text with trivial whitespace/normalization differences still hits (NFKC+trim canonicalization)", () => {
  const cache = createModelScopedEmbeddingCache();
  cache.set({ ...BASE, text: "  동일한 텍스트  " }, [9, 9, 9]);
  assert.deepEqual(cache.get({ ...BASE, text: "동일한 텍스트" }), [9, 9, 9]);
});

test("cache: hit/miss stats accumulate correctly across recordHit/recordMiss calls", () => {
  const cache = createModelScopedEmbeddingCache();
  cache.set(BASE, [1, 2, 3]);
  cache.recordMiss();
  cache.recordHit();
  cache.recordHit();
  const stats = cache.stats();
  assert.equal(stats.cache_misses, 1);
  assert.equal(stats.cache_hits, 2);
  assert.equal(stats.unique_keys_cached, 1);
});
