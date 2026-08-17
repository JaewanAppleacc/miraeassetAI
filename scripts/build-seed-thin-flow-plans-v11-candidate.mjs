// Turn M7 Section 4: a NEW Plan revision (v0.11.candidate) -- never
// overwrites v0.10.candidate.jsonl. Adds ONLY the slot connections the 14
// newly-VERIFIED facts need to actually surface in answers -- data
// linkage only, never a per-question answer template, never a company/
// question_id Runtime branch. Two kinds of change, both minimal:
//  (a) 5 NEW slots for tokens that had no slot at all in v0.10 (Q06
//      purpose/target x2 investments, Q09 planned shares, Q20 correction
//      reason).
//  (b) 1 SWAPPED slot: Q09's existing "trust_counterparty" slot pointed
//      at the OLD, Owner-rejected CONTRACT_COUNTERPARTY Candidate
//      (fact_74a2b743fee3b410295be924, never promoted) -- it now points
//      at the Owner-approved TRUST_CONTRACT_INSTITUTION fact instead.
// Q17 and Q25 already have every slot they need in v0.10 (samsung_heavy_
// latest_contract_amount / hyosung_latest_contract_amount for Q17;
// reservation_deadline_intermediate_1-4 / reservation_deadline_final for
// Q25 -- the corrected raw_label/value_certainty live in the FACT itself,
// which the Runtime resolves live from the current VERIFIED store, so no
// Plan change is needed there) -- confirmed by direct inspection below,
// not assumed.
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const V10_PLAN_PATH = path.join(REPO, "work/domain-seed/seed-thin-flow-plans.v0.10.candidate.jsonl");
const FACTS_PATH = path.join(REPO, "work/domain-seed/seed-facts-verified.v0.8.jsonl");
const OUT_PATH = path.join(REPO, "work/domain-seed/seed-thin-flow-plans.v0.11.candidate.jsonl");
const OUT_MANIFEST_PATH = path.join(REPO, "work/domain-seed/seed-thin-flow-plans.v0.11.candidate.manifest.json");

function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function jsonl(text) { return text.trim().split("\n").map((l) => JSON.parse(l)); }
function fail(msg) { throw new Error(`PLAN_V11_BLOCKED: ${msg}`); }

const OLD_Q09_COUNTERPARTY_FACT_ID = "fact_74a2b743fee3b410295be924";
const NEW_Q09_TRUST_INSTITUTION_FACT_ID = "fact_d7f3008248d324ba2a878323";
const NEW_Q09_TRUST_INSTITUTION_EVIDENCE_ID = "evidence_4bb201438fab0e23e64ec747";

const NEW_SLOTS = {
  question_seed_v07_06: [
    { slot_name: "crane_investment_purpose", fact_id: "fact_75c2403584e5facb73b1ddf7" },
    { slot_name: "crane_investment_target", fact_id: "fact_e853c77fed4888d55bfb1eae" },
    { slot_name: "dock_investment_purpose", fact_id: "fact_1690ba78472f78be1d768b46" },
    { slot_name: "dock_investment_target", fact_id: "fact_293afe50abda3d753a570fe0" },
  ],
  question_seed_v07_09: [
    { slot_name: "acquisition_planned_shares", fact_id: "fact_df45402adfdb244214c751c5" },
  ],
  question_seed_v07_20: [
    { slot_name: "correction_reason", fact_id: "fact_0234b056c7df027a63856980" },
  ],
};

async function main() {
  const v10Bytes = await readFile(V10_PLAN_PATH);
  const v10Rows = jsonl(v10Bytes.toString("utf8"));
  const factsRows = jsonl((await readFile(FACTS_PATH)).toString("utf8"));
  const factById = new Map(factsRows.map((f) => [f.fact_id, f]));

  // -- Confirm Q17/Q25 already fully wired in v0.10 -- fail loud if not --
  const q17 = v10Rows.find((r) => r.question_id === "question_seed_v07_17");
  const q17SlotNames = new Set((q17?.slots ?? []).map((s) => s.slot_name));
  if (!q17SlotNames.has("samsung_heavy_latest_contract_amount") || !q17SlotNames.has("hyosung_latest_contract_amount")) {
    fail("Q17 v0.10 plan is missing an expected latest_contract_amount slot -- cannot assume it's already wired");
  }
  const q25 = v10Rows.find((r) => r.question_id === "question_seed_v07_25");
  const q25SlotNames = new Set((q25?.slots ?? []).map((s) => s.slot_name));
  for (const s of ["reservation_deadline_intermediate_1", "reservation_deadline_intermediate_2", "reservation_deadline_intermediate_3", "reservation_deadline_intermediate_4", "reservation_deadline_final"]) {
    if (!q25SlotNames.has(s)) fail(`Q25 v0.10 plan is missing expected slot ${s} -- cannot assume it's already wired`);
  }

  const outputRows = v10Rows.map((row) => {
    let slots = row.slots;

    // (a) Q09 slot swap: trust_counterparty must never point at the
    // Owner-rejected CONTRACT_COUNTERPARTY candidate.
    if (row.question_id === "question_seed_v07_09") {
      const trustSlot = slots.find((s) => s.slot_name === "trust_counterparty");
      if (!trustSlot) fail("question_seed_v07_09 v0.10 plan is missing the trust_counterparty slot -- cannot swap what doesn't exist");
      if (trustSlot.fact_ids[0] !== OLD_Q09_COUNTERPARTY_FACT_ID) {
        fail(`question_seed_v07_09 trust_counterparty slot does not point at the expected old fact_id -- found ${trustSlot.fact_ids[0]}, refusing to blind-swap`);
      }
      slots = slots.map((s) => (s.slot_name === "trust_counterparty"
        ? { ...s, fact_ids: [NEW_Q09_TRUST_INSTITUTION_FACT_ID], evidence_ids: [NEW_Q09_TRUST_INSTITUTION_EVIDENCE_ID] }
        : s));
    }

    // (b) add any new slots this question needs.
    const additions = NEW_SLOTS[row.question_id];
    if (additions) {
      for (const add of additions) {
        if (slots.some((s) => s.slot_name === add.slot_name)) fail(`${row.question_id}: slot ${add.slot_name} already exists in v0.10 -- refusing to duplicate`);
        const fact = factById.get(add.fact_id);
        if (!fact) fail(`${row.question_id}: fact ${add.fact_id} not found in VERIFIED facts -- cannot wire a slot to a non-existent fact`);
        slots = [...slots, { slot_name: add.slot_name, fact_ids: [add.fact_id], evidence_ids: [...fact.evidence_ids] }];
      }
    }

    return slots === row.slots ? row : { ...row, slots };
  });

  const changedQuestionIds = outputRows.filter((r, i) => r !== v10Rows[i]).map((r) => r.question_id);
  const expectedChanged = ["question_seed_v07_06", "question_seed_v07_09", "question_seed_v07_20"].sort();
  if (JSON.stringify(changedQuestionIds.sort()) !== JSON.stringify(expectedChanged)) {
    fail(`expected exactly ${expectedChanged.join(",")} to change, got ${changedQuestionIds.sort().join(",")}`);
  }

  const jsonlText = outputRows.map((r) => JSON.stringify(r)).join("\n") + "\n";
  await writeFile(OUT_PATH, jsonlText, "utf8");

  // Turn M7 Section 6: this manifest doubles as the REAL runtime-binding
  // shape (matching seed-thin-flow-plans.v0.6.manifest.json's own fields,
  // not just a descriptive "candidate" report) -- corpus_snapshot_id/
  // fact_coverage_snapshot_id/source_gold/source_coverage are what
  // assertThinPlanBinding in seed-runtime-service-adapters.mjs actually
  // cross-checks when a sandbox-only test runtime uses this plan.
  const coveragePath = path.join(REPO, "work/domain-seed/seed-fact-coverage-verified.v0.7.json");
  const coverageBytes = await readFile(coveragePath);
  const coverageJson = JSON.parse(coverageBytes.toString("utf8"));

  const manifest = {
    schema_version: "0.1.0",
    generated_at: new Date().toISOString(),
    artifact: "work/domain-seed/seed-thin-flow-plans.v0.11.candidate.jsonl",
    artifact_sha256: sha256(Buffer.from(jsonlText, "utf8")),
    record_count: outputRows.length,
    corpus_snapshot_id: coverageJson.corpus_snapshot_id,
    fact_coverage_snapshot_id: coverageJson.fact_coverage_snapshot_id,
    source_gold: "work/domain-seed/seed-gold-promotion-candidates.v0.17.jsonl",
    source_coverage: "work/domain-seed/seed-fact-coverage-verified.v0.7.json",
    forbidden_runtime_fields: ["expected_answer", "scoring_spec", "required_evidence_slots"],
    status: "CANDIDATE",
    changed_question_ids: changedQuestionIds,
    new_slots_added: Object.entries(NEW_SLOTS).flatMap(([qid, adds]) => adds.map((a) => ({ question_id: qid, slot_name: a.slot_name, fact_id: a.fact_id }))),
    swapped_slots: [{ question_id: "question_seed_v07_09", slot_name: "trust_counterparty", old_fact_id: OLD_Q09_COUNTERPARTY_FACT_ID, new_fact_id: NEW_Q09_TRUST_INSTITUTION_FACT_ID }],
    unchanged_confirmed: {
      question_seed_v07_17: "already fully wired to fact_4b6f458e85adfadde708e185 / fact_de335e5b27723ca5daac5b63 in v0.10",
      question_seed_v07_25: "already fully wired to the 5 CONTRACT_RESERVATION_DEADLINE facts in v0.10; corrected raw_label/value_certainty resolve live from the VERIFIED fact store",
    },
    source_plan_path: "work/domain-seed/seed-thin-flow-plans.v0.10.candidate.jsonl",
    source_plan_sha256: sha256(v10Bytes),
  };
  await writeFile(OUT_MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ record_count: outputRows.length, changed_question_ids: changedQuestionIds, new_slot_count: manifest.new_slots_added.length }, null, 2));
}

main().catch((error) => { console.error(error.message); process.exit(1); });
