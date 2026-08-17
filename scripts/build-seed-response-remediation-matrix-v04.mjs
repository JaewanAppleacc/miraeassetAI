// Turn M4: builds a NEW remediation matrix revision (v0.4) tracking the
// SAME 24 FIX_REQUIRED notes on seed-response-owner-decision.v0.7
// (unmodified), comparing the pre-Turn-M4 wire (r9) against the post-
// Turn-M4 wire (r10). Never overwrites matrix v0.1/v0.2/v0.3 -- those
// stay exactly as Turn M/M2/M3 left them.
//
// Turn M4 Section 8: the single `status` field from v0.1-v0.3 is
// replaced by a `statuses` ARRAY -- a question is never compressed into
// one status when doing so would hide another real gap (Q09 needs BOTH
// a Candidate-data review AND an ontology-proposal decision; collapsing
// that into one status silently drops one of the two). RESOLVED appears
// alone (a question is either fully resolved or it isn't) and only when
// literally every element the Owner note asked for is present in the
// r10 answer.
//
// Turn M4 Section 2 corrections applied here (see
// seed-response-turn-m3-correction-report.v0.1.json for the full
// rationale): Q09 is now ["CANDIDATE_DATA_REVIEW_REQUIRED",
// "ONTOLOGY_PROPOSAL_REQUIRED"] (was compressed to one status in v0.3);
// Q18 is now ["ONTOLOGY_PROPOSAL_REQUIRED"] (was incorrectly marked
// RESOLVED in v0.3 -- the narrative states the per-share price and share
// count separately but never states their PRODUCT, the 2,198,873,250원
// total issuance amount the Owner note explicitly asked for).
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DECISION_PATH = path.join(REPO, "work/handoff/seed-final-response-owner-review/results/seed-response-owner-decision.v0.7.jsonl");
const MATRIX_V03_PATH = path.join(REPO, "work/handoff/seed-final-response-owner-review/results/seed-response-remediation-matrix.v0.3.jsonl");
const WIRE_R9_INDEX = path.join(REPO, "work/domain-seed/seed-harness-v07-wire.r9/index.json");
const WIRE_R10_INDEX = path.join(REPO, "work/domain-seed/seed-harness-v07-wire.r10/index.json");
const ONTOLOGY_PACKET_PATH = path.join(REPO, "work/handoff/seed-final-response-owner-review/results/seed-response-ontology-proposal-decision-packet.v0.1.json");
const OUT_DIR = path.join(REPO, "work/handoff/seed-final-response-owner-review/results");
const OUT_PATH = path.join(OUT_DIR, "seed-response-remediation-matrix.v0.4.jsonl");
const OUT_MANIFEST_PATH = path.join(OUT_DIR, "seed-response-remediation-matrix.v0.4.manifest.json");

function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }

const IMPLEMENTATION_FILES_COMMON = [
  "domain/flows/synthesis/response-composer.mjs",
  "domain/flows/synthesis/synthesis-signal-planner.mjs",
  "domain/flows/synthesis/final-synthesis-validator.mjs",
];
const CANDIDATE_ARTIFACT_FILES = [
  "scripts/build-seed-structured-gap-fact-batch-m3.mjs",
  "work/domain-seed/seed-facts-candidates.v0.8.delta.jsonl",
  "scripts/build-seed-structured-gap-fact-batch-m4-verification.mjs",
  "work/domain-seed/seed-facts-candidates.v0.9.delta.jsonl",
];
const ONTOLOGY_PROPOSAL_FILES = [
  "work/handoff/seed-final-response-owner-review/results/seed-response-ontology-proposal-decision-packet.v0.1.json",
];

// Turn M4 Section 4 rule IDs (never a per-question rule -- each fires
// generically off a real, corpus-wide shape). Referenced by
// turn_m4_remediation_item_ids below exactly like Turn M3's item IDs.
const M4_ITEMS = {
  PARTICLE: "m4-item4A-particle",
  STATE_TRANSITION: "m4-item4B-state-transition",
  SOURCE_TYPE: "m4-item4C-source-type",
  DEDUP: "m4-item4D-dedup",
  FRAGMENTATION: "m4-item4E-fragmentation",
  RELEVANCE_GATE: "m4-item4F-relevance-gate",
};

const REMEDIATION = {
  question_seed_v07_02: { items: [], statuses: ["RESOLVED"], tests: [], note: "Unchanged since Turn M3 (r9=r10 byte-identical)." },
  question_seed_v07_03: { items: [], statuses: ["RESOLVED"], tests: [], note: "Unchanged since Turn M3 (r9=r10 byte-identical)." },
  question_seed_v07_04: { items: [], statuses: ["RESOLVED"], tests: [], note: "Unchanged since Turn M3 (r9=r10 byte-identical)." },
  question_seed_v07_05: { items: [], statuses: ["RESOLVED"], tests: [], note: "Unchanged since Turn M3 (r9=r10 byte-identical)." },
  question_seed_v07_06: { items: ["item9-Q06"], statuses: ["ONTOLOGY_PROPOSAL_REQUIRED"], tests: [], note: "Unchanged since Turn M3 (r9=r10 byte-identical). Formal proposal card #1 (INVESTMENT_PURPOSE + INVESTMENT_TARGET_ASSET) recorded in seed-response-ontology-proposal-decision-packet.v0.1.json, PENDING Owner judgment. Not implemented this Turn." },
  question_seed_v07_07: { items: ["item7A", M4_ITEMS.SOURCE_TYPE], statuses: ["RESOLVED"], tests: ["synthesis-turn-m-capabilities.test.mjs:R", "synthesis-turn-m-capabilities.test.mjs:O", "synthesis-turn-m-capabilities.test.mjs:T (Q07-shaped)"], note: "Turn M4 item 4C: the EU authorization narrative's own source_document_id is an exchange_-group document -- now correctly labeled '거래소 공시에는' (was incorrectly '정기공시에는' in r9). Content unchanged; label corrected only. synthesis: PASS." },
  question_seed_v07_08: { items: ["item8-narrative-source", M4_ITEMS.STATE_TRANSITION, M4_ITEMS.SOURCE_TYPE, M4_ITEMS.RELEVANCE_GATE], statuses: ["RESOLVED"], tests: ["synthesis-turn-m-capabilities.test.mjs:O", "synthesis-turn-m-capabilities.test.mjs:N", "synthesis-turn-m-capabilities.test.mjs:S"], note: "Turn M4 items 4B/4C/4F: (1) the state-transition sentence no longer reads '자기주식 취득 결정(결정됨)에서 ... 완료(완료)로 전환' (raw internal-state leak) -- now '자기주식 취득 결정 후 완료된 사실이 ... 확인됩니다.'; (2) the indirect-confirmation sentence citing the 2024-11-18 filing is now correctly SUPPRESSED by the relevance gate (it referenced the SAME already-loaded 자기주식 취득 결정 Event, not new information -- this was a false positive in r9); (3) the board-resolution narrative source is now correctly labeled '주요사항보고서에는' (was '정기공시에는'). synthesis: PASS." },
  question_seed_v07_09: { items: ["item8-narrative-source", "item4-Q09-candidate", M4_ITEMS.STATE_TRANSITION, M4_ITEMS.SOURCE_TYPE], statuses: ["CANDIDATE_DATA_REVIEW_REQUIRED", "ONTOLOGY_PROPOSAL_REQUIRED"], tests: ["synthesis-turn-m-capabilities.test.mjs:O", "synthesis-turn-m-capabilities.test.mjs:N"], note: "Turn M4 Section 2B correction: this question has a COMPOUND gap, never compressible into one status. (1) CANDIDATE_DATA_REVIEW_REQUIRED -- fact_74a2b743fee3b410295be924 (CONTRACT_COUNTERPARTY, NH투자증권) is re-verified against the canonical DocumentIR this Turn: its Turn M3 raw_label '신탁계약 상대방' was an INVENTED label not present in the source document (the real row label is '4. 계약체결기관') -- corrected in a NEW v0.9 delta (fact_id/normalized_value/evidence unchanged, only raw_label fixed), still awaiting Owner review/promotion, never auto-approved. (2) ONTOLOGY_PROPOSAL_REQUIRED -- the '예정수량 9,861,932주' planned-acquisition-share-count sub-item has no safe existing metric_code (DISPOSAL_SHARES means the opposite direction); formal proposal card #2 (ACQUISITION_PLANNED_SHARES) recorded in the ontology decision packet, PENDING. Items (1) and (2) are independent gaps on independent sub-items -- resolving one does not resolve the other. Narrative wording also improved (state-transition + source-type attribution, generic rules, no new structured data). synthesis: PASS." },
  question_seed_v07_10: { items: [], statuses: ["RESOLVED"], tests: [], note: "Unchanged since Turn M3 (r9=r10 byte-identical)." },
  question_seed_v07_11: { items: [], statuses: ["RESOLVED"], tests: [], note: "Unchanged since Turn M3 (r9=r10 byte-identical)." },
  question_seed_v07_12: { items: [], statuses: ["RESOLVED"], tests: [], note: "Unchanged since Turn M3 (r9=r10 byte-identical)." },
  question_seed_v07_13: { items: [], statuses: ["RESOLVED"], tests: [], note: "Unchanged since Turn M3 (r9=r10 byte-identical)." },
  question_seed_v07_14: { items: [], statuses: ["RESOLVED"], tests: [], note: "Unchanged since Turn M3 (r9=r10 byte-identical)." },
  question_seed_v07_15: { items: [], statuses: ["RESOLVED"], tests: [], note: "Unchanged since Turn M3 (r9=r10 byte-identical)." },
  question_seed_v07_16: { items: [], statuses: ["RESOLVED"], tests: [], note: "Unchanged since Turn M3 (r9=r10 byte-identical)." },
  question_seed_v07_17: { items: ["item4-Q17-candidate", M4_ITEMS.FRAGMENTATION], statuses: ["CANDIDATE_DATA_REVIEW_REQUIRED"], tests: ["synthesis-turn-m-capabilities.test.mjs:O"], note: "Turn M4 Section 3 re-verification (independent DocumentIR re-read): fact_4b6f458e85adfadde708e185 (삼성중공업) and fact_de335e5b27723ca5daac5b63 (효성중공업) both PASS -- their raw_label ('해지 시점 유효 계약금액') legitimately elaborates the real row label with accurate temporal-role context (samsung heavy via a genuine correction row; hyosung via an original disclosure never later revised before termination -- two different but both factually correct reasons for being 'the latest value'), no defect found, v0.8 left unmodified. Turn M4 item 4E also fixed a sentence-fragmentation bug in the SAME Q17 answer: the company-quoted 재무 보전 계획 sentence was previously missing its own leading '4.' list marker (cut mid-sentence by the old naive splitter); now rendered whole. Still awaiting Owner promotion of the 2 Candidate Facts." },
  question_seed_v07_18: { items: ["item8-narrative-source", M4_ITEMS.STATE_TRANSITION, M4_ITEMS.SOURCE_TYPE], statuses: ["ONTOLOGY_PROPOSAL_REQUIRED"], tests: ["synthesis-turn-m-capabilities.test.mjs:O", "synthesis-turn-m-capabilities.test.mjs:N", "synthesis-turn-m-capabilities.test.mjs:T (Q19-shaped)"], note: "Turn M4 Section 2C correction: v0.3 incorrectly marked this RESOLVED. Direct re-check of r9/r10: the narrative states 54,495주 and 40,350원 SEPARATELY (via NARRATIVE_SOURCE_DISCLOSURE) but NEVER states their PRODUCT -- the Owner-note-required 2,198,873,250원 total issuance amount only ever appears in the citation block (evidence_ce757058c68b8932b0b7c7e0, VERIFIED, already linked to this question), never in the answer's own narrative. Mechanically confirmed: 54,495 x 40,350 = 2,198,873,250 (exact match against the VERIFIED evidence value). Two remediation paths compared (Section 2C): (a) a Calculator PRODUCT formula -- rejected THIS Turn because CALCULATOR_FORMULAS (domain/runtime/agent-runtime.mjs) is currently frozen at [SUM, DIFF, RATIO, PERCENTAGE_CHANGE] with no PRODUCT/multiplication op, and adding one is a Shared-Service contract change requiring its own version bump + contract tests + Codex review, out of this Turn's fixed scope; (b) a standalone ISSUANCE_AMOUNT Fact (TEXT or NUMERIC, value = 2,198,873,250, grounded directly in the already-VERIFIED evidence_ce757058c68b8932b0b7c7e0) -- RECOMMENDED, no Shared-Service contract change, additive-only. Formal proposal card #4 recorded in the ontology decision packet, PENDING. Narrative wording also improved (state-transition + source-type attribution). synthesis: PASS (on what IS rendered), but the question's own required element is still missing." },
  question_seed_v07_19: { items: ["item7B", "item8-attribution-verb-fix", M4_ITEMS.RELEVANCE_GATE, M4_ITEMS.SOURCE_TYPE], statuses: ["RESOLVED"], tests: ["synthesis-turn-m-capabilities.test.mjs:Q,P", "synthesis-turn-m-capabilities.test.mjs:S", "synthesis-turn-m-capabilities.test.mjs:T (Q19-shaped)"], note: "Turn M4 items 4C/4F: the indirect-confirmation sentence wording is now '...에 공시된 내용(\"투자판단 관련 주요경영사항\")은...' (was '...관련 사실은...', slightly more precise quoting) and the '해당 계약은 2023년 6월 5일에 공시한...' narrative source is now correctly labeled '거래소 공시에는' (was '정기공시에는' -- the source document is an exchange_-group filing). Content unchanged; wording/labels corrected only. synthesis: PASS." },
  question_seed_v07_20: { items: ["item9-Q20", M4_ITEMS.PARTICLE, M4_ITEMS.STATE_TRANSITION], statuses: ["ONTOLOGY_PROPOSAL_REQUIRED"], tests: ["synthesis-korean-particles.test.mjs"], note: "Turn M4 item 4A: fixed a literal hardcoded '와(과)' placeholder string (both particle forms concatenated, never actually resolved) baked into REGISTRY_SENTENCE_TEMPLATES -- '계약금액(원)·정정후와(과) 계약금액(원)의 차이는' is now '계약금액(원)·정정후와 계약금액(원)의 차이는' (correct particle resolved via the SAME batchim-aware library used everywhere else). Item 4B also rewords the state-transition sentence (no more '(결정됨)에서 ... 정정(정정됨)로 전환'). The underlying CORRECTION_REASON ontology gap (proposal card #3) is unchanged from Turn M3 -- still PENDING." },
  question_seed_v07_21: { items: ["item7C", M4_ITEMS.STATE_TRANSITION, M4_ITEMS.SOURCE_TYPE, M4_ITEMS.FRAGMENTATION, M4_ITEMS.RELEVANCE_GATE], statuses: ["RESOLVED"], tests: ["synthesis-turn-m-capabilities.test.mjs:S", "synthesis-turn-m-capabilities.test.mjs:N", "synthesis-turn-m-capabilities.test.mjs:O"], note: "Turn M4 item 4E (the Owner's own flagged defect): the termination-disclosure sentence was previously fragmented mid-quote into two separate claims (\"상기 '2.\" / \"해지 전 계약기간의' 시작일은...\") by the old naive splitter, which cut on EVERY period including one inside an unclosed quote/list-marker span. The rewritten splitSentences (quote/bracket-balance + digit-preceded-period aware) now renders this as ONE coherent 196-character sentence. Items 4B/4C also apply (state-transition wording, and the 4 termination-document narrative sources now correctly labeled '후속 해지공시에는' via the new Event-linkage refinement, not the generic '정기공시에는'). The extension disclosure is still explicitly framed as an INDIRECT confirmation via the termination filing (never as if directly observed). synthesis: PASS." },
  question_seed_v07_22: { items: [M4_ITEMS.FRAGMENTATION], statuses: ["RESOLVED"], tests: ["synthesis-turn-m-capabilities.test.mjs:O"], note: "Turn M4 item 4E: the PKG amount qualifier quote was previously truncated mid-clause at \"...최초 고시환율('23.\" (the OLD splitter mistook the date-abbreviation period in \"'23.06.23\" for a sentence boundary). The digit-preceded-period rule now correctly keeps this attached, restoring the full \"...('23.06.23) :1,291.4원/USD, 344.28원/SAR\" qualifier. synthesis: PASS." },
  question_seed_v07_23: { items: [M4_ITEMS.SOURCE_TYPE], statuses: ["RESOLVED"], tests: ["synthesis-turn-m-capabilities.test.mjs:O"], note: "Turn M4 item 4C: the 3 termination-narrative sentences (일시 중단 이력, 계약해지 합의, 재무적 손실 없음) are now correctly labeled '거래소 공시에는' (their real source_document_id is an exchange_-group filing; r9 incorrectly used the generic '정기공시에는'). Content unchanged; label corrected only. synthesis: PASS." },
  question_seed_v07_24: { items: [M4_ITEMS.STATE_TRANSITION], statuses: ["RESOLVED"], tests: ["synthesis-turn-m-capabilities.test.mjs:N"], note: "Turn M4 item 4B: state-transition sentence reworded (no more '(결정됨)에서 ... 정정(정정됨)로 전환'). Content unchanged; wording corrected only. synthesis: PASS." },
  question_seed_v07_25: { items: ["item4-Q25-candidate", M4_ITEMS.STATE_TRANSITION, M4_ITEMS.SOURCE_TYPE, M4_ITEMS.RELEVANCE_GATE], statuses: ["CANDIDATE_DATA_REVIEW_REQUIRED"], tests: ["synthesis-turn-m-capabilities.test.mjs:N", "synthesis-turn-m-capabilities.test.mjs:S"], note: "Turn M4 Section 3 re-verification (independent DocumentIR re-read, all 5 correction documents): every Candidate Fact PASS -- each correction document's MISLEADING '정정관련 공시서류제출일' row (which always references back to an unrelated original filing) was correctly NOT used; normalized_value was correctly extracted from '유보기한' rows only, and the final 2030-12-31 value was confirmed as the genuine reservation deadline (not a contract-end date), consistent with (not contradicted by) the separate 'counterparty disclosed 2030-12-31' sentence elsewhere -- same underlying trigger date, two framings. No defect found; v0.8 left unmodified. Items 4B/4C/4F also apply to this question's narrative wording (state-transition, exchange-group source-type label, and the indirect-confirmation reference to the 2023-06-05 filing). Still awaiting Owner promotion of the 5 Candidate Facts." },
};

async function main() {
  const decisionBytes = await readFile(DECISION_PATH);
  const decisionLines = decisionBytes.toString("utf8").trim().split("\n").map((l) => JSON.parse(l));
  const matrixV03Bytes = await readFile(MATRIX_V03_PATH);
  const matrixV03Lines = matrixV03Bytes.toString("utf8").trim().split("\n").map((l) => JSON.parse(l));
  const wireR9Index = JSON.parse(await readFile(WIRE_R9_INDEX, "utf8"));
  const wireR10Index = JSON.parse(await readFile(WIRE_R10_INDEX, "utf8"));
  const r9ByQid = new Map(wireR9Index.entries.map((e) => [e.question_id, e]));
  const r10ByQid = new Map(wireR10Index.entries.map((e) => [e.question_id, e]));
  const v03ByQid = new Map(matrixV03Lines.map((l) => [l.question_id, l]));

  const fixRequired = decisionLines.filter((l) => l.owner_disposition === "FIX_REQUIRED");
  if (fixRequired.length !== 24) throw new Error(`BLOCKER: expected 24 FIX_REQUIRED records, found ${fixRequired.length}`);
  if (matrixV03Lines.length !== 24) throw new Error(`BLOCKER: expected matrix v0.3 to have 24 rows, found ${matrixV03Lines.length}`);

  const rows = [];
  for (const record of fixRequired) {
    const remediation = REMEDIATION[record.question_id];
    if (!remediation) throw new Error(`BLOCKER: no Turn M4 remediation entry authored for ${record.question_id}`);
    if (remediation.statuses.length === 0) throw new Error(`BLOCKER: ${record.question_id} has an empty statuses array`);
    if (remediation.statuses.includes("RESOLVED") && remediation.statuses.length > 1) {
      throw new Error(`BLOCKER: ${record.question_id} mixes RESOLVED with another status -- a question is either fully resolved or it isn't`);
    }
    const priorRow = v03ByQid.get(record.question_id);
    if (!priorRow) throw new Error(`BLOCKER: no Turn M3 matrix v0.3 row found for ${record.question_id}`);
    const preWire = r9ByQid.get(record.question_id);
    const postWire = r10ByQid.get(record.question_id);
    const needsCandidateFiles = remediation.statuses.includes("CANDIDATE_DATA_REVIEW_REQUIRED");
    const needsOntologyFiles = remediation.statuses.includes("ONTOLOGY_PROPOSAL_REQUIRED");
    rows.push({
      schema_version: "0.4.0",
      question_id: record.question_id,
      owner_note_sha256: sha256(Buffer.from(record.notes, "utf8")),
      owner_note: record.notes,
      turn_m3_statuses: [priorRow.status],
      turn_m4_remediation_item_ids: remediation.items,
      implementation_files: [
        ...IMPLEMENTATION_FILES_COMMON,
        ...(needsCandidateFiles ? CANDIDATE_ARTIFACT_FILES : []),
        ...(needsOntologyFiles ? ONTOLOGY_PROPOSAL_FILES : []),
      ],
      pre_fix_observation: { wire_revision: "r9", wire_path: preWire?.path ?? null, wire_sha256: preWire?.raw_sha256 ?? null },
      post_fix_observation: { wire_revision: "r10", wire_path: postWire?.path ?? null, wire_sha256: postWire?.raw_sha256 ?? null, summary: remediation.note },
      // Turn M4 Section 8: ARRAY of unresolved conditions. RESOLVED only
      // when every element the Owner note asked for is literally present
      // in the r10 answer -- never compressed to hide a second gap.
      statuses: remediation.statuses,
      test_ids: remediation.tests,
      new_wire_sha256: postWire?.raw_sha256 ?? null,
    });
  }

  const statusCounts = {};
  for (const row of rows) {
    for (const s of row.statuses) statusCounts[s] = (statusCounts[s] ?? 0) + 1;
  }
  const compoundStatusQuestions = rows.filter((r) => r.statuses.length > 1).map((r) => r.question_id);

  await mkdir(OUT_DIR, { recursive: true });
  const jsonlText = rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
  await writeFile(OUT_PATH, jsonlText, "utf8");
  const manifest = {
    schema_version: "0.4.0",
    artifact: "work/handoff/seed-final-response-owner-review/results/seed-response-remediation-matrix.v0.4.jsonl",
    artifact_sha256: sha256(Buffer.from(jsonlText, "utf8")),
    record_count: rows.length,
    status_counts: statusCounts,
    compound_status_questions: compoundStatusQuestions,
    source_decision_path: "work/handoff/seed-final-response-owner-review/results/seed-response-owner-decision.v0.7.jsonl",
    source_decision_sha256: sha256(decisionBytes),
    prior_matrix_path: "work/handoff/seed-final-response-owner-review/results/seed-response-remediation-matrix.v0.3.jsonl",
    prior_matrix_sha256: sha256(matrixV03Bytes),
    ontology_proposal_decision_packet_path: "work/handoff/seed-final-response-owner-review/results/seed-response-ontology-proposal-decision-packet.v0.1.json",
    ontology_proposal_decision_packet_sha256: sha256(await readFile(ONTOLOGY_PACKET_PATH)),
    pre_fix_wire_revision: "r9",
    post_fix_wire_revision: "r10",
    wire_diff_path: "work/domain-seed/seed-harness-v07-wire-diff.r9-to-r10.json",
    generated_at: new Date().toISOString(),
  };
  await writeFile(OUT_MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ record_count: rows.length, status_counts: statusCounts, compound_status_questions: compoundStatusQuestions }, null, 2));
}

main().catch((error) => { console.error(error.message); process.exit(1); });
