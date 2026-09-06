// Deterministic fake EmbeddingAdapter (Turn P4) -- never makes a network
// call, never depends on wall-clock time or randomness. The SAME text
// always produces the SAME vector, so unit/contract tests and the vector
// smoke script stay reproducible with no provider account. Order is always
// preserved (embedDocuments maps texts[i] -> result[i] directly).
//
// The vector is derived from sha256(text) bytes, mapped into `dimension`
// floats in [-1, 1] and L2-normalized -- similar texts do NOT produce
// similar vectors (this is not a real semantic embedding), which is
// intentional: a test asserting "the exact same text retrieves itself"
// works with this fake; a test asserting "semantically similar text
// retrieves a near neighbor" requires a REAL embedding model and is out of
// scope for a fake adapter.
import { createHash } from "node:crypto";

function bytesToUnitVector(bytes, dimension) {
  const raw = [];
  let counter = 0;
  while (raw.length < dimension) {
    const block = createHash("sha256").update(bytes).update(Buffer.from([counter])).digest();
    for (let i = 0; i + 1 < block.length && raw.length < dimension; i += 2) {
      // Map a 16-bit unsigned chunk to [-1, 1].
      const value = block.readUInt16BE(i);
      raw.push((value / 65535) * 2 - 1);
    }
    counter += 1;
  }
  const norm = Math.sqrt(raw.reduce((sum, v) => sum + v * v, 0)) || 1;
  return raw.map((v) => v / norm);
}

function embedOne(text, dimension) {
  return bytesToUnitVector(Buffer.from(text, "utf8"), dimension);
}

export function createDeterministicFakeEmbeddingAdapter({
  provider = "test-fixture",
  model = "deterministic-fake-embedding-v1",
  dimension = 8,
} = {}) {
  if (!Number.isInteger(dimension) || dimension < 1) throw new TypeError("dimension must be a positive integer");
  return Object.freeze({
    provider,
    model,
    async embedDocuments(texts) {
      if (!Array.isArray(texts) || texts.length === 0) throw new TypeError("embedDocuments requires a non-empty array of texts");
      return texts.map((text) => embedOne(text, dimension));
    },
    async embedQuery(text) {
      if (typeof text !== "string" || text === "") throw new TypeError("embedQuery requires a non-empty string");
      return embedOne(text, dimension);
    },
  });
}
