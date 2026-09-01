// Turn P10.2: the embedding cache key contract this Turn's brief pins
// explicitly -- a cache entry is reused ONLY when repository_id, revision,
// model dimension, query/document role, the applied prefix, the
// normalized text sha256, AND chunking strategy/version ALL match. A
// single Map, shared across the whole Stage 2 run (all 6 combinations),
// with this composite key, makes cross-model/cross-chunking contamination
// structurally impossible -- there is no code path that can look up a
// KURE-v1 vector under a BGE-M3 key, even by accident.
import { createHash } from "node:crypto";

function normalizeText(text) {
  // NFKC + trim, matching this repo's other canonicalization points
  // (e.g. scripts/profile-full-corpus-chunks.mjs's own canonicalText) --
  // never altering the text actually sent to the model, only the KEY.
  return text.normalize("NFKC").trim();
}

function sha256Hex(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function buildCacheKey({ repositoryId, revision, dimension, role, prefix, text, chunkingConfigId }) {
  if (role !== "query" && role !== "document") throw new TypeError('role must be "query" or "document"');
  const normalizedTextSha256 = sha256Hex(normalizeText(text));
  return [repositoryId, revision, String(dimension), role, prefix, normalizedTextSha256, chunkingConfigId].join("|");
}

export function createModelScopedEmbeddingCache() {
  const cache = new Map(); // cacheKey -> vector
  let hits = 0;
  let misses = 0;

  return {
    has(keyParts) {
      return cache.has(buildCacheKey(keyParts));
    },
    get(keyParts) {
      return cache.get(buildCacheKey(keyParts));
    },
    set(keyParts, vector) {
      cache.set(buildCacheKey(keyParts), vector);
    },
    recordHit() { hits += 1; },
    recordMiss() { misses += 1; },
    stats: () => ({ cache_hits: hits, cache_misses: misses, unique_keys_cached: cache.size }),
  };
}
