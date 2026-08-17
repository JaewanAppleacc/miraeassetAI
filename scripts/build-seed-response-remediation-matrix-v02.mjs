// Turn M2: builds a NEW remediation matrix revision (v0.2) tracking the
// SAME 24 FIX_REQUIRED notes on seed-response-owner-decision.v0.7
// (unmodified) against Turn M2's common-capability work, comparing the
// pre-Turn-M2 wire (r7) against the post-Turn-M2 wire (r8). Never
// overwrites matrix v0.1 -- that artifact stays exactly as Turn M left
// it, as the historical record of Turn M's OWN judgment (including the
// items Turn M2 explicitly identified as incorrectly judged, e.g. Q14/
// Q15/Q22). This script itself may name question_ids/companies (an
// AUDIT/REPORTING artifact, not Runtime synthesis code).
//
// New status vocabulary (Turn M2 item 11): RESOLVED / PARTIAL /
// IMPLEMENTATION_REQUIRED / PLAN_CANDIDATE_REVIEW_REQUIRED /
// STRUCTURED_DATA_GAP / OWNER_POLICY_DECISION_REQUIRED. BLOCKED is
// reserved ONLY for a case truly impossible to proceed without external
// input -- none of these 24 items qualify (every remaining gap is either
// a buildable capability this Turn ran out of time for
// (IMPLEMENTATION_REQUIRED) or a missing structured Fact that would need
// new data-candidate authoring (STRUCTURED_DATA_GAP), neither of which is
// "impossible", just not done in this Turn).
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DECISION_PATH = path.join(REPO, "work/handoff/seed-final-response-owner-review/results/seed-response-owner-decision.v0.7.jsonl");
const MATRIX_V01_PATH = path.join(REPO, "work/handoff/seed-final-response-owner-review/results/seed-response-remediation-matrix.v0.1.jsonl");
const WIRE_R7_INDEX = path.join(REPO, "work/domain-seed/seed-harness-v07-wire.r7/index.json");
const WIRE_R8_INDEX = path.join(REPO, "work/domain-seed/seed-harness-v07-wire.r8/index.json");
const OUT_DIR = path.join(REPO, "work/handoff/seed-final-response-owner-review/results");
const OUT_PATH = path.join(OUT_DIR, "seed-response-remediation-matrix.v0.2.jsonl");
const OUT_MANIFEST_PATH = path.join(OUT_DIR, "seed-response-remediation-matrix.v0.2.manifest.json");

function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }

const IMPLEMENTATION_FILES_COMMON = [
  "domain/flows/synthesis/response-composer.mjs",
  "domain/flows/synthesis/narrative-field-extractor.mjs",
  "domain/flows/synthesis/natural-label.mjs",
  "domain/flows/synthesis/change-direction.mjs",
  "domain/flows/synthesis/contract-amount-role.mjs",
  "domain/flows/synthesis/withheld-disclosure-detection.mjs",
  "domain/flows/synthesis/synthesis-signal-planner.mjs",
  "domain/flows/synthesis/final-synthesis-validator.mjs",
  "domain/flows/synthesis/number-formatting.mjs",
  "domain/flows/thin-structured-flow.mjs",
];

// Turn M2 item 11's REQUIRED status vocabulary -- see file header.
const REMEDIATION = {
  question_seed_v07_02: { capabilities: [], status: "RESOLVED", tests: [], note: "Unchanged since Turn M -- as_of_date already correctly labeled 공시일. No Turn M2 item applies." },
  question_seed_v07_03: { capabilities: [], status: "RESOLVED", tests: [], note: "Unchanged since Turn M -- as_of_date already correctly labeled 기준일. No Turn M2 item applies." },
  question_seed_v07_04: { capabilities: ["item4"], status: "RESOLVED", tests: ["synthesis-turn-m-capabilities.test.mjs:I", "synthesis-response-composer.test.mjs"], note: "Turn M2 item 4: generic signed-value direction rendering implemented via change-direction.mjs + a NEW independent validator check (verifyDirectionNarratives/DIRECTION_NARRATIVE_MISMATCH). Real Q04 now renders '직전보다 38,791주 감소했습니다.' (raw claim value -38791 unchanged; only the display narrative is natural language), verified with synthesis: PASS." },
  question_seed_v07_05: { capabilities: [], status: "RESOLVED", tests: [], note: "Unchanged since Turn M." },
  question_seed_v07_06: { capabilities: [], status: "STRUCTURED_DATA_GAP", tests: [], note: "Turn M2 item 9 investigation (Class C): the investment-purpose/target text ('건조 효율성 증대'/'6,500ton급 Floating Crane', '생산량 증대'/'Floating Dock 확장') exists as real VERIFIED Evidence quotes (already cited in the answer's evidence dump) but NO Fact structures 'investment purpose'/'investment target' as a queryable field -- per Turn M2's explicit Class-C rule, no Fact was fabricated this Turn. Recommend a future data-candidate authoring pass adding an INVESTMENT_PURPOSE/INVESTMENT_TARGET metric_code, or a Plan Candidate revision linking these Evidence items directly to the crane/dock investment-amount slots." },
  question_seed_v07_07: { capabilities: ["item8"], status: "IMPLEMENTATION_REQUIRED", tests: ["synthesis-turn-m-capabilities.test.mjs:F"], note: "Turn M2 item 8: attribution wording corrected to the required '회사는 \"...\"라고 밝혔습니다/판단했습니다.' framing (verified against real Q19/Q07 data). The single flowing narrative paragraph synthesizing the product-launch/commercialization conclusion Q07's note asked for is NOT yet a generic capability -- explicitly reclassified per Turn M2's correction that a natural conclusion sentence is a REQUIRED function, not a deferrable style request; a generic 'narrative Fact conclusion' capability for STATUS/enum-shaped product-lifecycle facts is the concrete next implementation step." },
  question_seed_v07_08: { capabilities: ["item8"], status: "STRUCTURED_DATA_GAP", tests: ["synthesis-turn-m-capabilities.test.mjs:N"], note: "Turn M2 item 8: a NEW generic state-transition conclusion sentence now renders for real Q08 data ('자기주식 취득 결정(결정됨)에서 자기주식 취득 후 소각 완료(완료)로 전환이 2024-11-15부터 2025-02-20까지 공시 사건으로 확인됩니다.'), directly addressing the '흐름이 정리되지 않음' complaint at the level the corpus's own 2 VERIFIED Events support. The requested INTERMEDIATE step (2025-02-18 소각 결정) still has no corresponding VERIFIED Event in this corpus -- inventing it would violate the Event/Fact provenance boundary; a real structured-data gap, not a rendering defect." },
  question_seed_v07_09: { capabilities: [], status: "STRUCTURED_DATA_GAP", tests: [], note: "Turn M2 item 9 investigation (Class C): 5000억원 계약금액/NH투자증권/9,861,932주 예정수량/10,347,131주 소각 all exist as real VERIFIED Evidence quotes (already loaded via the Plan's own evidence_ids) but no Fact structures them as queryable fields for this company. No Fact fabricated this Turn, per the explicit Class-C rule." },
  question_seed_v07_10: { capabilities: [], status: "RESOLVED", tests: [], note: "Unchanged since Turn M." },
  question_seed_v07_11: { capabilities: [], status: "RESOLVED", tests: [], note: "Unchanged since Turn M." },
  question_seed_v07_12: { capabilities: [], status: "RESOLVED", tests: [], note: "Unchanged since Turn M." },
  question_seed_v07_13: { capabilities: [], status: "RESOLVED", tests: [], note: "Unchanged since Turn M." },
  question_seed_v07_14: { capabilities: ["item2"], status: "RESOLVED", tests: ["synthesis-turn-m-capabilities.test.mjs:F"], note: "Turn M2 item 2: Turn M's Q14 status was itself judged INCORRECT (its NOT_APPLICABLE wording '해당 항목이 확인되지 않습니다' read as NOT_FOUND) -- the 4 Answerability states now have distinct, non-conflatable exact wordings (STATUS_LABEL_KO), and a NEW generic comparison-impossibility synthesis (groupInformationLimitsByFamily) renders '(2) 요약 연결포괄손익계산서 — 매출액 항목 없음: 동일 기준으로 비교할 수 없습니다.' for the real Q14 data. Verified synthesis: PASS with the corrected wording; genuinely RESOLVED (not merely reverted from Turn M's mistaken RESOLVED label)." },
  question_seed_v07_15: { capabilities: ["item5"], status: "RESOLVED", tests: ["synthesis-turn-m-capabilities.test.mjs:J"], note: "Turn M2 item 5: Turn M's BLOCKED status is explicitly corrected -- a generic per-company operating margin (operating_profit/revenue x100) is now computed via Calculator's own official RATIO formula (thin-structured-flow.mjs's generic metric_code-driven pairing loop, never Q15-specific), rendered per-company plus a cross-company comparison + scale-vs-profitability distinction sentence. Verified against real Q15 data: 'HD현대중공업의 영업이익률은 약 11.59%...' / '삼성중공업의 영업이익률은 약 8.1%...' / comparison summary, synthesis: PASS." },
  question_seed_v07_16: { capabilities: [], status: "RESOLVED", tests: [], note: "Unchanged since Turn M." },
  question_seed_v07_17: { capabilities: ["item6a"], status: "STRUCTURED_DATA_GAP", tests: ["synthesis-turn-m-capabilities.test.mjs:K"], note: "Turn M2 item 6A: a generic termination-amount vs. effective-contract-amount match/mismatch capability is implemented and verified via synthetic fixtures (contract-amount-role.mjs's semantic role registry, never Q17-specific). Applied to real Q17 data, the capability correctly does NOT fire: the VERIFIED corpus has no CONTRACT_AMOUNT/LATEST_CONTRACT_AMOUNT Fact for either company in this chain (confirmed by direct corpus inspection) -- a real structured-data gap for this specific real question, not a capability defect. The SEPARATE company-attribution complaint on the DIFF sentence was already fixed by Turn M and remains correct." },
  question_seed_v07_18: { capabilities: [], status: "STRUCTURED_DATA_GAP", tests: [], note: "Turn M2 item 9 investigation (Class C): 54,495주/2,198,873,250원 both exist as real VERIFIED Evidence quotes (already loaded) but no Fact structures the post-correction issuance share count/amount as queryable fields. No Fact fabricated this Turn." },
  question_seed_v07_19: { capabilities: ["item8"], status: "IMPLEMENTATION_REQUIRED", tests: [], note: "Turn M2 item 8: attribution wording corrected -- real Q19 data now renders '회사는 \"...\"라고 판단했습니다' (verified). The exact flowing conclusion sentence Turn M dismissed as 'too narrow a template' is reclassified per Turn M2's explicit correction: this Fact's transition (LOI -> definitive agreement) is captured as a single CONTRACT_STATUS enum Fact, not 2+ Events, so the NEW Event-based state-transition capability (item 8) does not apply to it -- a Fact-level analog (a generic 'enum value transition' conclusion sentence keyed on real corpus enum semantics, e.g. LOI-shaped -> DEFINITIVE_AGREEMENT_CONFIRMED) is the concrete next implementation step, not yet built." },
  question_seed_v07_20: { capabilities: ["item8"], status: "STRUCTURED_DATA_GAP", tests: [], note: "Turn M2 item 8: the NEW generic state-transition conclusion sentence now renders for real Q20 data ('공급계약 체결 결정(결정됨)에서 공급계약 체결 결정 정정(정정됨)로 전환이 2024-03-15부터 2024-12-05까지 공시 사건으로 확인됩니다.'). The SPECIFIC causal clause ('변경계약 체결 지연으로') is not woven in narratively because no VERIFIED Event for this chain carries a change_reason attribute (confirmed: both real Events' attributes contain only review_provenance) -- the reason text exists in Evidence only; a structured-data gap (an Event-attribute authoring gap), not a rendering defect, now more precisely identified than Turn M's diagnosis." },
  question_seed_v07_21: { capabilities: ["item8"], status: "IMPLEMENTATION_REQUIRED", tests: ["synthesis-turn-m-capabilities.test.mjs:N"], note: "Turn M2 item 8: the NEW generic state-transition conclusion sentence now renders for real Q21 data ('신탁계약을 통한 자기주식 취득 결정 정정(정정됨)에서 신탁계약을 통한 자기주식 취득 계약 해지(해지됨)로 전환이 2023-03-13부터 2024-08-08까지 공시 사건으로 확인됩니다.'), directly addressing part of the '흐름이 정리되지 않음' complaint. The requested '코퍼스 밖 연장공시는 해지공시를 통해 간접 확인' attribution was investigated (Turn M2 item 9/Class C): the exact Evidence sentence explaining the prior extension IS present (evidence_ebe453fe458e84bfb3511bce) and is already cited in the answer's evidence dump, but no generic 'indirect confirmation via a later document's own explanation' detector was built this Turn (judged too complex/risk-prone to build safely in the remaining time) -- reported honestly as a real, buildable capability gap." },
  question_seed_v07_22: { capabilities: ["item7"], status: "RESOLVED", tests: ["synthesis-turn-m-capabilities.test.mjs:M"], note: "Turn M2 item 7: Turn M's own note called this 'the one sub-item that remains genuinely unresolved'. Now fixed via a purely metadata-driven exclusion (synthesis-signal-planner.mjs): Evidence reachable ONLY via a CORRECTION_TIMELINE_SUMMARY-shaped Fact's own evidence_ids (never a PKG-string parse) is excluded from qualifier-candidate scanning. Verified against real Q22 data: the duplicate historical '5,562백만' qualifier quote no longer appears; only the current '5,564백만' quote renders, synthesis: PASS." },
  question_seed_v07_23: { capabilities: [], status: "RESOLVED", tests: [], note: "Unchanged since Turn M." },
  question_seed_v07_24: { capabilities: ["item6b"], status: "RESOLVED", tests: ["synthesis-turn-m-capabilities.test.mjs:L"], note: "Turn M2 item 6B: a generic WITHHELD->DISCLOSED-only-change detector is implemented (withheld-disclosure-detection.mjs, chain-id + metric_code-shape driven, never Q24-specific) and verified against real Q24 data: 'SATORP...삼성전자의 계약상대 항목은 계약조건 변경이 아니라 기존에 유보했던 정보의 공개입니다.' now renders, synthesis: PASS." },
  question_seed_v07_25: { capabilities: [], status: "STRUCTURED_DATA_GAP", tests: [], note: "Turn M2 item 9 investigation (Class C): the full 유보기한 correction history (2023-12-31 -> 03-30 -> 05-31 -> 06-30 -> 07-30) exists as real VERIFIED Evidence quotes but only ONE Fact (최초 유보기한, CONTRACT_RESERVATION_DEADLINE) captures a single point-in-time value -- no Fact sequence structures the full correction history. No Fact fabricated this Turn." },
};

async function main() {
  const decisionLines = (await readFile(DECISION_PATH, "utf8")).trim().split("\n").map((l) => JSON.parse(l));
  const matrixV01Lines = (await readFile(MATRIX_V01_PATH, "utf8")).trim().split("\n").map((l) => JSON.parse(l));
  const wireR7Index = JSON.parse(await readFile(WIRE_R7_INDEX, "utf8"));
  const wireR8Index = JSON.parse(await readFile(WIRE_R8_INDEX, "utf8"));
  const r7ByQid = new Map(wireR7Index.entries.map((e) => [e.question_id, e]));
  const r8ByQid = new Map(wireR8Index.entries.map((e) => [e.question_id, e]));
  const v01ByQid = new Map(matrixV01Lines.map((l) => [l.question_id, l]));

  const fixRequired = decisionLines.filter((l) => l.owner_disposition === "FIX_REQUIRED");
  if (fixRequired.length !== 24) throw new Error(`BLOCKER: expected 24 FIX_REQUIRED records, found ${fixRequired.length}`);
  if (matrixV01Lines.length !== 24) throw new Error(`BLOCKER: expected matrix v0.1 to have 24 rows, found ${matrixV01Lines.length}`);

  const rows = [];
  for (const record of fixRequired) {
    const remediation = REMEDIATION[record.question_id];
    if (!remediation) throw new Error(`BLOCKER: no Turn M2 remediation entry authored for ${record.question_id}`);
    const priorRow = v01ByQid.get(record.question_id);
    if (!priorRow) throw new Error(`BLOCKER: no Turn M matrix v0.1 row found for ${record.question_id}`);
    const preWire = r7ByQid.get(record.question_id);
    const postWire = r8ByQid.get(record.question_id);
    rows.push({
      schema_version: "0.2.0",
      question_id: record.question_id,
      owner_note_sha256: sha256(Buffer.from(record.notes, "utf8")),
      owner_note: record.notes,
      turn_m_status: priorRow.status,
      turn_m2_remediation_item_ids: remediation.capabilities,
      implementation_files: IMPLEMENTATION_FILES_COMMON,
      pre_fix_observation: { wire_revision: "r7", wire_path: preWire?.path ?? null, wire_sha256: preWire?.raw_sha256 ?? null },
      post_fix_observation: { wire_revision: "r8", wire_path: postWire?.path ?? null, wire_sha256: postWire?.raw_sha256 ?? null, summary: remediation.note },
      status: remediation.status,
      test_ids: remediation.tests,
      new_wire_sha256: postWire?.raw_sha256 ?? null,
    });
  }

  const statusCounts = { RESOLVED: 0, PARTIAL: 0, IMPLEMENTATION_REQUIRED: 0, PLAN_CANDIDATE_REVIEW_REQUIRED: 0, STRUCTURED_DATA_GAP: 0, OWNER_POLICY_DECISION_REQUIRED: 0, BLOCKED: 0 };
  for (const row of rows) statusCounts[row.status]++;

  await mkdir(OUT_DIR, { recursive: true });
  const jsonlText = rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
  await writeFile(OUT_PATH, jsonlText, "utf8");
  const manifest = {
    schema_version: "0.2.0",
    artifact: "work/handoff/seed-final-response-owner-review/results/seed-response-remediation-matrix.v0.2.jsonl",
    artifact_sha256: sha256(Buffer.from(jsonlText, "utf8")),
    record_count: rows.length,
    status_counts: statusCounts,
    source_decision_path: "work/handoff/seed-final-response-owner-review/results/seed-response-owner-decision.v0.7.jsonl",
    source_decision_sha256: sha256(await readFile(DECISION_PATH)),
    prior_matrix_path: "work/handoff/seed-final-response-owner-review/results/seed-response-remediation-matrix.v0.1.jsonl",
    prior_matrix_sha256: sha256(await readFile(MATRIX_V01_PATH)),
    pre_fix_wire_revision: "r7",
    post_fix_wire_revision: "r8",
    generated_at: new Date().toISOString(),
  };
  await writeFile(OUT_MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ record_count: rows.length, status_counts: statusCounts }, null, 2));
}

main().catch((error) => { console.error(error.message); process.exit(1); });
