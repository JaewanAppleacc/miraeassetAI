// Builds a CANDIDATE-only Plan v0.7 revision that adds a structured
// `sub_requests` array (schema_version "0.2.0") on top of the existing,
// unmodified, approved Plan v0.6 records. Plan v0.6 itself is read-only
// input here and is never rewritten.
//
// GOLD ACCESS IS WHITELISTED: this script touches exactly THREE Gold
// fields -- question_id (for record matching), and, from
// expected_execution, route_policy[].required_operations and
// required_fact_slots[].slot_name (both are "what kind of thing is being
// asked", never an answer value). It never reads expected_answer,
// scoring_spec, or any evidence_span/answer-bearing field. See
// readGoldWhitelist() below -- everything the script uses from Gold flows
// through that one function, and tests/seed-thin-flow-plans-v07-candidate.test.mjs
// asserts this script's own source never contains the token
// "expected_answer".
//
// sub_request intent classification is a GENERIC keyword match over each
// slot's OWN NAME (a project-wide metric/slot naming convention, not a
// per-question rule) plus the plan's own corp_codes count (a structural
// signal, not a Gold-derived one) -- never a question_id or company-name
// branch. Because the classifier only looks at name shape, the exact
// same function produces sensible sub_requests for a synthetic slot name
// it has never seen (see the accompanying test file).
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateSubRequests } from "../domain/adapters/sub-request-vocabulary.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const GOLD_PATH = path.join(REPO, "work/domain-seed/seed-gold-promotion-candidates.v0.17.jsonl");
const PLAN_V06_PATH = path.join(REPO, "work/domain-seed/seed-thin-flow-plans.v0.6.jsonl");
const PLAN_V06_MANIFEST_PATH = path.join(REPO, "work/domain-seed/seed-thin-flow-plans.v0.6.manifest.json");
const OUT_PLAN_PATH = path.join(REPO, "work/domain-seed/seed-thin-flow-plans.v0.7.candidate.jsonl");
const OUT_MANIFEST_PATH = path.join(REPO, "work/domain-seed/seed-thin-flow-plans.v0.7.candidate.manifest.json");
const OUT_REPORT_PATH = path.join(REPO, "work/domain-seed/seed-thin-flow-plans.v0.6-to-v0.7.mapping.report.json");

const PLAN_SCHEMA_VERSION_CANDIDATE = "0.2.0";

function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function unique(values) { return [...new Set(values)]; }

// The ONLY function in this script allowed to touch a Gold record. Reads
// exactly question_id + the two whitelisted expected_execution sub-
// fields named above; every other Gold field (expected_answer,
// scoring_spec, required_evidence_slots, extensions, ...) is untouched.
function readGoldWhitelist(record) {
  const routePolicy = record.expected_execution?.route_policy ?? [];
  return {
    question_id: record.question_id,
    required_operations: unique(routePolicy.flatMap((entry) => entry.required_operations ?? [])),
    required_fact_slot_names: (record.expected_execution?.required_fact_slots ?? []).map((slot) => slot.slot_name),
  };
}

// Generic slot-name -> intent classification. Order matters (first match
// wins); purely a function of the slot_name STRING shape.
const SLOT_INTENT_RULES = [
  [/latest|effective/i, "REPORT_LATEST_STATE"],
  [/timeline/i, "TRACE_TIMELINE"],
  [/status$|decision_content$/i, "TRACE_TIMELINE"],
  [/before|after|change_vs|_diff/i, "CALCULATE_CHANGE"],
  [/_(19|20)\d{2}$/, "CALCULATE_CHANGE"],
  [/not_found|withheld|missing_reason/i, "REPORT_INFORMATION_LIMIT"],
];
function classifySlotIntent(slotName) {
  for (const [pattern, intent] of SLOT_INTENT_RULES) if (pattern.test(slotName)) return intent;
  return "EXTRACT_FACTS";
}

const INTENT_CAPABILITIES = {
  EXTRACT_FACTS: ["ENTITY_AND_PERIOD_LABELING", "EVIDENCE_REFERENCED_NARRATIVE"],
  COMPARE_VALUES: ["COMPARATIVE_CONCLUSION", "NEUTRAL_COMPARABILITY_CAVEAT", "EVIDENCE_REFERENCED_NARRATIVE"],
  TRACE_TIMELINE: ["TEMPORAL_EVENT_SYNTHESIS", "EVIDENCE_REFERENCED_NARRATIVE"],
  REPORT_LATEST_STATE: ["LATEST_EFFECTIVE_STATE", "EVIDENCE_REFERENCED_NARRATIVE"],
  REPORT_INFORMATION_LIMIT: ["INFORMATION_LIMIT_DISCLOSURE"],
  EXPLAIN_ATTRIBUTION: ["ATTRIBUTION_PRESERVATION"],
  CALCULATE_CHANGE: ["COMPARATIVE_CONCLUSION", "EVIDENCE_REFERENCED_NARRATIVE"],
};
const INTENT_OUTPUT_KINDS = {
  EXTRACT_FACTS: ["VALUE"],
  COMPARE_VALUES: ["VALUE", "PERCENT"],
  TRACE_TIMELINE: ["DATE", "STATUS"],
  REPORT_LATEST_STATE: ["VALUE", "DATE"],
  REPORT_INFORMATION_LIMIT: ["STATUS"],
  EXPLAIN_ATTRIBUTION: ["NARRATIVE"],
  CALCULATE_CHANGE: ["VALUE", "PERCENT"],
};

// Pure function of (slot names, corp_code count) -- no plan-specific ID,
// no company name, no Gold value. Exported so a test can exercise it
// directly against synthetic slot-name fixtures.
export function buildSubRequests({ slotNames, corpCodeCount }) {
  const subRequests = slotNames.map((slotName, index) => {
    const intent = classifySlotIntent(slotName);
    return {
      sub_request_id: `sr_${String(index + 1).padStart(2, "0")}`,
      intent,
      required_slot_names: [slotName],
      required_event_types: [],
      required_output_kinds: INTENT_OUTPUT_KINDS[intent],
      required_capabilities: INTENT_CAPABILITIES[intent],
    };
  });
  if (corpCodeCount >= 2) {
    subRequests.push({
      sub_request_id: `sr_${String(subRequests.length + 1).padStart(2, "0")}`,
      intent: "COMPARE_VALUES",
      required_slot_names: [...slotNames],
      required_event_types: [],
      required_output_kinds: INTENT_OUTPUT_KINDS.COMPARE_VALUES,
      required_capabilities: INTENT_CAPABILITIES.COMPARE_VALUES,
    });
  }
  return subRequests;
}

export async function buildSeedThinFlowPlansV07Candidate({ writeOutputs = true } = {}) {
  const [goldBytes, planV06Bytes, planV06ManifestBytes] = await Promise.all([
    readFile(GOLD_PATH), readFile(PLAN_V06_PATH), readFile(PLAN_V06_MANIFEST_PATH),
  ]);
  const gold = goldBytes.toString("utf8").trim().split("\n").map((line) => readGoldWhitelist(JSON.parse(line)));
  const goldById = new Map(gold.map((g) => [g.question_id, g]));
  const planV06Records = planV06Bytes.toString("utf8").trim().split("\n").map((line) => JSON.parse(line));
  const planV06Manifest = JSON.parse(planV06ManifestBytes.toString("utf8"));

  const mappingReport = [];
  const outLines = [];
  for (const plan of planV06Records) {
    const goldEntry = goldById.get(plan.question_id);
    if (!goldEntry) throw new Error(`${plan.question_id}: no matching Gold record for sub_request authoring`);
    const slotNames = plan.slots.map((slot) => slot.slot_name);
    // Sanity cross-check ONLY (never used to derive sub_request content):
    // every Gold-declared required_fact_slot name must already be
    // present in Plan v0.6's own slots -- if not, Plan v0.6 itself
    // doesn't cover what Gold asked for, which is a pre-existing data
    // problem this script must surface, not paper over.
    for (const name of goldEntry.required_fact_slot_names) {
      if (!slotNames.includes(name)) throw new Error(`${plan.question_id}: Gold required_fact_slots names "${name}" not present in Plan v0.6 slots`);
    }
    const subRequests = buildSubRequests({ slotNames, corpCodeCount: plan.corp_codes.length });
    validateSubRequests(subRequests, { slotNames: new Set(slotNames), questionId: plan.question_id });

    const candidatePlan = { ...plan, schema_version: PLAN_SCHEMA_VERSION_CANDIDATE, sub_requests: subRequests };
    outLines.push(JSON.stringify(candidatePlan));
    mappingReport.push({
      question_id: plan.question_id,
      slot_count: slotNames.length,
      corp_code_count: plan.corp_codes.length,
      sub_request_count: subRequests.length,
      intents: subRequests.map((sr) => sr.intent),
      gold_required_operations_observed: goldEntry.required_operations,
    });
  }

  const planText = outLines.join("\n") + "\n";
  const planBytes = Buffer.from(planText, "utf8");
  const manifest = {
    schema_version: "0.1.0",
    artifact: "work/domain-seed/seed-thin-flow-plans.v0.7.candidate.jsonl",
    artifact_sha256: sha256(planBytes),
    record_count: outLines.length,
    plan_schema_version: PLAN_SCHEMA_VERSION_CANDIDATE,
    corpus_snapshot_id: planV06Manifest.corpus_snapshot_id,
    fact_coverage_snapshot_id: planV06Manifest.fact_coverage_snapshot_id,
    source_gold: "work/domain-seed/seed-gold-promotion-candidates.v0.17.jsonl",
    source_gold_sha256: sha256(goldBytes),
    source_coverage: planV06Manifest.source_coverage,
    source_plan_v06: "work/domain-seed/seed-thin-flow-plans.v0.6.jsonl",
    source_plan_v06_sha256: sha256(planV06Bytes),
    forbidden_runtime_fields: ["expected_answer", "scoring_spec", "required_evidence_slots"],
    status: "CANDIDATE",
    generated_at: new Date().toISOString(),
  };

  const intentDistribution = {};
  for (const entry of mappingReport) for (const intent of entry.intents) intentDistribution[intent] = (intentDistribution[intent] ?? 0) + 1;
  const report = {
    generated_at: manifest.generated_at,
    source_plan_v06_sha256: manifest.source_plan_v06_sha256,
    output_plan_v07_candidate_sha256: manifest.artifact_sha256,
    total_plans: mappingReport.length,
    total_sub_requests: mappingReport.reduce((sum, entry) => sum + entry.sub_request_count, 0),
    intent_distribution: intentDistribution,
    per_question: mappingReport,
  };

  if (writeOutputs) {
    await writeFile(OUT_PLAN_PATH, planText, "utf8");
    await writeFile(OUT_MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    await writeFile(OUT_REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  }
  return { planText, manifest, report };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { manifest, report } = await buildSeedThinFlowPlansV07Candidate({ writeOutputs: true });
  console.log(JSON.stringify({ manifest, report }, null, 2));
}
