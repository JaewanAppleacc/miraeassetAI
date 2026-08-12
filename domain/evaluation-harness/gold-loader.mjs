// Gold Loader. Validates against this repository's own Gold contract —
// domain/contracts.mjs (validateEvaluationGoldV02, findEvaluationLeakage,
// validateEvaluationSplitLifecycle) — imported directly, never a bundled
// copy, so the Harness can never drift from whatever the Gold/Lifecycle
// contract actually is today.
//
// SANDBOX eligibility is derived SOLELY from a validated Split Lifecycle
// record's split_lock_status. This mirrors domain/runtime/
// evaluation-usage-ledger.mjs's own canUseSplit rule exactly: "Provisional
// (not yet chain-closure-locked): the ONLY allowed execution is SANDBOX,
// regardless of assigned_split... Once locked, assigned_split becomes
// authoritative and SANDBOX is no longer available at all." A record's
// `assigned_split` is its real, permanent DEV_TUNE/DEV_CHECK/HOLDOUT
// assignment (EvaluationSplitLifecycle's assigned_split enum has no
// "SANDBOX" member at all -- validateEvaluationSplitLifecycle rejects one);
// SANDBOX readiness is a separate question, answered only by
// split_lock_status === "PROVISIONAL_UNTIL_CHAIN_CLOSURE". Once a question
// is LOCKED_BY_CHAIN or LOCKED_BY_COVERAGE it is a "real" official
// DEV_TUNE/DEV_CHECK/HOLDOUT question and can never be loaded under
// SANDBOX again, no matter what sandbox_allowlist says.
//
// sandbox_allowlist is a NARROWING filter only, never an independent grant:
// it can shrink the provisional-and-validated eligible set, but naming a
// HOLDOUT/DEV_CHECK (or any non-provisional) question_id in it can never
// make that question loadable under SANDBOX.
import { readFile } from "node:fs/promises";
import { validateEvaluationGoldV02, findEvaluationLeakage, validateEvaluationSplitLifecycle } from "../contracts.mjs";

export async function loadGold(path, split, { sandboxAllowlist = null, lifecycle = null } = {}) {
  const text = await readFile(path, "utf8");
  const records = [];
  const errors = [];
  const ids = new Set();
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch (error) {
      errors.push(`line ${index + 1}: invalid JSON: ${error.message}`);
      continue;
    }
    for (const error of validateEvaluationGoldV02(record)) errors.push(`line ${index + 1}: ${error}`);
    if (ids.has(record.question_id)) errors.push(`line ${index + 1}: duplicate question_id ${record.question_id}`);
    ids.add(record.question_id);
    records.push(record);
  }
  errors.push(...findEvaluationLeakage(records));
  if (errors.length) throw new Error(`Gold validation failed:\n${errors.join("\n")}`);

  if (split !== "SANDBOX") {
    return records.filter((record) => record.split === split);
  }

  // No lifecycle at all -> no validated provisional state can be proven for
  // anything -> fail-closed to zero, regardless of sandbox_allowlist.
  if (!(lifecycle instanceof Map)) return [];

  const provisionallyEligible = new Set();
  const invalidLifecycleErrors = [];
  for (const record of records) {
    const state = lifecycle.get(record.question_id) ?? lifecycle.get(record.evaluation_group_id);
    // No lifecycle record AT ALL for this question is not an error -- the
    // existing fail-closed policy simply excludes it from SANDBOX. But a
    // lifecycle record that DOES exist and fails schema validation is a
    // real, actionable problem (a corrupt file, a bad hand-edit, a stale
    // format) -- silently treating it the same as "absent" would hide that
    // from the operator behind an innocuous-looking empty/short SANDBOX
    // set. This aborts the whole load instead.
    if (!state) continue;
    const shapeErrors = validateEvaluationSplitLifecycle(state);
    if (shapeErrors.length > 0) {
      invalidLifecycleErrors.push(`question_id ${record.question_id}: invalid lifecycle record: ${shapeErrors.join("; ")}`);
      continue;
    }
    if (state.split_lock_status !== "PROVISIONAL_UNTIL_CHAIN_CLOSURE") continue; // locked -> SANDBOX no longer available
    provisionallyEligible.add(record.question_id);
  }
  if (invalidLifecycleErrors.length > 0) {
    throw new Error(`Lifecycle validation failed:\n${invalidLifecycleErrors.join("\n")}`);
  }

  if (Array.isArray(sandboxAllowlist)) {
    const named = new Set(sandboxAllowlist);
    for (const id of provisionallyEligible) {
      if (!named.has(id)) provisionallyEligible.delete(id);
    }
  }

  return records.filter((record) => provisionallyEligible.has(record.question_id));
}
