// Turn M3: builds a NEW remediation matrix revision (v0.3) tracking the
// SAME 24 FIX_REQUIRED notes on seed-response-owner-decision.v0.7
// (unmodified), comparing the pre-Turn-M3 wire (r8) against the post-
// Turn-M3 wire (r9). Never overwrites matrix v0.1/v0.2 -- those stay
// exactly as Turn M/M2 left them. This script itself may name
// question_ids/companies (an AUDIT/REPORTING artifact, not Runtime
// synthesis code).
//
// Status vocabulary (Turn M3 item 12): RESOLVED / IMPLEMENTATION_REQUIRED /
// CANDIDATE_DATA_REVIEW_REQUIRED / PLAN_CANDIDATE_REVIEW_REQUIRED /
// ONTOLOGY_PROPOSAL_REQUIRED / SOURCE_DATA_NOT_AVAILABLE /
// OWNER_POLICY_DECISION_REQUIRED. "구조화하지 않았다" is never labeled
// SOURCE_DATA_NOT_AVAILABLE (that status is reserved for a case where the
// needed information genuinely does not exist anywhere in the corpus);
// "시간이 부족했다" is never labeled BLOCKED (not used in this matrix at
// all -- every remaining item is a concretely actionable next step:
// either an Owner review of an already-authored Candidate, or an
// ontology-extension proposal awaiting Owner sign-off).
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DECISION_PATH = path.join(REPO, "work/handoff/seed-final-response-owner-review/results/seed-response-owner-decision.v0.7.jsonl");
const MATRIX_V02_PATH = path.join(REPO, "work/handoff/seed-final-response-owner-review/results/seed-response-remediation-matrix.v0.2.jsonl");
const WIRE_R8_INDEX = path.join(REPO, "work/domain-seed/seed-harness-v07-wire.r8/index.json");
const WIRE_R9_INDEX = path.join(REPO, "work/domain-seed/seed-harness-v07-wire.r9/index.json");
const ONTOLOGY_AUDIT_PATH = path.join(REPO, "work/handoff/seed-final-response-owner-review/results/seed-response-structured-gap-ontology-audit.v0.1.json");
const OUT_DIR = path.join(REPO, "work/handoff/seed-final-response-owner-review/results");
const OUT_PATH = path.join(OUT_DIR, "seed-response-remediation-matrix.v0.3.jsonl");
const OUT_MANIFEST_PATH = path.join(OUT_DIR, "seed-response-remediation-matrix.v0.3.manifest.json");

function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }

const IMPLEMENTATION_FILES_COMMON = [
  "domain/flows/synthesis/response-composer.mjs",
  "domain/flows/synthesis/synthesis-signal-planner.mjs",
  "domain/flows/synthesis/final-synthesis-validator.mjs",
];
const CANDIDATE_ARTIFACT_FILES = [
  "scripts/build-seed-structured-gap-fact-batch-m3.mjs",
  "work/domain-seed/seed-facts-candidates.v0.8.delta.jsonl",
  "work/domain-seed/seed-structured-owner-decision.v0.8-batch.template.jsonl",
  "scripts/build-seed-thin-flow-plans-v10-candidate.mjs",
  "work/domain-seed/seed-thin-flow-plans.v0.10.candidate.jsonl",
];

const REMEDIATION = {
  question_seed_v07_02: { items: [], status: "RESOLVED", tests: [], note: "Unchanged since Turn M2." },
  question_seed_v07_03: { items: [], status: "RESOLVED", tests: [], note: "Unchanged since Turn M2." },
  question_seed_v07_04: { items: [], status: "RESOLVED", tests: [], note: "Unchanged since Turn M2." },
  question_seed_v07_05: { items: [], status: "RESOLVED", tests: [], note: "Unchanged since Turn M2." },
  question_seed_v07_06: { items: ["item9-Q06"], status: "ONTOLOGY_PROPOSAL_REQUIRED", tests: [], note: "Ontology audit (Turn M3 item 2): investment purpose/target has no safe existing metric_code or grouping heuristic. Formal proposal recorded in seed-response-structured-gap-ontology-audit.v0.1.json (INVESTMENT_PURPOSE/INVESTMENT_TARGET_ASSET). Not implemented this Turn -- awaiting Owner ontology-extension approval, never fabricated." },
  question_seed_v07_07: { items: ["item7A"], status: "RESOLVED", tests: ["synthesis-turn-m-capabilities.test.mjs:R"], note: "Turn M3 item 7A: renderProductLifecycleConclusion (generic EVENT_STATUS+LAUNCH_STATUS shape detector) + renderNarrativeSourceSentences (raw_value_text disclosure). Real Q07 data: 'EU 집행위원회 최종 판매 허가 획득 이후 2025년 하반기 5개 제품군 출시 완료 단계로 진행되었습니다. 다만 개별 항목별 세부 시점·실적은 구조화 자료에서 추가로 확인되지 않습니다.' plus 2 narrative-source sentences from the SAME already-VERIFIED Facts. synthesis: PASS. No new structured data needed (see ontology audit's NOT_ACTUALLY_REQUIRED classification)." },
  question_seed_v07_08: { items: ["item8-narrative-source"], status: "RESOLVED", tests: ["synthesis-turn-m-capabilities.test.mjs:O"], note: "Turn M3 item 8/COMPOSE_EXISTING_FACTS: fact_e5ad6617ee0e6287fb222ce3's raw_value_text (already VERIFIED, already selected by Plan v0.6) contains the full 2025-02-18 decision / 2025-02-20 completion narrative. renderNarrativeSourceSentences now surfaces it: '정기공시에는 \"※ 2025년 2월 18일 ... 소각을 결정하였고 ... 2025년 2월 20일 ... 소각을 완료하였습니다.\"라고 기재되어 있습니다.' synthesis: PASS. No new structured data needed." },
  question_seed_v07_09: { items: ["item8-narrative-source", "item4-Q09-candidate"], status: "CANDIDATE_DATA_REVIEW_REQUIRED", tests: ["synthesis-turn-m-capabilities.test.mjs:O"], note: "Contract amount (500,000,000,000원), termination reason, and retired-share count (10,347,131주) are now RESOLVED generically via NARRATIVE_SOURCE_DISCLOSURE (real Q09 data, no new structured data needed). Counterparty (NH투자증권) is CLOSED via a NEW CANDIDATE Fact (fact_74a2b743fee3b410295be924, CONTRACT_COUNTERPARTY reused) -- sandbox-verified rendering correct, but not yet Owner-promoted, so still requires review. The remaining '예정수량 9,861,932주' sub-item is ONTOLOGY_PROPOSAL_REQUIRED (no safe existing metric_code -- see ontology audit)." },
  question_seed_v07_10: { items: [], status: "RESOLVED", tests: [], note: "Unchanged since Turn M2." },
  question_seed_v07_11: { items: [], status: "RESOLVED", tests: [], note: "Unchanged since Turn M2." },
  question_seed_v07_12: { items: [], status: "RESOLVED", tests: [], note: "Unchanged since Turn M2." },
  question_seed_v07_13: { items: [], status: "RESOLVED", tests: [], note: "Unchanged since Turn M2." },
  question_seed_v07_14: { items: [], status: "RESOLVED", tests: [], note: "Unchanged since Turn M2." },
  question_seed_v07_15: { items: [], status: "RESOLVED", tests: [], note: "Unchanged since Turn M2." },
  question_seed_v07_16: { items: [], status: "RESOLVED", tests: [], note: "Unchanged since Turn M2." },
  question_seed_v07_17: { items: ["item4-Q17-candidate"], status: "CANDIDATE_DATA_REVIEW_REQUIRED", tests: [], note: "2 NEW Candidate Facts authored (fact_4b6f458e85adfadde708e185 for 삼성중공업, fact_de335e5b27723ca5daac5b63 for 효성중공업), both metric_code LATEST_CONTRACT_AMOUNT reused, both grounded against ALREADY-VERIFIED Evidence linked_slot_names 'samsung_heavy_correction'/'hyosung_original'. Sandbox-verified (scripts/verify-m3-candidates-sandbox.mjs): once promoted, thin-structured-flow.mjs's EXISTING Turn M2 item 6A match-check loop finds this pair automatically (no new Runtime code) and BOTH companies show MATCH (0 difference) against their real TERMINATION_AMOUNT. Awaiting Owner promotion." },
  question_seed_v07_18: { items: ["item8-narrative-source"], status: "RESOLVED", tests: ["synthesis-turn-m-capabilities.test.mjs:O"], note: "fact_4597ff14b5448794ef892877 (initial: 69,809주/2,816,793,150원) and fact_4b5dc7b1e4bb34969ad7a51e (corrected: 54,495주/40,350원) -- both already VERIFIED, already selected -- now render via NARRATIVE_SOURCE_DISCLOSURE. Real Q18 data shows both values, synthesis: PASS. No new structured data needed." },
  question_seed_v07_19: { items: ["item7B", "item8-attribution-verb-fix"], status: "RESOLVED", tests: ["synthesis-turn-m-capabilities.test.mjs:Q,P"], note: "Turn M3 item 7B: renderFactLevelLifecycleTransition (generic *_STATUS + arrow-shaped raw_label detector). Real Q19 data: '확인 결과 LOI에서 본계약 체결 확정으로 전환됐습니다.' Also fixes the '판단했습니다' misuse Turn M3 item 8 flagged (the quoted text was a fixed DART category-name compound noun '투자판단 관련 주요경영사항', not a company judgment -- now correctly renders '...라고 기재되어 있습니다.'). synthesis: PASS." },
  question_seed_v07_20: { items: ["item9-Q20"], status: "ONTOLOGY_PROPOSAL_REQUIRED", tests: [], note: "Ontology audit (Turn M3 item 2): the 2024-11-29 correction-reason Evidence ('변경계약 체결 지연으로 인한 계약종료일 정정', already VERIFIED, exact match to the Owner note) has no accompanying terminal value in the SAME document (the actual corrected values were disclosed 6 days later in a different document) -- attaching it to an existing DATE-typed metric_code would misuse that metric, and attaching it to the later document would misattribute provenance. Formal proposal recorded (CORRECTION_REASON). Runtime never regex-parses Q20's own sentence out of raw text (explicitly forbidden by Turn M3 item 4)." },
  question_seed_v07_21: { items: ["item7C"], status: "RESOLVED", tests: ["synthesis-turn-m-capabilities.test.mjs:S"], note: "Turn M3 item 7C: renderIndirectConfirmationSentences (generic DART cross-reference phrasing detector, never Q21-specific). Real Q21 data: '2024년 3월 12일에 공시된 [연장결정]주요사항보고서(자기주식취득 신탁계약 체결 결정) 관련 사실은 후속 공시(major_20240808000377)의 설명을 통해 간접 확인됩니다.' synthesis: PASS." },
  question_seed_v07_22: { items: [], status: "RESOLVED", tests: [], note: "Unchanged since Turn M2." },
  question_seed_v07_23: { items: [], status: "RESOLVED", tests: [], note: "Unchanged since Turn M2." },
  question_seed_v07_24: { items: [], status: "RESOLVED", tests: [], note: "Unchanged since Turn M2." },
  question_seed_v07_25: { items: ["item4-Q25-candidate"], status: "CANDIDATE_DATA_REVIEW_REQUIRED", tests: [], note: "5 NEW Candidate Facts authored (1 per correction step + final), metric_code CONTRACT_RESERVATION_DEADLINE reused (the SAME metric the existing '최초 유보기한' Fact already uses), each grounded against ALREADY-VERIFIED Evidence carrying pre-existing linked_slot_names ('reservation_deadline_intermediate'/'reservation_deadline_final') matching this exact gap. Sandbox-verified: renders as a clean chronological multi-period list (2023-12-31 -> 03-30 -> 05-31 -> 06-30 -> 07-30 -> 2030-12-31 final), synthesis: PASS. Awaiting Owner promotion." },
};

async function main() {
  const decisionLines = (await readFile(DECISION_PATH, "utf8")).trim().split("\n").map((l) => JSON.parse(l));
  const matrixV02Lines = (await readFile(MATRIX_V02_PATH, "utf8")).trim().split("\n").map((l) => JSON.parse(l));
  const wireR8Index = JSON.parse(await readFile(WIRE_R8_INDEX, "utf8"));
  const wireR9Index = JSON.parse(await readFile(WIRE_R9_INDEX, "utf8"));
  const r8ByQid = new Map(wireR8Index.entries.map((e) => [e.question_id, e]));
  const r9ByQid = new Map(wireR9Index.entries.map((e) => [e.question_id, e]));
  const v02ByQid = new Map(matrixV02Lines.map((l) => [l.question_id, l]));

  const fixRequired = decisionLines.filter((l) => l.owner_disposition === "FIX_REQUIRED");
  if (fixRequired.length !== 24) throw new Error(`BLOCKER: expected 24 FIX_REQUIRED records, found ${fixRequired.length}`);
  if (matrixV02Lines.length !== 24) throw new Error(`BLOCKER: expected matrix v0.2 to have 24 rows, found ${matrixV02Lines.length}`);

  const rows = [];
  for (const record of fixRequired) {
    const remediation = REMEDIATION[record.question_id];
    if (!remediation) throw new Error(`BLOCKER: no Turn M3 remediation entry authored for ${record.question_id}`);
    const priorRow = v02ByQid.get(record.question_id);
    if (!priorRow) throw new Error(`BLOCKER: no Turn M2 matrix v0.2 row found for ${record.question_id}`);
    const preWire = r8ByQid.get(record.question_id);
    const postWire = r9ByQid.get(record.question_id);
    rows.push({
      schema_version: "0.3.0",
      question_id: record.question_id,
      owner_note_sha256: sha256(Buffer.from(record.notes, "utf8")),
      owner_note: record.notes,
      turn_m2_status: priorRow.status,
      turn_m3_remediation_item_ids: remediation.items,
      implementation_files: remediation.status === "CANDIDATE_DATA_REVIEW_REQUIRED" || remediation.status === "ONTOLOGY_PROPOSAL_REQUIRED"
        ? [...IMPLEMENTATION_FILES_COMMON, ...CANDIDATE_ARTIFACT_FILES]
        : IMPLEMENTATION_FILES_COMMON,
      pre_fix_observation: { wire_revision: "r8", wire_path: preWire?.path ?? null, wire_sha256: preWire?.raw_sha256 ?? null },
      post_fix_observation: { wire_revision: "r9", wire_path: postWire?.path ?? null, wire_sha256: postWire?.raw_sha256 ?? null, summary: remediation.note },
      status: remediation.status,
      test_ids: remediation.tests,
      new_wire_sha256: postWire?.raw_sha256 ?? null,
    });
  }

  const statusCounts = { RESOLVED: 0, IMPLEMENTATION_REQUIRED: 0, CANDIDATE_DATA_REVIEW_REQUIRED: 0, PLAN_CANDIDATE_REVIEW_REQUIRED: 0, ONTOLOGY_PROPOSAL_REQUIRED: 0, SOURCE_DATA_NOT_AVAILABLE: 0, OWNER_POLICY_DECISION_REQUIRED: 0 };
  for (const row of rows) statusCounts[row.status]++;

  await mkdir(OUT_DIR, { recursive: true });
  const jsonlText = rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
  await writeFile(OUT_PATH, jsonlText, "utf8");
  const manifest = {
    schema_version: "0.3.0",
    artifact: "work/handoff/seed-final-response-owner-review/results/seed-response-remediation-matrix.v0.3.jsonl",
    artifact_sha256: sha256(Buffer.from(jsonlText, "utf8")),
    record_count: rows.length,
    status_counts: statusCounts,
    source_decision_path: "work/handoff/seed-final-response-owner-review/results/seed-response-owner-decision.v0.7.jsonl",
    source_decision_sha256: sha256(await readFile(DECISION_PATH)),
    prior_matrix_path: "work/handoff/seed-final-response-owner-review/results/seed-response-remediation-matrix.v0.2.jsonl",
    prior_matrix_sha256: sha256(await readFile(MATRIX_V02_PATH)),
    ontology_audit_path: "work/handoff/seed-final-response-owner-review/results/seed-response-structured-gap-ontology-audit.v0.1.json",
    ontology_audit_sha256: sha256(await readFile(ONTOLOGY_AUDIT_PATH)),
    pre_fix_wire_revision: "r8",
    post_fix_wire_revision: "r9",
    generated_at: new Date().toISOString(),
  };
  await writeFile(OUT_MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ record_count: rows.length, status_counts: statusCounts }, null, 2));
}

main().catch((error) => { console.error(error.message); process.exit(1); });
