// Turn A2-LATE-EXPANSION, section C: stable PASS/REJECT/UNRESOLVED refill
// over an already-frozen arm A top-20. This module performs NO scoring, NO
// re-ranking, and NO tie-break logic of its own -- it only walks the
// existing rank order once and decides, per slot, whether that slot's
// existing item counts toward finalTopK. It never reads a chunk_id/rank
// that is not already present in `frozenTop20`, so a candidate outside the
// frozen top-20 can never enter finalTopK.
//
// `validationResults`: an array of { chunkId, status, reason? } produced by
// an external validator (out of this module's scope -- this module does not
// call buildNodeGroundedEvidence or run any validator itself). `status` is
// one of "PASS" | "REJECT" | "UNRESOLVED". A frozenTop20 item with no
// matching validationResults entry is treated as UNRESOLVED (fail-closed
// default -- see Section C: "UNRESOLVED은 안전상 채택하지 않는다"), recorded
// with reason "NO_VALIDATION_RESULT".

export const VALIDATION_STATUS = Object.freeze({ PASS: "PASS", REJECT: "REJECT", UNRESOLVED: "UNRESOLVED" });

function buildValidationLookup(validationResults) {
  const map = new Map();
  for (const entry of validationResults ?? []) {
    if (!entry || typeof entry.chunkId !== "string") continue;
    map.set(entry.chunkId, entry);
  }
  return map;
}

export function applyStableEvidenceFilter({ frozenTop20, validationResults, finalK }) {
  if (!Array.isArray(frozenTop20)) throw new TypeError("frozenTop20 must be an array");
  if (!Number.isInteger(finalK) || finalK < 1) throw new TypeError("finalK must be a positive integer");

  const lookup = buildValidationLookup(validationResults);
  const accepted = [];
  const rejected = [];
  const unresolved = [];
  const refillTrace = [];

  // Single pass over the EXISTING rank order -- no sort, no re-score, no
  // tie-break change. finalTopK below is exactly "the next existing-rank
  // PASS candidates", i.e. the stable refill Section C requires.
  for (const item of frozenTop20) {
    const chunkId = item?.chunk_id ?? null;
    const rank = item?.rank ?? null;
    const validation = chunkId !== null ? lookup.get(chunkId) : undefined;
    const status = validation?.status ?? VALIDATION_STATUS.UNRESOLVED;
    const reason = validation?.reason ?? (validation === undefined ? "NO_VALIDATION_RESULT" : null);

    if (status === VALIDATION_STATUS.PASS) {
      accepted.push(item);
    } else if (status === VALIDATION_STATUS.REJECT) {
      rejected.push(item);
    } else {
      unresolved.push(item);
    }

    refillTrace.push(Object.freeze({
      rank, chunkId, validationStatus: status, reason: reason ?? null,
      // Filled in below once we know the finalK cutoff over `accepted`.
      includedInFinalTopK: false,
    }));
  }

  const finalTopK = accepted.slice(0, finalK);
  const finalTopKChunkIds = new Set(finalTopK.map((item) => item.chunk_id));

  const finalizedTrace = refillTrace.map((entry) => Object.freeze({
    ...entry,
    includedInFinalTopK: entry.chunkId !== null && finalTopKChunkIds.has(entry.chunkId)
      && entry.validationStatus === VALIDATION_STATUS.PASS,
  }));

  return Object.freeze({
    accepted: Object.freeze(accepted),
    rejected: Object.freeze(rejected),
    unresolved: Object.freeze(unresolved),
    finalTopK: Object.freeze(finalTopK),
    finalTopKShortfall: Math.max(0, finalK - finalTopK.length),
    refillTrace: Object.freeze(finalizedTrace),
  });
}
