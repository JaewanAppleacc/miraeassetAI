// Turn M4 Section 2: a standalone report correcting 3 errors in my own
// Turn M3 final report, discovered when the Owner re-checked it. Never
// modifies the ontology audit v0.1 or matrix v0.1-v0.3 themselves --
// those stay exactly as Turn M3 left them; the corrections live here and
// flow forward into the NEW v0.4 matrix and the NEW ontology decision
// packet v0.1.
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ONTOLOGY_AUDIT_PATH = path.join(REPO, "work/handoff/seed-final-response-owner-review/results/seed-response-structured-gap-ontology-audit.v0.1.json");
const ONTOLOGY_PACKET_PATH = path.join(REPO, "work/handoff/seed-final-response-owner-review/results/seed-response-ontology-proposal-decision-packet.v0.1.json");
const MATRIX_V03_PATH = path.join(REPO, "work/handoff/seed-final-response-owner-review/results/seed-response-remediation-matrix.v0.3.jsonl");
const MATRIX_V04_PATH = path.join(REPO, "work/handoff/seed-final-response-owner-review/results/seed-response-remediation-matrix.v0.4.jsonl");
const WIRE_R9_Q18_PATH = path.join(REPO, "work/domain-seed/seed-harness-v07-wire.r9/question_seed_v07_18.response.json");
const OUT_DIR = path.join(REPO, "work/handoff/seed-final-response-owner-review/results");
const OUT_PATH = path.join(OUT_DIR, "seed-response-turn-m3-correction-report.v0.1.json");

function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }

async function main() {
  const auditBytes = await readFile(ONTOLOGY_AUDIT_PATH);
  const audit = JSON.parse(auditBytes.toString("utf8"));
  const packetBytes = await readFile(ONTOLOGY_PACKET_PATH);
  const packet = JSON.parse(packetBytes.toString("utf8"));
  const matrixV03Bytes = await readFile(MATRIX_V03_PATH);
  const matrixV03 = matrixV03Bytes.toString("utf8").trim().split("\n").map((l) => JSON.parse(l));
  const matrixV04Bytes = await readFile(MATRIX_V04_PATH);
  const matrixV04 = matrixV04Bytes.toString("utf8").trim().split("\n").map((l) => JSON.parse(l));
  const wireQ18 = JSON.parse(await readFile(WIRE_R9_Q18_PATH, "utf8"));

  const actualOntologyProposalCount = audit.gap_classification.filter((g) => g.category === "ONTOLOGY_PROPOSAL_REQUIRED").length;
  const q18MatrixV03Row = matrixV03.find((r) => r.question_id === "question_seed_v07_18");
  const q18MatrixV04Row = matrixV04.find((r) => r.question_id === "question_seed_v07_18");
  const q09MatrixV03Row = matrixV03.find((r) => r.question_id === "question_seed_v07_09");
  const q09MatrixV04Row = matrixV04.find((r) => r.question_id === "question_seed_v07_09");
  const totalAmountAppearsInNarrative = wireQ18.answer.split("근거 공시:")[0].includes("2,198,873,250");
  const totalAmountAppearsInCitationOnly = wireQ18.answer.includes("2,198,873,250") && !totalAmountAppearsInNarrative;

  const report = {
    schema_version: "0.1.0",
    generated_at: new Date().toISOString(),
    purpose: "Turn M4 Section 2: correct 3 errors the Owner found in my own Turn M3 final report. Never edits the Turn M3 artifacts themselves (ontology audit v0.1, matrix v0.1-v0.3 stay exactly as they were) -- corrections flow forward into NEW artifacts only (ontology decision packet v0.1, matrix v0.4).",
    corrections: [
      {
        id: "2A",
        claim_in_turn_m3_report: "There are 3 ONTOLOGY_PROPOSAL_REQUIRED items (Q06, Q09, Q20).",
        actual: `There are ${actualOntologyProposalCount} ONTOLOGY_PROPOSAL_REQUIRED items in ontology audit v0.1's gap_classification (Q06, Q09, Q20), PLUS a 4th proposal this Turn (Q18, ISSUANCE_AMOUNT) that Turn M3 incorrectly left classified as REUSE_EXISTING_RECORD/RESOLVED -- see correction 2C below. The final ontology decision packet therefore has 4 cards, not 3.`,
        verified_against: "seed-response-structured-gap-ontology-audit.v0.1.json gap_classification array (read-only, unmodified) + seed-response-ontology-proposal-decision-packet.v0.1.json (new, 4 cards).",
        ontology_audit_v01_sha256_unmodified: sha256(auditBytes),
        new_packet_card_count: packet.card_count,
        status: "CORRECTED",
      },
      {
        id: "2B",
        claim_in_turn_m3_report: "Q09's remaining gap is a single CANDIDATE_DATA_REVIEW_REQUIRED status.",
        actual: "Q09 has a COMPOUND gap that must never be compressed into one status: (1) the CONTRACT_COUNTERPARTY Candidate Fact (fact_74a2b743fee3b410295be924) needs Owner review/promotion (its Turn M3 raw_label was found to be a genuine defect this Turn -- corrected in a new v0.9 delta, see the candidate verification report), AND independently (2) the '예정수량 9,861,932주' planned-acquisition-share-count sub-item needs a NEW ontology proposal (ACQUISITION_PLANNED_SHARES, card #2) because DISPOSAL_SHARES reuse would misrepresent the value's direction. Approving/promoting (1) does NOT resolve (2), and vice versa -- they are independent sub-items of the same question.",
        turn_m3_matrix_v03_statuses: q09MatrixV03Row ? [q09MatrixV03Row.status] : null,
        turn_m4_matrix_v04_statuses: q09MatrixV04Row ? q09MatrixV04Row.statuses : null,
        status: "CORRECTED",
      },
      {
        id: "2C",
        claim_in_turn_m3_report: "Q18 is RESOLVED -- both the initial (69,809주/2,816,793,150원) and corrected (54,495주/40,350원) values render via NARRATIVE_SOURCE_DISCLOSURE.",
        actual: "Q18 is NOT resolved. The r9/r10 narrative states 54,495주 and 40,350원 SEPARATELY but never states their PRODUCT (the total issuance amount). The Owner note explicitly requires '정정 후 발행주식 수 54,495주와 발행금액 2,198,873,250원' -- the second value (2,198,873,250원) never appears in the answer's own narrative text, only in the citation block (which quotes evidence_ce757058c68b8932b0b7c7e0 verbatim but is not itself a narrative statement).",
        mechanical_verification: {
          total_amount_appears_in_narrative_body: totalAmountAppearsInNarrative,
          total_amount_appears_in_citation_block_only: totalAmountAppearsInCitationOnly,
          checked_against: "work/domain-seed/seed-harness-v07-wire.r9/question_seed_v07_18.response.json (real HTTP wire capture, not a synthetic fixture)",
        },
        two_alternatives_compared: {
          alternative_a: "A common Calculator PRODUCT formula: corrected_actual_shares x issue_price_per_share_krw, cross-verified exactly against evidence_ce757058c68b8932b0b7c7e0's 2,198,873,250원.",
          alternative_b: "A common ISSUANCE_AMOUNT metric proposal + Candidate Fact, grounded directly in the already-VERIFIED evidence_ce757058c68b8932b0b7c7e0 (no calculation needed -- the total is already stated verbatim in the source document).",
          decision: "Do NOT force a Flow-local calculation this Turn (Calculator's formula contract -- domain/runtime/agent-runtime.mjs CALCULATOR_FORMULAS -- has no PRODUCT op today, and adding one is a Shared-Service contract change needing its own version bump + contract tests + Codex review, outside this Turn's fixed scope). Instead ISSUANCE_AMOUNT is presented as ontology proposal card #4, RECOMMENDED over the PRODUCT-contract alternative, PENDING Owner judgment -- never implemented this Turn.",
        },
        turn_m3_matrix_v03_status: q18MatrixV03Row ? q18MatrixV03Row.status : null,
        turn_m4_matrix_v04_statuses: q18MatrixV04Row ? q18MatrixV04Row.statuses : null,
        status: "CORRECTED",
      },
    ],
    downstream_artifacts_updated: [
      "work/handoff/seed-final-response-owner-review/results/seed-response-ontology-proposal-decision-packet.v0.1.json (NEW -- 4 cards)",
      "work/handoff/seed-final-response-owner-review/results/seed-response-remediation-matrix.v0.4.jsonl (NEW -- array-of-statuses, Q09/Q18 corrected)",
    ],
    artifacts_left_unmodified: [
      "work/handoff/seed-final-response-owner-review/results/seed-response-structured-gap-ontology-audit.v0.1.json",
      "work/handoff/seed-final-response-owner-review/results/seed-response-remediation-matrix.v0.1.jsonl",
      "work/handoff/seed-final-response-owner-review/results/seed-response-remediation-matrix.v0.2.jsonl",
      "work/handoff/seed-final-response-owner-review/results/seed-response-remediation-matrix.v0.3.jsonl",
    ],
  };

  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(OUT_PATH, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ corrections: report.corrections.map((c) => ({ id: c.id, status: c.status })) }, null, 2));
}

main().catch((error) => { console.error(error.message); process.exit(1); });
