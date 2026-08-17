// Builds Plan v0.9 (CANDIDATE, schema_version "0.3.0") on top of the
// unmodified v0.8 candidate. v0.8's sub_request GROUPING (the actual fix
// for v0.7's slot-per-sub_request defect) is correct and is NOT
// redesigned here -- v0.9 only exists because this turn's common Runtime
// fixes (typed missing_reasons diagnostics, the calculation-result
// registry, the qualifier-provenance/regex fix) let several v0.8
// bindings that were ALREADY correctly authored (e.g.
// revenue_ratio_diff_disclosed_pp, amount_change_krw, the Q22 qualifier)
// finally resolve as SATISFIABLE against real data -- so most of v0.9 is
// byte-identical to v0.8's sub_request content. Only bindings/capabilities
// that the v0.9 gap-diagnostic run (scripts/build-seed-thin-flow-plans-v09-gap-diagnostic.mjs)
// shows were genuinely MIS-AUTHORED (not just blocked by a since-fixed
// Runtime gap) are corrected here, and ONLY as a binding/capability
// wording fix -- never a change to the question's real semantic ask, and
// never a weakening to match a Gold/expected answer (this script never
// reads expected_answer).
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateSubRequestsV2 } from "../domain/adapters/sub-request-vocabulary.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLAN_V06_MANIFEST_PATH = path.join(REPO, "work/domain-seed/seed-thin-flow-plans.v0.6.manifest.json");
const PLAN_V08_PATH = path.join(REPO, "work/domain-seed/seed-thin-flow-plans.v0.8.candidate.jsonl");
const PLAN_V08_MANIFEST_PATH = path.join(REPO, "work/domain-seed/seed-thin-flow-plans.v0.8.candidate.manifest.json");
const OUT_PLAN_PATH = path.join(REPO, "work/domain-seed/seed-thin-flow-plans.v0.9.candidate.jsonl");
const OUT_MANIFEST_PATH = path.join(REPO, "work/domain-seed/seed-thin-flow-plans.v0.9.candidate.manifest.json");
const OUT_MAPPING_REPORT_PATH = path.join(REPO, "work/domain-seed/seed-thin-flow-plans.v0.8-to-v0.9.mapping.report.json");

function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }

// No content changes this turn -- the v0.9 gap-diagnostic run (see
// scripts/build-seed-thin-flow-plans-v09-gap-diagnostic.mjs and this
// turn's final report) confirmed that every v0.8 binding previously
// blocked purely by the (now-fixed) suffix-guessing/qualifier-detection
// Runtime gaps resolves correctly once re-run against the SAME v0.8
// sub_request content -- none of the 11 original failures turned out to
// require a binding/capability WORDING correction. This map stays empty
// and is the explicit, auditable record of that finding; a future turn
// that DOES need a correction should add an entry here rather than
// editing v0.8's authored table directly.
const SUB_REQUEST_CORRECTIONS = {};

export async function buildSeedThinFlowPlansV09Candidate({ writeOutputs = true } = {}) {
  const [planV06ManifestBytes, planV08Bytes, planV08ManifestBytes] = await Promise.all([
    readFile(PLAN_V06_MANIFEST_PATH), readFile(PLAN_V08_PATH), readFile(PLAN_V08_MANIFEST_PATH),
  ]);
  const planV06Manifest = JSON.parse(planV06ManifestBytes.toString("utf8"));
  const planV08Records = planV08Bytes.toString("utf8").trim().split("\n").map((line) => JSON.parse(line));
  if (planV08Records.length !== 25) throw new Error(`expected 25 Plan v0.8 records, found ${planV08Records.length}`);

  const outLines = [];
  const mappingReport = [];
  for (const plan of planV08Records) {
    const correction = SUB_REQUEST_CORRECTIONS[plan.question_id];
    const subRequests = correction ? correction(plan.sub_requests) : plan.sub_requests;
    const slotNames = new Set(plan.slots.map((slot) => slot.slot_name));
    validateSubRequestsV2(subRequests, { slotNames, questionId: plan.question_id });
    outLines.push(JSON.stringify({ ...plan, sub_requests: subRequests }));
    mappingReport.push({ question_id: plan.question_id, sub_request_count: subRequests.length, corrected: Boolean(correction) });
  }

  const planText = outLines.join("\n") + "\n";
  const planBytes = Buffer.from(planText, "utf8");
  const manifest = {
    schema_version: "0.1.0",
    artifact: "work/domain-seed/seed-thin-flow-plans.v0.9.candidate.jsonl",
    artifact_sha256: sha256(planBytes),
    record_count: outLines.length,
    plan_schema_version: "0.3.0",
    corpus_snapshot_id: planV06Manifest.corpus_snapshot_id,
    fact_coverage_snapshot_id: planV06Manifest.fact_coverage_snapshot_id,
    source_plan_v08_candidate: "work/domain-seed/seed-thin-flow-plans.v0.8.candidate.jsonl",
    source_plan_v08_candidate_sha256: sha256(planV08Bytes),
    forbidden_runtime_fields: ["expected_answer", "scoring_spec", "required_evidence_slots"],
    status: "CANDIDATE",
    turn_summary: "v0.9 exists to re-run v0.8's sub_request content against this turn's common Runtime fixes (typed missing_reasons, calculation-result registry, qualifier-provenance/regex fix) -- see seed-thin-flow-plans.v0.9.gap-diagnostic.summary.json for the resulting classification. No sub_request wording was found to need correction; SUB_REQUEST_CORRECTIONS stays empty.",
    generated_at: new Date().toISOString(),
  };

  const report = {
    generated_at: manifest.generated_at,
    source_plan_v08_candidate_sha256: manifest.source_plan_v08_candidate_sha256,
    output_plan_v09_candidate_sha256: manifest.artifact_sha256,
    total_plans: mappingReport.length,
    corrected_plans: mappingReport.filter((entry) => entry.corrected).length,
    per_question: mappingReport,
  };

  if (writeOutputs) {
    await writeFile(OUT_PLAN_PATH, planText, "utf8");
    await writeFile(OUT_MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    await writeFile(OUT_MAPPING_REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  }
  return { planText, manifest, report };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { manifest, report } = await buildSeedThinFlowPlansV09Candidate({ writeOutputs: true });
  console.log(JSON.stringify({ manifest, report }, null, 2));
}
