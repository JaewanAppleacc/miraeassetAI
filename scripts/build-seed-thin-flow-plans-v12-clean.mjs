// Turn M8 Section 2: a NEW Plan revision built strictly from the
// OFFICIAL Plan v0.6 (25 raw records) -- NEVER from the v0.7-v0.11
// research/Candidate lineage (which carries STRUCTURED sub_request_
// authority, minimum_event_count, required_output_bindings, and other
// Candidate-only policy heuristics this Turn explicitly does not want to
// inherit). Only the minimal slot additions the Owner-approved 14 Facts
// actually need are applied, plus Q18's information_limits declaration.
// The Plan store validates schema_version PER RECORD, not per file (see
// seed-question-plan-store.mjs's per-line loop) -- so only Q18's OWN
// record bumps to schema_version "0.4.0" (the only record that actually
// carries information_limits); every other record, including the 5
// slot-additions questions, keeps v0.6's original "0.1.0" (slots alone
// have always been part of the 0.1.0 base contract, no version bump
// needed). This makes the 19 fully-untouched questions -- and Q05/Q07/
// Q19/Q21/Q24 specifically -- truly byte-identical to v0.6, not merely
// "identical modulo a version bump".
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateInformationLimits, validateInformationLimitsAgainstFacts, APPROVED_ONTOLOGY_METRIC_CODES } from "../domain/adapters/information-limit-vocabulary.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLAN_V06_PATH = path.join(REPO, "work/domain-seed/seed-thin-flow-plans.v0.6.jsonl");
const PLAN_V07_PATH = path.join(REPO, "work/domain-seed/seed-thin-flow-plans.v0.7.candidate.jsonl");
const PLAN_V08_PATH = path.join(REPO, "work/domain-seed/seed-thin-flow-plans.v0.8.candidate.jsonl");
const PLAN_V09_PATH = path.join(REPO, "work/domain-seed/seed-thin-flow-plans.v0.9.candidate.jsonl");
const PLAN_V10_PATH = path.join(REPO, "work/domain-seed/seed-thin-flow-plans.v0.10.candidate.jsonl");
const PLAN_V11_PATH = path.join(REPO, "work/domain-seed/seed-thin-flow-plans.v0.11.candidate.jsonl");
const FACTS_PATH = path.join(REPO, "work/domain-seed/seed-facts-verified.v0.8.jsonl");
const COVERAGE_PATH = path.join(REPO, "work/domain-seed/seed-fact-coverage-verified.v0.7.json");
const GOLD_PATH = path.join(REPO, "work/domain-seed/seed-gold-promotion-candidates.v0.17.jsonl");
const OUT_PATH = path.join(REPO, "work/domain-seed/seed-thin-flow-plans.v0.12.clean.candidate.jsonl");
const OUT_MANIFEST_PATH = path.join(REPO, "work/domain-seed/seed-thin-flow-plans.v0.12.clean.candidate.manifest.json");

function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function jsonl(text) { return text.trim().split("\n").map((l) => JSON.parse(l)); }
function fail(msg) { throw new Error(`CLEAN_PLAN_V12_BLOCKED: ${msg}`); }

const NEW_SCHEMA_VERSION = "0.4.0";

// Every field this build adds, keyed by question_id -- ONLY the 5
// questions Turn M8 Section 5 lists. No other question_id may appear
// here (asserted below).
const NEW_SLOTS = {
  question_seed_v07_06: [
    { slot_name: "crane_investment_purpose", fact_id: "fact_75c2403584e5facb73b1ddf7" },
    { slot_name: "crane_investment_target", fact_id: "fact_e853c77fed4888d55bfb1eae" },
    { slot_name: "dock_investment_purpose", fact_id: "fact_1690ba78472f78be1d768b46" },
    { slot_name: "dock_investment_target", fact_id: "fact_293afe50abda3d753a570fe0" },
  ],
  question_seed_v07_09: [
    { slot_name: "trust_contract_institution", fact_id: "fact_d7f3008248d324ba2a878323" },
    { slot_name: "acquisition_planned_shares", fact_id: "fact_df45402adfdb244214c751c5" },
  ],
  question_seed_v07_17: [
    { slot_name: "samsung_heavy_latest_contract_amount", fact_id: "fact_4b6f458e85adfadde708e185" },
    { slot_name: "hyosung_latest_contract_amount", fact_id: "fact_de335e5b27723ca5daac5b63" },
  ],
  question_seed_v07_20: [
    { slot_name: "correction_reason", fact_id: "fact_0234b056c7df027a63856980" },
  ],
  question_seed_v07_25: [
    { slot_name: "reservation_deadline_intermediate_1", fact_id: "fact_d23da8c62edf23554215d87f" },
    { slot_name: "reservation_deadline_intermediate_2", fact_id: "fact_e34ebab1f838ec0968ce9850" },
    { slot_name: "reservation_deadline_intermediate_3", fact_id: "fact_5d7923aeff9baeb5fc5586c6" },
    { slot_name: "reservation_deadline_intermediate_4", fact_id: "fact_a3b2bdf5e64c5bb4d908d478" },
    { slot_name: "reservation_deadline_final", fact_id: "fact_f82c1de6278abecc5d72436f" },
  ],
};

const Q18_INFORMATION_LIMIT = {
  target_metric_code: "ISSUANCE_AMOUNT",
  reason_code: "NOT_DIRECTLY_DISCLOSED",
  available_input_fact_ids: ["fact_4b5dc7b1e4bb34969ad7a51e"],
  calculation_status: "DERIVED_CALCULATION_NOT_AVAILABLE",
};

export async function buildCleanPlanV12() {
  const v06Bytes = await readFile(PLAN_V06_PATH);
  const v06Rows = jsonl(v06Bytes.toString("utf8"));
  if (v06Rows.length !== 25) fail(`expected 25 rows in Plan v0.6, found ${v06Rows.length}`);
  if (v06Rows.some((r) => r.schema_version !== "0.1.0")) fail("Plan v0.6 row has an unexpected schema_version -- base assumption invalid");
  if (v06Rows.some((r) => Object.hasOwn(r, "sub_requests") || Object.hasOwn(r, "information_limits"))) {
    fail("Plan v0.6 already carries sub_requests/information_limits -- base assumption invalid");
  }

  const factsRows = jsonl((await readFile(FACTS_PATH)).toString("utf8"));
  const factsById = new Map(factsRows.map((f) => [f.fact_id, f]));

  const allNewSlotQuestionIds = Object.keys(NEW_SLOTS);
  if (allNewSlotQuestionIds.length !== 5) fail(`expected exactly 5 questions with new slots, found ${allNewSlotQuestionIds.length}`);

  const perQuestionDiff = [];
  const outputRows = v06Rows.map((baseRow) => {
    const additions = NEW_SLOTS[baseRow.question_id];
    const isQ18 = baseRow.question_id === "question_seed_v07_18";
    let slots = baseRow.slots;
    const newEvidenceIds = new Set(baseRow.evidence_ids);

    if (additions) {
      const existingSlotNames = new Set(baseRow.slots.map((s) => s.slot_name));
      for (const add of additions) {
        if (existingSlotNames.has(add.slot_name)) fail(`${baseRow.question_id}: slot ${add.slot_name} already exists in v0.6 -- refusing to duplicate`);
        const fact = factsById.get(add.fact_id);
        if (!fact) fail(`${baseRow.question_id}: fact ${add.fact_id} not found in VERIFIED facts`);
        if (fact.verification_status !== "VERIFIED") fail(`${baseRow.question_id}: fact ${add.fact_id} is not VERIFIED`);
        for (const ev of fact.evidence_ids) newEvidenceIds.add(ev);
      }
      slots = [...baseRow.slots, ...additions.map((add) => {
        const fact = factsById.get(add.fact_id);
        return { slot_name: add.slot_name, fact_ids: [add.fact_id], evidence_ids: [...fact.evidence_ids] };
      })];
    }

    const record = {
      ...baseRow,
      evidence_ids: [...newEvidenceIds].sort(),
      slots,
    };

    if (isQ18) {
      record.schema_version = NEW_SCHEMA_VERSION;
      const slotMetricCodes = new Set(baseRow.slots.map((s) => factsById.get(s.fact_ids[0])?.metric_code).filter(Boolean));
      validateInformationLimitsAgainstFacts([Q18_INFORMATION_LIMIT], { factsById, slotMetricCodes, questionId: baseRow.question_id });
      record.information_limits = validateInformationLimits([Q18_INFORMATION_LIMIT], { approvedMetricCodes: APPROVED_ONTOLOGY_METRIC_CODES, questionId: baseRow.question_id });
      for (const factId of Q18_INFORMATION_LIMIT.available_input_fact_ids) {
        const fact = factsById.get(factId);
        for (const ev of fact.evidence_ids) newEvidenceIds.add(ev);
      }
      record.evidence_ids = [...newEvidenceIds].sort();
    }

    const changed = JSON.stringify(record) !== JSON.stringify(baseRow);
    perQuestionDiff.push({
      question_id: baseRow.question_id,
      changed_beyond_schema_version_bump: changed,
      added_slot_names: additions ? additions.map((a) => a.slot_name) : [],
      information_limits_added: isQ18,
    });
    return record;
  });

  const changedQuestionIds = perQuestionDiff.filter((d) => d.changed_beyond_schema_version_bump).map((d) => d.question_id);
  const expectedChanged = [...allNewSlotQuestionIds, "question_seed_v07_18"].sort();
  if (JSON.stringify(changedQuestionIds.sort()) !== JSON.stringify(expectedChanged)) {
    fail(`changed question set mismatch: expected ${expectedChanged.join(",")}, got ${changedQuestionIds.sort().join(",")}`);
  }
  const unchangedQuestionIds = perQuestionDiff.filter((d) => !d.changed_beyond_schema_version_bump).map((d) => d.question_id);
  if (unchangedQuestionIds.length !== 19) fail(`expected 19 unchanged questions, found ${unchangedQuestionIds.length}`);

  // Explicit Section 2 requirement: Q05/Q07/Q19/Q21/Q24 must be
  // canonical-equal to v0.6 (field-for-field, modulo the uniform
  // schema_version bump) -- assert this precisely, not just "no slot
  // change".
  for (const qid of ["question_seed_v07_05", "question_seed_v07_07", "question_seed_v07_19", "question_seed_v07_21", "question_seed_v07_24"]) {
    if (changedQuestionIds.includes(qid)) fail(`${qid} must be canonical-equal to v0.6 but was changed`);
    const outputRow = outputRows.find((r) => r.question_id === qid);
    const baseRow = v06Rows.find((r) => r.question_id === qid);
    if (JSON.stringify(outputRow) !== JSON.stringify(baseRow)) fail(`${qid} must be byte-for-byte canonical-equal to its v0.6 record`);
    if (Object.hasOwn(outputRow, "sub_requests") || Object.hasOwn(outputRow, "information_limits")) fail(`${qid} must never carry sub_requests/information_limits`);
    if (outputRow.schema_version !== "0.1.0") fail(`${qid} must keep schema_version 0.1.0`);
  }

  if (outputRows.some((r) => Object.hasOwn(r, "sub_requests"))) fail("no output row may carry sub_requests -- this is the clean v0.6 lineage, not the v0.7-v0.11 research lineage");
  const schemaVersionCounts = outputRows.reduce((acc, r) => { acc[r.schema_version] = (acc[r.schema_version] ?? 0) + 1; return acc; }, {});
  if (schemaVersionCounts["0.4.0"] !== 1 || schemaVersionCounts["0.1.0"] !== 24) {
    fail(`expected exactly 1 row at schema_version 0.4.0 (Q18) and 24 at 0.1.0, found ${JSON.stringify(schemaVersionCounts)}`);
  }

  const jsonlText = outputRows.map((r) => JSON.stringify(r)).join("\n") + "\n";

  const v07Bytes = await readFile(PLAN_V07_PATH).catch(() => null);
  const v08Bytes = await readFile(PLAN_V08_PATH).catch(() => null);
  const v09Bytes = await readFile(PLAN_V09_PATH).catch(() => null);
  const v10Bytes = await readFile(PLAN_V10_PATH).catch(() => null);
  const v11Bytes = await readFile(PLAN_V11_PATH).catch(() => null);
  const outputSha256 = sha256(Buffer.from(jsonlText, "utf8"));
  const candidateLineageShas = { v07: v07Bytes && sha256(v07Bytes), v08: v08Bytes && sha256(v08Bytes), v09: v09Bytes && sha256(v09Bytes), v10: v10Bytes && sha256(v10Bytes), v11: v11Bytes && sha256(v11Bytes) };
  for (const [rev, sha] of Object.entries(candidateLineageShas)) {
    if (sha && sha === outputSha256) fail(`new clean plan byte-collides with Candidate lineage revision ${rev} -- refusing to publish an ambiguous artifact`);
  }

  const coverageJson = JSON.parse((await readFile(COVERAGE_PATH)).toString("utf8"));
  const goldBytes = await readFile(GOLD_PATH);

  return {
    outputRows, jsonlText, outputSha256,
    perQuestionDiff, changedQuestionIds, unchangedQuestionIds,
    baseShaV06: sha256(v06Bytes),
    candidateLineageShas,
    corpusSnapshotId: coverageJson.corpus_snapshot_id,
    factCoverageSnapshotId: coverageJson.fact_coverage_snapshot_id,
    sourceGoldSha256: sha256(goldBytes),
    sourceCoverageSha256: sha256(await readFile(COVERAGE_PATH)),
  };
}

async function main() {
  const result = await buildCleanPlanV12();
  await writeFile(OUT_PATH, result.jsonlText, "utf8");
  const manifest = {
    schema_version: "0.1.0",
    generated_at: new Date().toISOString(),
    artifact: "work/domain-seed/seed-thin-flow-plans.v0.12.clean.candidate.jsonl",
    artifact_sha256: result.outputSha256,
    record_count: result.outputRows.length,
    corpus_snapshot_id: result.corpusSnapshotId,
    fact_coverage_snapshot_id: result.factCoverageSnapshotId,
    source_gold: "work/domain-seed/seed-gold-promotion-candidates.v0.17.jsonl",
    source_gold_sha256: result.sourceGoldSha256,
    source_coverage: "work/domain-seed/seed-fact-coverage-verified.v0.7.json",
    source_coverage_sha256: result.sourceCoverageSha256,
    forbidden_runtime_fields: ["expected_answer", "scoring_spec", "required_evidence_slots"],
    based_on: { path: "work/domain-seed/seed-thin-flow-plans.v0.6.jsonl", sha256: result.baseShaV06 },
    explicitly_not_based_on: {
      note: "이 Plan은 v0.7~v0.11 Candidate/연구 계보를 base로 사용하지 않았다 -- v0.6에서 직접 파생됨. 아래는 그 계보 파일들과의 SHA-256 불일치를 명시적으로 기록 (byte-collision 없음을 증명).",
      candidate_lineage_sha256: result.candidateLineageShas,
    },
    changed_question_ids: result.changedQuestionIds,
    unchanged_question_ids: result.unchangedQuestionIds,
    per_question_diff: result.perQuestionDiff,
    sub_request_authority_present: false,
    status: "CANDIDATE",
  };
  await writeFile(OUT_MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({
    record_count: result.outputRows.length,
    changed_question_ids: result.changedQuestionIds,
    unchanged_count: result.unchangedQuestionIds.length,
    artifact_sha256: result.outputSha256,
    base_sha256: result.baseShaV06,
  }, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => { console.error(error.message); process.exit(1); });
}
