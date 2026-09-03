// Turn AC-IMPL, section E: A↔C pair-diff. vFINAL's own rule ("쌍 내(A↔C,
// B↔D)는 dense 플래그 외 모든 조건 동일 보장") only allows a fixed set of
// top-level config keys to differ between config.A.json and config.C.json.
// Anything else that differs is CONFIG_PAIR_MISMATCH -- reject, never warn
// and continue.
export const ALLOWED_PAIR_DIFF_KEYS = Object.freeze([
  "arm_code", "arm_id", "dense", "embedding", "rrf",
  // Turn AC-VFINAL-ALIGNMENT-AND-DISCOVERY, section E: the new named k/method
  // fields that replace the ambiguous final_top_k. bm25_candidate_k/
  // retrieval_output_k/primary_evaluation_k/reported_cutoffs/k_field_note
  // are deliberately NOT listed here -- they must stay identical between A
  // and C (vFINAL section D), so a real divergence there still fails
  // CONFIG_PAIR_MISMATCH. Only the fields directly tied to the dense
  // ablation itself may differ.
  "retrieval_method", "dense_candidate_k", "rrf_constant", "rrf_candidate_set",
  // Turn AC-VFINAL-ALIGNMENT-AND-DISCOVERY, section N: `readiness` reports
  // PER-ARM state (bm25_ready/full_dense_ready/official_4arm_execution_ready)
  // -- full_dense_ready is structurally meaningless for arm C (dense OFF),
  // so this subtree legitimately differs between A/C, same as dense/rrf.
  // `discovery` (the shared Discovery attempt identity/counts) is NOT
  // listed here -- it must stay byte-identical between config.A.json and
  // config.C.json, since both arms search the SAME underlying attempt.
  "readiness",
]);

function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (typeof a !== "object") return false;
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((key) => deepEqual(a[key], b[key]));
}

// Compares only TOP-LEVEL keys, as vFINAL section E's own field list is
// top-level (arm_code/arm_id, corpus SHA, chunker id/config, BM25 ..., etc)
// -- a nested difference inside an ALLOWED key (e.g. dense.candidate_count)
// is not separately flagged, since the whole `dense` subtree is allowed to
// differ by design (dense is literally what A/C ablate).
export function computeConfigPairDiff(configA, configC) {
  const keys = new Set([...Object.keys(configA), ...Object.keys(configC)]);
  const diffKeys = [];
  for (const key of keys) {
    if (!deepEqual(configA[key], configC[key])) diffKeys.push(key);
  }
  const disallowedKeys = diffKeys.filter((key) => !ALLOWED_PAIR_DIFF_KEYS.includes(key));
  return Object.freeze({
    diff_keys: Object.freeze(diffKeys),
    disallowed_keys: Object.freeze(disallowedKeys),
    ok: disallowedKeys.length === 0,
  });
}

export class ConfigPairMismatchError extends Error {
  constructor(disallowedKeys) {
    super(`CONFIG_PAIR_MISMATCH: config.A.json and config.C.json differ on non-allowed key(s): ${disallowedKeys.join(", ")}`);
    this.name = "ConfigPairMismatchError";
    this.code = "CONFIG_PAIR_MISMATCH";
    this.disallowed_keys = disallowedKeys;
  }
}

export function assertConfigPairValid(configA, configC) {
  const diff = computeConfigPairDiff(configA, configC);
  if (!diff.ok) throw new ConfigPairMismatchError(diff.disallowed_keys);
  return diff;
}
