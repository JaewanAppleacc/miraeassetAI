import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { abortReason, RequestAbortedError } from "../runtime/abortable.mjs";
import { validateSubRequests, validateSubRequestsV2 } from "./sub-request-vocabulary.mjs";
import { validateInformationLimits, APPROVED_ONTOLOGY_METRIC_CODES } from "./information-limit-vocabulary.mjs";

// "0.1.0" (existing, unchanged): no sub_requests field at all -- legacy
// plans stay valid exactly as before. "0.2.0" (CANDIDATE, v0.7): slot-
// per-sub_request shape, sub_requests REQUIRED and structurally
// validated -- kept exactly as-is for v0.7 audit history. "0.3.0"
// (CANDIDATE, v0.8+): grouped-sub_request shape with output-kind claim
// bindings, minimum_event_count, requires_chronological_order,
// information_limit_allowed (see sub-request-vocabulary.mjs's
// validateSubRequestsV2). "0.4.0" (CANDIDATE, Turn M8): a DIFFERENT,
// unrelated feature -- `information_limits` (see information-limit-
// vocabulary.mjs) -- honestly declares that a requested, Owner-approved
// ontology metric_code has no direct-disclosure Fact for this question,
// so the Composer can render that absence truthfully. This is NOT a
// continuation of the "0.2.0"/"0.3.0" sub_requests research lineage --
// a "0.4.0" plan record carries `information_limits`, never
// `sub_requests` (enforced below, same "explicit absence, never silent
// omission" rule the legacy 0.1.0/sub_requests pairing already uses). A
// plan record's own schema_version selects which contract it must
// satisfy; nothing about "0.1.0"/"0.2.0"/"0.3.0" changes.
const PLAN_SCHEMA_VERSION_LEGACY = "0.1.0";
const PLAN_SCHEMA_VERSION_CANDIDATE_SUB_REQUESTS = "0.2.0";
const PLAN_SCHEMA_VERSION_CANDIDATE_SUB_REQUESTS_V2 = "0.3.0";
const PLAN_SCHEMA_VERSION_CANDIDATE_INFORMATION_LIMITS = "0.4.0";

const sha256 = (buffer) => createHash("sha256").update(buffer).digest("hex");
const questionHash = (question) => createHash("sha256").update(question).digest("hex");
function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value); for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}
function decode(buffer, source) {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(buffer); }
  catch (error) { throw new Error(`${source}: invalid UTF-8: ${error.message}`); }
}

export async function createSeedQuestionPlanStore({ planPath, manifestPath } = {}) {
  if (!planPath || !manifestPath) throw new Error("planPath and manifestPath are required");
  const [planBuffer, manifestBuffer] = await Promise.all([readFile(planPath), readFile(manifestPath)]);
  const manifest = JSON.parse(decode(manifestBuffer, manifestPath));
  if (!/^[0-9a-f]{64}$/.test(manifest.artifact_sha256) || sha256(planBuffer) !== manifest.artifact_sha256) throw new Error("question plan artifact hash mismatch");
  if (typeof manifest.corpus_snapshot_id !== "string" || typeof manifest.fact_coverage_snapshot_id !== "string") throw new Error("question plan manifest snapshot is missing");
  const index = new Map();
  for (const [lineIndex, line] of decode(planBuffer, planPath).split(/\r?\n/).filter(Boolean).entries()) {
    const plan = JSON.parse(line);
    const allowed = new Set(["schema_version", "question_id", "question_sha256", "as_of_date", "corp_codes", "evidence_ids", "slots", "sub_requests", "information_limits"]);
    if (Object.keys(plan).some((key) => !allowed.has(key))) throw new Error(`${planPath}:${lineIndex + 1}: unexpected plan field`);
    if (
      ![PLAN_SCHEMA_VERSION_LEGACY, PLAN_SCHEMA_VERSION_CANDIDATE_SUB_REQUESTS, PLAN_SCHEMA_VERSION_CANDIDATE_SUB_REQUESTS_V2, PLAN_SCHEMA_VERSION_CANDIDATE_INFORMATION_LIMITS].includes(plan.schema_version)
      || !/^question_[a-z0-9_.-]+$/.test(plan.question_id) || !/^[0-9a-f]{64}$/.test(plan.question_sha256)
    ) throw new Error(`${planPath}:${lineIndex + 1}: invalid plan identity`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(plan.as_of_date) || !Array.isArray(plan.corp_codes) || plan.corp_codes.some((code) => !/^\d{8}$/.test(code))) throw new Error(`${plan.question_id}: invalid query dimensions`);
    if (!Array.isArray(plan.evidence_ids) || plan.evidence_ids.some((id) => !/^evidence_[0-9a-f]{24}$/.test(id))) throw new Error(`${plan.question_id}: invalid evidence_ids`);
    if (!Array.isArray(plan.slots) || plan.slots.length === 0 || index.has(plan.question_id)) throw new Error(`${planPath}:${lineIndex + 1}: invalid/duplicate plan`);
    for (const slot of plan.slots) {
      if (typeof slot?.slot_name !== "string" || !Array.isArray(slot.fact_ids) || !Array.isArray(slot.evidence_ids) ||
          slot.fact_ids.some((id) => !/^fact_[0-9a-f]{24}$/.test(id)) || slot.evidence_ids.some((id) => !/^evidence_[0-9a-f]{24}$/.test(id))) {
        throw new Error(`${plan.question_id}: invalid slot`);
      }
    }
    if (Object.hasOwn(plan, "expected_answer") || Object.hasOwn(plan, "scoring_spec") || Object.hasOwn(plan, "required_evidence_slots")) throw new Error(`${plan.question_id}: evaluation answer material is forbidden in Runtime plans`);
    if (plan.schema_version === PLAN_SCHEMA_VERSION_CANDIDATE_SUB_REQUESTS) {
      validateSubRequests(plan.sub_requests, { slotNames: new Set(plan.slots.map((slot) => slot.slot_name)), questionId: plan.question_id });
    } else if (plan.schema_version === PLAN_SCHEMA_VERSION_CANDIDATE_SUB_REQUESTS_V2) {
      validateSubRequestsV2(plan.sub_requests, { slotNames: new Set(plan.slots.map((slot) => slot.slot_name)), questionId: plan.question_id });
    } else if (Object.hasOwn(plan, "sub_requests")) {
      // Legacy (0.1.0) plans explicitly may not carry sub_requests --
      // the absence is the "explicitly reported" no-structured-sub-
      // requests state; a 0.1.0 record that DOES carry one is a
      // schema_version/content mismatch, not silently accepted.
      throw new Error(`${plan.question_id}: sub_requests requires schema_version ${PLAN_SCHEMA_VERSION_CANDIDATE_SUB_REQUESTS} or ${PLAN_SCHEMA_VERSION_CANDIDATE_SUB_REQUESTS_V2}`);
    }
    if (plan.schema_version === PLAN_SCHEMA_VERSION_CANDIDATE_INFORMATION_LIMITS) {
      validateInformationLimits(plan.information_limits, { approvedMetricCodes: APPROVED_ONTOLOGY_METRIC_CODES, questionId: plan.question_id });
    } else if (Object.hasOwn(plan, "information_limits")) {
      // Same "explicit absence, never silent omission" rule as
      // sub_requests above: a plan on any OTHER schema_version that
      // carries information_limits is a schema_version/content mismatch,
      // not silently accepted.
      throw new Error(`${plan.question_id}: information_limits requires schema_version ${PLAN_SCHEMA_VERSION_CANDIDATE_INFORMATION_LIMITS}`);
    }
    index.set(plan.question_id, deepFreeze(plan));
  }
  if (index.size !== manifest.record_count) throw new Error("question plan record count mismatch");
  return Object.freeze({
    resolve(questionId, question, { signal } = {}) {
      if (signal?.aborted) throw new RequestAbortedError(abortReason(signal));
      const plan = index.get(questionId);
      if (!plan || typeof question !== "string" || questionHash(question) !== plan.question_sha256) return null;
      return plan;
    },
    count() { return index.size; },
    context: deepFreeze({ corpus_snapshot_id: manifest.corpus_snapshot_id, fact_coverage_snapshot_id: manifest.fact_coverage_snapshot_id }),
  });
}
