// Turn M5 Section 9: a NEW remediation matrix revision (v0.5) -- never
// overwrites v0.4. Only Q06/Q09/Q17/Q18/Q20/Q25 change status this Turn
// (the direct consequence of the Owner decision v0.2 ingest + the new
// ontology packet v0.2); every other question's row is carried forward
// UNCHANGED from v0.4 (same statuses array, new note explaining why).
//
// Turn M5 introduces 3 NEW status tokens beyond the Turn M3/M4 7-value
// remediation vocabulary (RESOLVED/IMPLEMENTATION_REQUIRED/
// CANDIDATE_DATA_REVIEW_REQUIRED/ONTOLOGY_PROPOSAL_REQUIRED/
// PLAN_CANDIDATE_REVIEW_REQUIRED/SOURCE_DATA_NOT_AVAILABLE/
// OWNER_POLICY_DECISION_REQUIRED) -- CANDIDATE_DATA_FIX_REQUIRED (Owner
// has judged FIX_REQUIRED, not merely "unreviewed" like
// CANDIDATE_DATA_REVIEW_REQUIRED), OWNER_APPROVED_CANDIDATES_READY_FOR_
// PROMOTION (Owner has judged APPROVE, only promotion itself remains),
// CORRECTED_CANDIDATE_REVIEW_REQUIRED (a NEW content revision awaiting
// fresh Owner judgment), and ONTOLOGY_AND_CANDIDATE_REVIEW_REQUIRED (a
// compound status naming that ontology approval directly gates the
// dependent Candidate). This matrix is a free-form reporting artifact
// (no JSON Schema governs it -- confirmed via tests/seed-response-
// remediation-matrix.test.mjs, which only locks v0.1's own vocabulary),
// so adding these tokens here changes no official contract.
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MATRIX_V04_PATH = path.join(REPO, "work/handoff/seed-final-response-owner-review/results/seed-response-remediation-matrix.v0.4.jsonl");
const OWNER_DECISION_V02_PATH = path.join(REPO, "work/handoff/seed-final-response-owner-review/results/seed-structured-gap-candidate-owner-decision.v0.2.jsonl");
const PROMOTION_PIN_PATH = path.join(REPO, "work/handoff/seed-final-response-owner-review/results/seed-structured-gap-candidate-promotion-pin.v0.1.jsonl");
const ONTOLOGY_PACKET_V02_PATH = path.join(REPO, "work/handoff/seed-final-response-owner-review/results/seed-response-ontology-proposal-decision-packet.v0.2.json");
const CANDIDATES_V10_PATH = path.join(REPO, "work/domain-seed/seed-facts-candidates.v0.10.delta.jsonl");
const OUT_DIR = path.join(REPO, "work/handoff/seed-final-response-owner-review/results");
const OUT_PATH = path.join(OUT_DIR, "seed-response-remediation-matrix.v0.5.jsonl");
const OUT_MANIFEST_PATH = path.join(OUT_DIR, "seed-response-remediation-matrix.v0.5.manifest.json");

function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function jsonl(text) { return text.trim().split("\n").map((l) => JSON.parse(l)); }
function fail(msg) { throw new Error(`MATRIX_V05_BLOCKED: ${msg}`); }

const M5_UPDATES = {
  question_seed_v07_06: {
    statuses: ["ONTOLOGY_AND_CANDIDATE_REVIEW_REQUIRED"],
    detail: {
      ontology_proposal_card_id: 1,
      ontology_tokens: ["INVESTMENT_PURPOSE", "INVESTMENT_TARGET_ASSET"],
      dependent_preview_count: 4,
    },
    note: "Turn M5: ontology packet v0.2 카드 1 (record_count_if_approved 2 -> 4로 정정) + 4건 preview record (seed-structured-gap-candidate-preview.v0.1.jsonl) 생성. Owner가 ontology를 승인해야 Candidate도 authoring 가능 -- 두 판정이 직결되어 있으므로 단일 compound status로 표시.",
  },
  question_seed_v07_09: {
    statuses: ["CANDIDATE_DATA_FIX_REQUIRED", "ONTOLOGY_PROPOSAL_REQUIRED"],
    detail: {
      candidate_data_fix_required: { fact_id: "fact_74a2b743fee3b410295be924", superseded_by_ontology_card_id: 3 },
      ontology_proposal_required: [
        { card_id: 2, token: "ACQUISITION_PLANNED_SHARES" },
        { card_id: 3, token: "TRUST_CONTRACT_INSTITUTION" },
      ],
    },
    note: "Turn M5: Owner가 fact_74a2b743fee3b410295be924(CONTRACT_COUNTERPARTY)를 FIX_REQUIRED 판정 -- CANDIDATE_DATA_FIX_REQUIRED로 해결 진행 중 (TRUST_CONTRACT_INSTITUTION 새 metric_code, 카드 3, preview 1건 생성). ACQUISITION_PLANNED_SHARES(카드 2)는 독립적인 별도 gap -- 두 ontology 항목 모두 승인 대기.",
  },
  question_seed_v07_17: {
    statuses: ["OWNER_APPROVED_CANDIDATES_READY_FOR_PROMOTION"],
    detail: { fact_ids: ["fact_4b6f458e85adfadde708e185", "fact_de335e5b27723ca5daac5b63"] },
    note: "Turn M5: Owner가 두 Candidate 모두 APPROVE -- seed-structured-gap-candidate-promotion-pin.v0.1.jsonl에 CARRIED_FORWARD_OWNER_APPROVED로 pin됨. 재검수 불필요, 다음 Turn에서 promotion만 남음 (이번 Turn에 promotion 실행하지 않음).",
  },
  question_seed_v07_18: {
    statuses: ["ONTOLOGY_AND_CANDIDATE_REVIEW_REQUIRED"],
    detail: { ontology_proposal_card_id: 5, ontology_token: "ISSUANCE_AMOUNT", dependent_preview_count: 1 },
    note: "Turn M5: 변경 없음 -- ontology packet v0.2 카드 5(ISSUANCE_AMOUNT)로 승계, preview 1건 생성. Owner ontology 승인이 Candidate 생성의 전제조건.",
  },
  question_seed_v07_20: {
    statuses: ["ONTOLOGY_AND_CANDIDATE_REVIEW_REQUIRED"],
    detail: { ontology_proposal_card_id: 4, ontology_token: "CORRECTION_REASON", dependent_preview_count: 1 },
    note: "Turn M5: 변경 없음 -- ontology packet v0.2 카드 4(CORRECTION_REASON)로 승계, preview 1건 생성. Owner ontology 승인이 Candidate 생성의 전제조건.",
  },
  question_seed_v07_25: {
    statuses: ["OWNER_APPROVED_CANDIDATES_READY_FOR_PROMOTION", "CORRECTED_CANDIDATE_REVIEW_REQUIRED"],
    detail: {
      owner_approved_ready_for_promotion: { count: 4, fact_ids: ["fact_d23da8c62edf23554215d87f", "fact_e34ebab1f838ec0968ce9850", "fact_5d7923aeff9baeb5fc5586c6", "fact_a3b2bdf5e64c5bb4d908d478"] },
      corrected_candidate_review_required: { count: 1, fact_id: "fact_f82c1de6278abecc5d72436f", revision_path: "work/domain-seed/seed-facts-candidates.v0.10.delta.jsonl" },
    },
    note: "Turn M5: 5건 중 4건은 Owner APPROVE -- promotion-pin됨 (재검수 불필요). 나머지 1건('최종 유보기한')은 raw_label/value_certainty 수정한 새 revision(v0.10 delta)이 생성되었고, fact_id는 동일하지만 content가 다른 revision이므로 기존 FIX_REQUIRED 판정을 승계하지 않고 fresh PENDING.",
  },
};

async function main() {
  const matrixV04Bytes = await readFile(MATRIX_V04_PATH);
  const matrixV04 = jsonl(matrixV04Bytes.toString("utf8"));
  const ownerDecisionV02Bytes = await readFile(OWNER_DECISION_V02_PATH);
  const promotionPinBytes = await readFile(PROMOTION_PIN_PATH);
  const ontologyPacketV02Bytes = await readFile(ONTOLOGY_PACKET_V02_PATH);
  const candidatesV10Bytes = await readFile(CANDIDATES_V10_PATH);

  if (matrixV04.length !== 24) fail(`expected 24 rows in matrix v0.4, found ${matrixV04.length}`);

  const rows = matrixV04.map((v04Row) => {
    const update = M5_UPDATES[v04Row.question_id];
    if (update) {
      return {
        schema_version: "0.5.0",
        question_id: v04Row.question_id,
        owner_note_sha256: v04Row.owner_note_sha256,
        owner_note: v04Row.owner_note,
        turn_m4_statuses: v04Row.statuses,
        turn_m5_statuses: update.statuses,
        turn_m5_detail: update.detail,
        turn_m5_note: update.note,
        implementation_files: v04Row.implementation_files,
        statuses: update.statuses,
        changed_this_turn: true,
      };
    }
    return {
      schema_version: "0.5.0",
      question_id: v04Row.question_id,
      owner_note_sha256: v04Row.owner_note_sha256,
      owner_note: v04Row.owner_note,
      turn_m4_statuses: v04Row.statuses,
      turn_m5_statuses: v04Row.statuses,
      turn_m5_detail: null,
      turn_m5_note: "변경 없음 -- Turn M5는 Owner decision v0.2/ontology v0.2에 관련된 6개 문항(Q06/Q09/Q17/Q18/Q20/Q25)만 다룸.",
      implementation_files: v04Row.implementation_files,
      statuses: v04Row.statuses,
      changed_this_turn: false,
    };
  });

  const changedQids = rows.filter((r) => r.changed_this_turn).map((r) => r.question_id);
  const expectedChanged = Object.keys(M5_UPDATES).sort();
  if (JSON.stringify(changedQids.sort()) !== JSON.stringify(expectedChanged)) {
    fail(`changed question set mismatch: expected ${expectedChanged.join(",")}, got ${changedQids.sort().join(",")}`);
  }

  const statusCounts = {};
  for (const row of rows) for (const s of row.statuses) statusCounts[s] = (statusCounts[s] ?? 0) + 1;
  const compoundStatusQuestions = rows.filter((r) => r.statuses.length > 1).map((r) => r.question_id);

  await mkdir(OUT_DIR, { recursive: true });
  const jsonlText = rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
  await writeFile(OUT_PATH, jsonlText, "utf8");
  const manifest = {
    schema_version: "0.5.0",
    generated_at: new Date().toISOString(),
    artifact: "work/handoff/seed-final-response-owner-review/results/seed-response-remediation-matrix.v0.5.jsonl",
    artifact_sha256: sha256(Buffer.from(jsonlText, "utf8")),
    record_count: rows.length,
    status_counts: statusCounts,
    compound_status_questions: compoundStatusQuestions,
    changed_question_ids: changedQids,
    prior_matrix_path: "work/handoff/seed-final-response-owner-review/results/seed-response-remediation-matrix.v0.4.jsonl",
    prior_matrix_sha256: sha256(matrixV04Bytes),
    owner_decision_v02_path: "work/handoff/seed-final-response-owner-review/results/seed-structured-gap-candidate-owner-decision.v0.2.jsonl",
    owner_decision_v02_sha256: sha256(ownerDecisionV02Bytes),
    promotion_pin_v01_path: "work/handoff/seed-final-response-owner-review/results/seed-structured-gap-candidate-promotion-pin.v0.1.jsonl",
    promotion_pin_v01_sha256: sha256(promotionPinBytes),
    ontology_packet_v02_path: "work/handoff/seed-final-response-owner-review/results/seed-response-ontology-proposal-decision-packet.v0.2.json",
    ontology_packet_v02_sha256: sha256(ontologyPacketV02Bytes),
    candidates_v10_path: "work/domain-seed/seed-facts-candidates.v0.10.delta.jsonl",
    candidates_v10_sha256: sha256(candidatesV10Bytes),
  };
  await writeFile(OUT_MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ record_count: rows.length, status_counts: statusCounts, compound_status_questions: compoundStatusQuestions, changed_question_ids: changedQids }, null, 2));
}

main().catch((error) => { console.error(error.message); process.exit(1); });
