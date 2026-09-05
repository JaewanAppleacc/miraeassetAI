// Turn AC-OFFICIAL-INTEGRATION-V1: a common run ledger/checkpoint contract
// for all four arms. This is intentionally file/object-level (not a new
// Postgres migration): the frozen `public.experiment_runs` table (Experiment
// Run v0.3, domain/interfaces/experiment-run.schema.json) belongs to the
// common Source-of-Record layer and requires corpus_snapshot_id/
// fact_coverage_snapshot_id rows this candidate-comparison track does not
// (and per CLAUDE.md section 4/13, should not) own or fabricate -- writing
// into it here would mean inventing FK-satisfying rows in a frozen common
// table, which this Turn does not do. Instead this module follows the same
// pattern the AC vector-import work already established for candidate-
// scoped state (its own additive, namespaced artifacts), just as a plain
// object contract for now. Graduating to a `disclosure_reference`-schema
// Postgres table (mirroring how migration 013 added AC-scoped tables
// without touching the frozen `public.*` tables) is a natural next step if
// this needs to survive concurrent writers -- not done this Turn.
import { createHash } from "node:crypto";

const SHA256_RE = /^[0-9a-f]{64}$/;
const SHORT_SHA_RE = /^[0-9a-f]{7,64}$/; // git commit SHAs seen in B/D run.json are 20-hex-char shortened forms

export const LEDGER_ENTRY_STATUSES = Object.freeze([
  "NOT_EXECUTED_PENDING_DEVTUNE", // A/C: infra ready, no evaluation run yet
  "REUSED_VERIFIED",              // B/D: prior result reused, SHA-verified byte-identical
  "EXECUTED",                     // a real evaluation run happened in this ledger entry
  "BLOCKED",                      // could not produce a usable entry at all
]);

export const LEDGER_ENTRY_ROLES = Object.freeze(["AC_LIVE", "BD_IMPORTED_REFERENCE"]);

export class RunLedgerValidationError extends Error {
  constructor(message, code, details = {}) {
    super(message);
    this.name = "RunLedgerValidationError";
    this.code = code;
    Object.assign(this, details);
  }
}

function sha256Hex(value) {
  return createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value), "utf8").digest("hex");
}

// entry.input_sha256 and entry.results_sha256 (nullable for A/C, not yet
// executed) are plain objects/strings of already-computed hashes -- this
// function only validates shape, it never re-hashes source files itself
// (that is each caller's own responsibility, matching how B.run.json/
// D.run.json already record their own input_sha256/results_sha256).
export function validateLedgerEntry(entry) {
  if (!entry || typeof entry !== "object") throw new RunLedgerValidationError("ledger entry must be an object", "LEDGER_ENTRY_NOT_OBJECT");
  if (entry.arm !== "A" && entry.arm !== "B" && entry.arm !== "C" && entry.arm !== "D") {
    throw new RunLedgerValidationError(`ledger entry arm must be one of A/B/C/D, got ${JSON.stringify(entry.arm)}`, "LEDGER_ENTRY_INVALID_ARM");
  }
  if (!LEDGER_ENTRY_ROLES.includes(entry.role)) {
    throw new RunLedgerValidationError(`ledger entry role must be one of ${JSON.stringify(LEDGER_ENTRY_ROLES)}, got ${JSON.stringify(entry.role)}`, "LEDGER_ENTRY_INVALID_ROLE");
  }
  if (!LEDGER_ENTRY_STATUSES.includes(entry.status)) {
    throw new RunLedgerValidationError(`ledger entry status must be one of ${JSON.stringify(LEDGER_ENTRY_STATUSES)}, got ${JSON.stringify(entry.status)}`, "LEDGER_ENTRY_INVALID_STATUS");
  }
  if (typeof entry.batch_id !== "string" || entry.batch_id === "") {
    throw new RunLedgerValidationError("ledger entry requires a non-empty batch_id (all 4 arms in one official pass must share it)", "LEDGER_ENTRY_MISSING_BATCH_ID");
  }
  if (typeof entry.code_sha256 !== "string" || !SHORT_SHA_RE.test(entry.code_sha256)) {
    throw new RunLedgerValidationError(`ledger entry code_sha256 is not a valid hex sha, got ${JSON.stringify(entry.code_sha256)}`, "LEDGER_ENTRY_INVALID_CODE_SHA");
  }
  if (typeof entry.config_sha256 !== "string" || !SHA256_RE.test(entry.config_sha256)) {
    throw new RunLedgerValidationError(`ledger entry config_sha256 is not a valid sha256, got ${JSON.stringify(entry.config_sha256)}`, "LEDGER_ENTRY_INVALID_CONFIG_SHA");
  }
  if (!entry.input_sha256 || typeof entry.input_sha256 !== "object" || Array.isArray(entry.input_sha256)) {
    throw new RunLedgerValidationError("ledger entry input_sha256 must be an object of named input hashes", "LEDGER_ENTRY_INVALID_INPUT_SHA");
  }
  for (const [name, value] of Object.entries(entry.input_sha256)) {
    if (typeof value !== "string" || !SHA256_RE.test(value)) {
      throw new RunLedgerValidationError(`ledger entry input_sha256.${name} is not a valid sha256`, "LEDGER_ENTRY_INVALID_INPUT_SHA_VALUE", { name, value });
    }
  }
  if (entry.index_sha256 !== null && (typeof entry.index_sha256 !== "string" || !SHA256_RE.test(entry.index_sha256))) {
    throw new RunLedgerValidationError("ledger entry index_sha256 must be null or a valid sha256", "LEDGER_ENTRY_INVALID_INDEX_SHA");
  }
  if (entry.results_sha256 !== null && (typeof entry.results_sha256 !== "string" || !SHA256_RE.test(entry.results_sha256))) {
    throw new RunLedgerValidationError("ledger entry results_sha256 must be null or a valid sha256", "LEDGER_ENTRY_INVALID_RESULTS_SHA");
  }
  if ((entry.status === "EXECUTED" || entry.status === "REUSED_VERIFIED") && entry.results_sha256 === null) {
    throw new RunLedgerValidationError(`ledger entry status=${entry.status} requires a non-null results_sha256`, "LEDGER_ENTRY_MISSING_RESULTS_SHA_FOR_STATUS");
  }
  return true;
}

// Enforces "no partial rerun, no mixing old/new results": every entry in
// one official pass must share the SAME batch_id, and there must be
// exactly one entry per arm (A, B, C, D) -- never a subset, never two
// entries claiming the same arm within a batch.
export function assertSingleCompleteBatch(entries) {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new RunLedgerValidationError("entries must be a non-empty array", "LEDGER_BATCH_EMPTY");
  }
  for (const entry of entries) validateLedgerEntry(entry);
  const batchIds = new Set(entries.map((e) => e.batch_id));
  if (batchIds.size !== 1) {
    throw new RunLedgerValidationError(`entries span multiple batch_ids: ${[...batchIds].join(", ")} -- mixing old/new results across batches is forbidden`, "LEDGER_BATCH_ID_MISMATCH", { batch_ids: [...batchIds] });
  }
  const arms = entries.map((e) => e.arm);
  const uniqueArms = new Set(arms);
  if (uniqueArms.size !== arms.length) {
    throw new RunLedgerValidationError("duplicate arm entries within one batch are forbidden", "LEDGER_BATCH_DUPLICATE_ARM", { arms });
  }
  const missing = ["A", "B", "C", "D"].filter((a) => !uniqueArms.has(a));
  if (missing.length > 0) {
    throw new RunLedgerValidationError(`batch is missing arm(s) ${missing.join(", ")} -- a partial-arm batch (selective rerun) is forbidden`, "LEDGER_BATCH_INCOMPLETE", { missing_arms: missing });
  }
  return Object.freeze({ batch_id: [...batchIds][0], arms: Object.freeze([...uniqueArms].sort()) });
}

// byte/SHA/pin-based reuse decision (never a heuristic or a human "looks
// the same" judgement): a prior entry may be reused ONLY if every one of
// code_sha256/config_sha256/every named input_sha256 key matches exactly.
// Any mismatch anywhere means the whole entry must be re-executed -- there
// is no partial reuse of "most" inputs.
export function decideReuseEligibility({ priorEntry, currentCodeSha256, currentConfigSha256, currentInputSha256 }) {
  if (!priorEntry) return Object.freeze({ eligible: false, reasons: ["NO_PRIOR_ENTRY"] });
  const reasons = [];
  if (priorEntry.code_sha256 !== currentCodeSha256) reasons.push(`CODE_SHA_MISMATCH: prior=${priorEntry.code_sha256} current=${currentCodeSha256}`);
  if (priorEntry.config_sha256 !== currentConfigSha256) reasons.push(`CONFIG_SHA_MISMATCH: prior=${priorEntry.config_sha256} current=${currentConfigSha256}`);
  const priorInputKeys = new Set(Object.keys(priorEntry.input_sha256 ?? {}));
  const currentInputKeys = new Set(Object.keys(currentInputSha256 ?? {}));
  const allKeys = new Set([...priorInputKeys, ...currentInputKeys]);
  for (const key of allKeys) {
    const priorValue = priorEntry.input_sha256?.[key];
    const currentValue = currentInputSha256?.[key];
    if (priorValue !== currentValue) reasons.push(`INPUT_SHA_MISMATCH[${key}]: prior=${priorValue ?? "MISSING"} current=${currentValue ?? "MISSING"}`);
  }
  return Object.freeze({ eligible: reasons.length === 0, reasons: Object.freeze(reasons) });
}

export function computeBatchId({ conditionsSha256, universeSha256, evaluationCutoffId }) {
  return sha256Hex({ conditionsSha256, universeSha256, evaluationCutoffId }).slice(0, 32);
}
