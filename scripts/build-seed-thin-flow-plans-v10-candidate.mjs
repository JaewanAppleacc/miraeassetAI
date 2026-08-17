// Turn M3 item 6: a NEW Plan Candidate revision (v0.10, schema_version
// "0.3.0") built ONLY to wire the 8 new CANDIDATE Facts from
// scripts/build-seed-structured-gap-fact-batch-m3.mjs into the 3
// questions (Q09/Q17/Q25) whose STRUCTURED_DATA_GAP the ontology audit
// classified as REUSE_EXISTING_ONTOLOGY_NEW_RECORD. v0.9's OWN 25 records
// are copied byte-identically for every question except these 3 -- v0.9
// itself is never modified (a brand-new file, never an in-place edit).
//
// Every new slot/sub_request-membership addition below is grouped by the
// ACTUAL user-request unit each new Fact serves (never one sub_request
// per slot): the new counterparty slot joins Q09's existing decision-
// content timeline ask; the two new "latest contract amount" slots join
// Q17's existing COMPARE_VALUES ask (a match/mismatch judgment IS a
// comparison); the 5 new reservation-deadline slots join Q25's existing
// TRACE_TIMELINE ask. No new sub_request is created where an existing
// one already represents the same ask.
//
// CANDIDATE/PENDING throughout -- this Plan revision is NEVER wired into
// production Runtime by this script; a caller must explicitly choose it,
// exactly like v0.7/v0.8/v0.9 before it.
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateSubRequestsV2 } from "../domain/adapters/sub-request-vocabulary.mjs";
import { buildCandidates as buildFactBatchM3 } from "./build-seed-structured-gap-fact-batch-m3.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLAN_V09_PATH = path.join(REPO, "work/domain-seed/seed-thin-flow-plans.v0.9.candidate.jsonl");
const OUT_PLAN_PATH = path.join(REPO, "work/domain-seed/seed-thin-flow-plans.v0.10.candidate.jsonl");
const OUT_MANIFEST_PATH = path.join(REPO, "work/domain-seed/seed-thin-flow-plans.v0.10.candidate.manifest.json");

function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }

function addSlot(plan, slotName, factId, evidenceId) {
  plan.slots.push({ slot_name: slotName, fact_ids: [factId], evidence_ids: [evidenceId] });
  if (!plan.evidence_ids.includes(evidenceId)) plan.evidence_ids.push(evidenceId);
}

export async function buildSeedThinFlowPlansV10Candidate({ writeOutputs = true } = {}) {
  const planV09Bytes = await readFile(PLAN_V09_PATH);
  const planV09Records = planV09Bytes.toString("utf8").trim().split("\n").map((line) => JSON.parse(line));
  const { facts: newFacts } = await buildFactBatchM3();
  const factById = new Map(newFacts.map((f) => [f.fact_id, f]));

  const byQid = (id) => newFacts.filter((f) =>
    (id === "question_seed_v07_09" && f.metric_code === "CONTRACT_COUNTERPARTY") ||
    (id === "question_seed_v07_17" && f.metric_code === "LATEST_CONTRACT_AMOUNT") ||
    (id === "question_seed_v07_25" && f.metric_code === "CONTRACT_RESERVATION_DEADLINE")
  );

  const records = planV09Records.map((record) => {
    // Deep-clone so mutations below never touch the v0.9 record's own
    // arrays/objects (v0.9's own file is re-read fresh each run and never
    // written to by this script either way, but this keeps the two
    // in-memory representations fully independent for clarity/safety).
    const plan = JSON.parse(JSON.stringify(record));

    if (plan.question_id === "question_seed_v07_09") {
      const [counterpartyFact] = byQid(plan.question_id);
      addSlot(plan, "trust_counterparty", counterpartyFact.fact_id, counterpartyFact.evidence_ids[0]);
      const sr01 = plan.sub_requests.find((sr) => sr.sub_request_id === "sr_01");
      sr01.required_slot_names.push("trust_counterparty");
    }

    if (plan.question_id === "question_seed_v07_17") {
      const amountFacts = byQid(plan.question_id);
      const samsungHeavyFact = amountFacts.find((f) => f.corp_code === "00126478");
      const hyosungFact = amountFacts.find((f) => f.corp_code === "01316245");
      addSlot(plan, "samsung_heavy_latest_contract_amount", samsungHeavyFact.fact_id, samsungHeavyFact.evidence_ids[0]);
      addSlot(plan, "hyosung_latest_contract_amount", hyosungFact.fact_id, hyosungFact.evidence_ids[0]);
      const sr02 = plan.sub_requests.find((sr) => sr.sub_request_id === "sr_02");
      sr02.required_slot_names.push("samsung_heavy_latest_contract_amount", "hyosung_latest_contract_amount");
    }

    if (plan.question_id === "question_seed_v07_25") {
      const deadlineFacts = byQid(plan.question_id);
      const addedSlotNames = [];
      let ordinal = 1;
      for (const f of deadlineFacts.slice().sort((a, b) => a.as_of_date.localeCompare(b.as_of_date))) {
        const slotName = f.raw_label === "최종 유보기한" ? "reservation_deadline_final" : `reservation_deadline_intermediate_${ordinal++}`;
        addSlot(plan, slotName, f.fact_id, f.evidence_ids[0]);
        addedSlotNames.push(slotName);
      }
      const sr01 = plan.sub_requests.find((sr) => sr.sub_request_id === "sr_01");
      sr01.required_slot_names.push(...addedSlotNames);
    }

    return plan;
  });

  for (const plan of records) {
    if (["question_seed_v07_09", "question_seed_v07_17", "question_seed_v07_25"].includes(plan.question_id)) {
      const slotNames = new Set(plan.slots.map((s) => s.slot_name));
      validateSubRequestsV2(plan.sub_requests, { slotNames, questionId: plan.question_id });
    }
  }

  if (writeOutputs) {
    const planText = records.map((r) => JSON.stringify(r)).join("\n") + "\n";
    await writeFile(OUT_PLAN_PATH, planText, "utf8");
    const manifest = {
      schema_version: "0.1.0",
      artifact: "work/domain-seed/seed-thin-flow-plans.v0.10.candidate.jsonl",
      artifact_sha256: sha256(Buffer.from(planText, "utf8")),
      record_count: records.length,
      base_plan_path: "work/domain-seed/seed-thin-flow-plans.v0.9.candidate.jsonl",
      base_plan_sha256: sha256(planV09Bytes),
      status: "CANDIDATE",
      changed_question_ids: ["question_seed_v07_09", "question_seed_v07_17", "question_seed_v07_25"],
      new_fact_ids_referenced: [...factById.keys()],
      note: "Turn M3 item 6: additive-only slot/sub_request-membership extension for 3 questions closing REUSE_EXISTING_ONTOLOGY_NEW_RECORD structured gaps. Never wired into production Runtime by this script. Plan v0.6 and Candidates v0.7-v0.9 are untouched.",
      generated_at: new Date().toISOString(),
    };
    await writeFile(OUT_MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  }

  return { records };
}

async function main() {
  const { records } = await buildSeedThinFlowPlansV10Candidate();
  console.log(JSON.stringify({ record_count: records.length, out_path: OUT_PLAN_PATH }, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => { console.error(error.message); process.exit(1); });
}
