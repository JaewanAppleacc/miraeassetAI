// 결정론적 가짜 EmbeddingAdapter — 네트워크 호출을 하지 않고 시계·난수에 의존하지
// 않는다. 같은 텍스트는 항상 같은 벡터를 만들므로, 제공자 계정 없이도 단위/계약 테스트와
// 스모크 스크립트가 재현 가능하다. 출력 순서는 입력 순서를 항상 따른다.
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
