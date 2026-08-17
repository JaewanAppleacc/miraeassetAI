// Turn M6 Section 2: freezes the approval scope from the two ingested
// Owner decisions -- marks exactly the 8 APPROVE Candidate records
// OWNER_APPROVED/PROMOTION_ELIGIBLE (never VERIFIED, never promoted this
// Turn), confirms Turn M5's 6 carried-forward records are untouched, and
// explicitly pins the two records that must NOT move: the old Q09
// CONTRACT_COUNTERPARTY Candidate (fact_74a2b743fee3b410295be924, stays
// NOT_PROMOTED/SUPERSEDED) and the Q18 ISSUANCE_AMOUNT preview
// (fact_f2e453495b94543bbd236303, stays NOT_PROMOTED/FIX_REQUIRED pending
// Section 3's re-verification). Never approves anything absent from the
// decision file.
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RESULTS_DIR = path.join(REPO, "work/handoff/seed-final-response-owner-review/results");
const CANDIDATE_DECISION_PATH = path.join(RESULTS_DIR, "seed-structured-gap-final-candidate-owner-decision.v0.1.jsonl");
const PROMOTION_PIN_M5_PATH = path.join(RESULTS_DIR, "seed-structured-gap-candidate-promotion-pin.v0.1.jsonl");
const CANDIDATE_PREVIEW_PATH = path.join(REPO, "work/domain-seed/seed-structured-gap-candidate-preview.v0.1.jsonl");
const CANDIDATES_V08_PATH = path.join(REPO, "work/domain-seed/seed-facts-candidates.v0.8.delta.jsonl");
const CANDIDATES_V09_PATH = path.join(REPO, "work/domain-seed/seed-facts-candidates.v0.9.delta.jsonl");
const CANDIDATES_V10_PATH = path.join(REPO, "work/domain-seed/seed-facts-candidates.v0.10.delta.jsonl");
const OUT_PATH = path.join(RESULTS_DIR, "seed-structured-gap-candidate-approval-scope-freeze.v0.1.json");

function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function jsonl(text) { return text.trim().split("\n").map((l) => JSON.parse(l)); }
function fail(msg) { throw new Error(`M6_APPROVAL_SCOPE_BLOCKED: ${msg}`); }

const Q09_COUNTERPARTY_FACT_ID = "fact_74a2b743fee3b410295be924";
const Q18_ISSUANCE_AMOUNT_FACT_ID = "fact_f2e453495b94543bbd236303";

async function main() {
  const candidateDecisionBytes = await readFile(CANDIDATE_DECISION_PATH);
  const candidateDecisionRows = jsonl(candidateDecisionBytes.toString("utf8"));
  const promotionPinM5Bytes = await readFile(PROMOTION_PIN_M5_PATH);
  const promotionPinM5Rows = jsonl(promotionPinM5Bytes.toString("utf8"));
  const previewBytes = await readFile(CANDIDATE_PREVIEW_PATH);
  const previewRows = jsonl(previewBytes.toString("utf8"));
  const previewByFactId = new Map(previewRows.map((r) => [r.fact.fact_id, r]));
  const v08Bytes = await readFile(CANDIDATES_V08_PATH);
  const v08Rows = jsonl(v08Bytes.toString("utf8"));
  const v08ByFactId = new Map(v08Rows.map((r) => [r.fact_id, r]));
  const v09Bytes = await readFile(CANDIDATES_V09_PATH);
  const v09Rows = jsonl(v09Bytes.toString("utf8"));
  const v09ByFactId = new Map(v09Rows.map((r) => [r.fact_id, r]));
  const v10Bytes = await readFile(CANDIDATES_V10_PATH);
  const v10Rows = jsonl(v10Bytes.toString("utf8"));
  const v10ByFactId = new Map(v10Rows.map((r) => [r.fact_id, r]));

  // -- 8 APPROVE -> OWNER_APPROVED / PROMOTION_ELIGIBLE, never VERIFIED --
  const approvedRows = candidateDecisionRows.filter((r) => r.owner_disposition === "APPROVE");
  if (approvedRows.length !== 8) fail(`expected 8 APPROVE rows, found ${approvedRows.length}`);

  const frozen = approvedRows.map((decision) => {
    let sourceCandidate = null;
    let sourceArtifact = null;
    if (decision.fact_id === "fact_f82c1de6278abecc5d72436f") {
      sourceCandidate = v10ByFactId.get(decision.fact_id);
      sourceArtifact = "work/domain-seed/seed-facts-candidates.v0.10.delta.jsonl";
    } else {
      const preview = previewByFactId.get(decision.fact_id);
      sourceCandidate = preview ? preview.fact : null;
      sourceArtifact = "work/domain-seed/seed-structured-gap-candidate-preview.v0.1.jsonl";
    }
    if (!sourceCandidate) fail(`no source Candidate content found for approved fact_id ${decision.fact_id}`);
    if (sourceCandidate.verification_status !== "CANDIDATE") fail(`${decision.fact_id} source is not verification_status CANDIDATE (found ${sourceCandidate.verification_status}) -- refusing to freeze an already-promoted record's scope`);
    return {
      fact_id: decision.fact_id,
      question_id: decision.question_id,
      metric_code: decision.metric_code,
      status: "OWNER_APPROVED",
      promotion_eligibility: "PROMOTION_ELIGIBLE",
      verification_status_unchanged: sourceCandidate.verification_status,
      promotion_status: "NOT_PROMOTED",
      source_artifact: sourceArtifact,
      owner_reviewer: decision.reviewer,
      owner_reviewed_at: decision.reviewed_at,
      owner_notes: decision.notes,
    };
  });

  // -- Turn M5's 6 carried-forward records must remain untouched (not in
  // this decision file, not re-reviewed, not modified) ------------------
  if (promotionPinM5Rows.length !== 6) fail(`expected 6 Turn M5 carried-forward rows, found ${promotionPinM5Rows.length}`);
  const decisionFactIds = new Set(candidateDecisionRows.map((r) => r.fact_id));
  const overlap = promotionPinM5Rows.filter((r) => decisionFactIds.has(r.fact_id));
  if (overlap.length !== 0) fail(`Turn M5 carried-forward records must not appear in the Turn M6 decision file: ${overlap.map((r) => r.fact_id).join(",")}`);
  if (promotionPinM5Rows.some((r) => r.status !== "CARRIED_FORWARD_OWNER_APPROVED" || r.promotion_status !== "NOT_PROMOTED")) {
    fail("one or more Turn M5 carried-forward records no longer show their original CARRIED_FORWARD_OWNER_APPROVED/NOT_PROMOTED status");
  }

  // -- Q09 counterparty MUST stay NOT_PROMOTED/SUPERSEDED ----------------
  const q09Original = v08ByFactId.get(Q09_COUNTERPARTY_FACT_ID);
  const q09Corrected = v09ByFactId.get(Q09_COUNTERPARTY_FACT_ID);
  if (!q09Original || !q09Corrected) fail("Q09 CONTRACT_COUNTERPARTY candidate not found in v0.8/v0.9");
  if (q09Corrected.verification_status !== "CANDIDATE") fail(`Q09 CONTRACT_COUNTERPARTY (${Q09_COUNTERPARTY_FACT_ID}) verification_status is ${q09Corrected.verification_status}, expected CANDIDATE (must remain NOT_PROMOTED)`);
  if (decisionFactIds.has(Q09_COUNTERPARTY_FACT_ID)) fail("Q09 CONTRACT_COUNTERPARTY must not appear in the new decision file -- it was already FIX_REQUIRED in the v0.2 decision (Turn M5) and superseded by TRUST_CONTRACT_INSTITUTION");

  // -- Q18 ISSUANCE_AMOUNT preview MUST stay NOT_PROMOTED/FIX_REQUIRED ---
  const q18Decision = candidateDecisionRows.find((r) => r.fact_id === Q18_ISSUANCE_AMOUNT_FACT_ID);
  if (!q18Decision || q18Decision.owner_disposition !== "FIX_REQUIRED") fail(`Q18 ISSUANCE_AMOUNT decision missing or not FIX_REQUIRED: ${JSON.stringify(q18Decision)}`);
  const q18Preview = previewByFactId.get(Q18_ISSUANCE_AMOUNT_FACT_ID);
  if (!q18Preview || q18Preview.fact.verification_status !== "CANDIDATE") fail(`Q18 ISSUANCE_AMOUNT preview not found or not CANDIDATE`);

  const freeze = {
    schema_version: "0.1.0",
    generated_at: new Date().toISOString(),
    turn: "M6",
    owner_approved_promotion_eligible: frozen,
    owner_approved_count: frozen.length,
    turn_m5_carried_forward_untouched: {
      count: promotionPinM5Rows.length,
      fact_ids: promotionPinM5Rows.map((r) => r.fact_id),
      re_reviewed_this_turn: false,
      modified_this_turn: false,
    },
    pinned_not_promoted: [
      {
        fact_id: Q09_COUNTERPARTY_FACT_ID,
        metric_code: "CONTRACT_COUNTERPARTY",
        status: "SUPERSEDED",
        promotion_status: "NOT_PROMOTED",
        superseded_by: "fact_d7f3008248d324ba2a878323 (TRUST_CONTRACT_INSTITUTION, OWNER_APPROVED this Turn)",
      },
      {
        fact_id: Q18_ISSUANCE_AMOUNT_FACT_ID,
        metric_code: "ISSUANCE_AMOUNT",
        status: "FIX_REQUIRED",
        promotion_status: "NOT_PROMOTED",
        note: "Section 3/4 re-verification proceeds separately this Turn -- this freeze artifact only records the decision boundary, never pre-judges the outcome.",
      },
    ],
    no_records_approved_outside_decision_file: true,
    promotion_executed_this_turn: false,
    source_candidate_decision_path: "work/handoff/seed-final-response-owner-review/results/seed-structured-gap-final-candidate-owner-decision.v0.1.jsonl",
    source_candidate_decision_sha256: sha256(candidateDecisionBytes),
  };

  await mkdir(RESULTS_DIR, { recursive: true });
  await writeFile(OUT_PATH, `${JSON.stringify(freeze, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({
    owner_approved_count: freeze.owner_approved_count,
    carried_forward_untouched: freeze.turn_m5_carried_forward_untouched.count,
    q09_status: freeze.pinned_not_promoted[0].status,
    q18_status: freeze.pinned_not_promoted[1].status,
  }, null, 2));
}

main().catch((error) => { console.error(error.message); process.exit(1); });
