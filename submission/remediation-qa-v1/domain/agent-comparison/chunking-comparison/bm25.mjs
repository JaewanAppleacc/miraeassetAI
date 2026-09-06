// 결정론적 Okapi BM25(k1=1.5, b=0.75) 어휘 색인.
// domain/chunking/chunker.mjs의 tokenizeWithOffsets(유니코드 문자/숫자 연속 토크나이저)를
// 기본 토크나이저로 재사용해, 청킹 전략 비교가 동일한 토큰화 위에서 이루어지게 한다.
import { tokenizeWithOffsets } from "../../chunking/chunker.mjs";

const K1 = 1.5;
const B = 0.75;

export function defaultTokenize(text) {
  return tokenizeWithOffsets(String(text).toLowerCase()).map((t) => t.text);
}

// documents: [{ id: string, text: string }] with UNIQUE ids.
// tokenize: (text) => string[]. Deterministic for identical input.
export function buildBm25Index(documents, { tokenize = defaultTokenize } = {}) {
  const seenIds = new Set();
  const docTokens = new Map(); // id -> string[]
  const termDocFreq = new Map(); // term -> number of docs containing it
  let totalLength = 0;

  for (const doc of documents) {
    if (seenIds.has(doc.id)) throw new Error(`buildBm25Index: duplicate document id: ${doc.id}`);
    seenIds.add(doc.id);
    const tokens = tokenize(doc.text);
    docTokens.set(doc.id, tokens);
    totalLength += tokens.length;
    for (const term of new Set(tokens)) termDocFreq.set(term, (termDocFreq.get(term) ?? 0) + 1);
  }

  const documentCount = documents.length;
  const averageDocLength = documentCount > 0 ? totalLength / documentCount : 0;
  const idf = new Map();
  for (const [term, df] of termDocFreq) {
    idf.set(term, Math.log(1 + (documentCount - df + 0.5) / (df + 0.5)));
  }

  // Deterministic document order for iteration during search, independent
  // of Map insertion order (which follows the caller's array order --
  // pinned here explicitly by id so a caller passing documents in a
  // different order never changes scoring/tie-break behavior).
  const orderedIds = [...docTokens.keys()].sort();

  return Object.freeze({ documentCount, averageDocLength, idf, docTokens, orderedIds, tokenize });
}

function termFrequencies(tokens) {
  const tf = new Map();
  for (const token of tokens) tf.set(token, (tf.get(token) ?? 0) + 1);
  return tf;
}

export function bm25Score(index, docId, queryTokens) {
  const tokens = index.docTokens.get(docId);
  if (!tokens) throw new Error(`bm25Score: unknown document id: ${docId}`);
  const tf = termFrequencies(tokens);
  const docLength = tokens.length;
  let score = 0;
  for (const term of queryTokens) {
    const termIdf = index.idf.get(term);
    if (!termIdf) continue; // term never seen in this index -- contributes 0, never NaN
    const freq = tf.get(term) ?? 0;
    if (freq === 0) continue;
    const numerator = freq * (K1 + 1);
    const denominator = freq + K1 * (1 - B + B * (docLength / (index.averageDocLength || 1)));
    score += termIdf * (numerator / denominator);
  }
  return score;
}

// Returns [{ id, score }] sorted by score desc, then by id ASC on an exact
// tie (matches P10_COMPARISON_CONDITIONS.tie_break) -- never truncated
// below the full corpus before sorting, so topK is a pure post-sort slice.
//
// `eligibleIds`
// (optional, additive -- every existing caller that omits it keeps
// scoring the WHOLE index, byte-for-byte unchanged) restricts the
// candidate pool to a Set of ids BEFORE scoring/ranking, not after -- a
// true prefilter. Without it, a caller that wants a metadata-filtered
// result has to rank the full topK first and then prune, which can leave
// fewer than topK filter-compliant candidates even when more exist further
// down the ranking; with it, topK is always computed over the
// already-eligible pool.
export function bm25Search(index, queryText, { topK = 10, eligibleIds = null } = {}) {
  const queryTokens = index.tokenize(queryText);
  const candidateIds = eligibleIds ? index.orderedIds.filter((id) => eligibleIds.has(id)) : index.orderedIds;
  const scored = candidateIds.map((id) => ({ id, score: bm25Score(index, id, queryTokens) }));
  scored.sort((a, b) => (b.score - a.score) || a.id.localeCompare(b.id));
  return scored.slice(0, topK);
}
