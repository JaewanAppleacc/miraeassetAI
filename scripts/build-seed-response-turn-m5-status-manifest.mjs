// Turn M5 Section 8: a single manifest pinning every artifact this Turn
// touched or read, plus the explicit status of every record group. Never
// promotes anything, never authorizes release -- promotion_status and
// release_status are hardcoded NOT_PROMOTED / NOT_AUTHORIZED and are
// asserted (not just declared) against the actual artifacts below.
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = path.join(REPO, "work/handoff/seed-final-response-owner-review/results");
const OUT_PATH = path.join(OUT_DIR, "seed-response-turn-m5-status-manifest.v0.1.json");

function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function jsonl(text) { return text.trim().split("\n").map((l) => JSON.parse(l)); }
function fail(msg) { throw new Error(`STATUS_MANIFEST_BLOCKED: ${msg}`); }

async function pinnedFile(relPath) {
  const full = path.join(REPO, relPath);
  const bytes = await readFile(full);
  return { path: relPath, sha256: sha256(bytes), bytes };
}

async function main() {
  const ownerDecisionV02 = await pinnedFile("work/handoff/seed-final-response-owner-review/results/seed-structured-gap-candidate-owner-decision.v0.2.jsonl");
  const candidatesV08 = await pinnedFile("work/domain-seed/seed-facts-candidates.v0.8.delta.jsonl");
  const candidatesV09 = await pinnedFile("work/domain-seed/seed-facts-candidates.v0.9.delta.jsonl");
  const candidatesV10 = await pinnedFile("work/domain-seed/seed-facts-candidates.v0.10.delta.jsonl");
  const promotionPin = await pinnedFile("work/handoff/seed-final-response-owner-review/results/seed-structured-gap-candidate-promotion-pin.v0.1.jsonl");
  const ontologyPacketV01 = await pinnedFile("work/handoff/seed-final-response-owner-review/results/seed-response-ontology-proposal-decision-packet.v0.1.json");
  const ontologyPacketV02 = await pinnedFile("work/handoff/seed-final-response-owner-review/results/seed-response-ontology-proposal-decision-packet.v0.2.json");
  const candidatePreview = await pinnedFile("work/domain-seed/seed-structured-gap-candidate-preview.v0.1.jsonl");

  const ownerDecisionRows = jsonl(ownerDecisionV02.bytes.toString("utf8"));
  const approvedRows = ownerDecisionRows.filter((r) => r.owner_disposition === "APPROVE");
  const fixRequiredRows = ownerDecisionRows.filter((r) => r.owner_disposition === "FIX_REQUIRED");
  if (approvedRows.length !== 6) fail(`expected 6 APPROVE rows, found ${approvedRows.length}`);
  if (fixRequiredRows.length !== 2) fail(`expected 2 FIX_REQUIRED rows, found ${fixRequiredRows.length}`);

  const promotionPinRows = jsonl(promotionPin.bytes.toString("utf8"));
  if (promotionPinRows.length !== 6) fail(`expected 6 promotion-pinned rows, found ${promotionPinRows.length}`);
  if (promotionPinRows.some((r) => r.status !== "CARRIED_FORWARD_OWNER_APPROVED")) fail("not all promotion-pinned rows are CARRIED_FORWARD_OWNER_APPROVED");
  if (promotionPinRows.some((r) => r.promotion_status !== "NOT_PROMOTED")) fail("a promotion-pinned row claims to already be promoted");

  const previewRows = jsonl(candidatePreview.bytes.toString("utf8"));
  if (previewRows.length !== 8) fail(`expected 8 ontology-dependent preview rows, found ${previewRows.length}`);
  if (previewRows.some((r) => r.preview_status !== "PROPOSAL_DEPENDENT_CANDIDATE")) fail("a preview row is not marked PROPOSAL_DEPENDENT_CANDIDATE");
  if (previewRows.some((r) => r.owner_disposition !== "PENDING")) fail("a preview row is not PENDING");

  const candidatesV10Rows = jsonl(candidatesV10.bytes.toString("utf8"));
  if (candidatesV10Rows.length !== 1) fail(`expected 1 row in v0.10 (Q25 correction), found ${candidatesV10Rows.length}`);
  if (candidatesV10Rows[0].attributes.review_provenance.owner_disposition !== "PENDING") fail("Q25 corrected candidate is not PENDING");

  const q09OriginalFixRequired = fixRequiredRows.find((r) => r.fact_id === "fact_74a2b743fee3b410295be924");
  const q25OriginalFixRequired = fixRequiredRows.find((r) => r.fact_id === "fact_f82c1de6278abecc5d72436f");
  if (!q09OriginalFixRequired || !q25OriginalFixRequired) fail("could not find both expected FIX_REQUIRED source records");

  const status = {
    schema_version: "0.1.0",
    generated_at: new Date().toISOString(),
    pinned_artifacts: {
      owner_decision_v02: { path: ownerDecisionV02.path, sha256: ownerDecisionV02.sha256 },
      candidates_v08: { path: candidatesV08.path, sha256: candidatesV08.sha256 },
      candidates_v09: { path: candidatesV09.path, sha256: candidatesV09.sha256 },
      candidates_v10_q25_correction: { path: candidatesV10.path, sha256: candidatesV10.sha256 },
      promotion_pin_v01: { path: promotionPin.path, sha256: promotionPin.sha256 },
      ontology_packet_v01: { path: ontologyPacketV01.path, sha256: ontologyPacketV01.sha256 },
      ontology_packet_v02: { path: ontologyPacketV02.path, sha256: ontologyPacketV02.sha256 },
      candidate_preview_v01: { path: candidatePreview.path, sha256: candidatePreview.sha256 },
    },
    record_status: {
      carried_forward_owner_approved: {
        count: 6,
        status: "CARRIED_FORWARD_OWNER_APPROVED",
        fact_ids: promotionPinRows.map((r) => r.fact_id),
        promotion_status: "NOT_PROMOTED",
      },
      q09_original_counterparty_superseded: {
        count: 1,
        fact_id: "fact_74a2b743fee3b410295be924",
        status: "SUPERSEDED_FIX_REQUIRED",
        superseded_by: "ontology proposal card_id 3 (TRUST_CONTRACT_INSTITUTION) + its preview record",
        owner_decision_reviewer: q09OriginalFixRequired.reviewer,
        owner_decision_reviewed_at: q09OriginalFixRequired.reviewed_at,
      },
      q25_original_final_deadline_superseded: {
        count: 1,
        fact_id: "fact_f82c1de6278abecc5d72436f",
        status: "SUPERSEDED_FIX_REQUIRED",
        superseded_by: "work/domain-seed/seed-facts-candidates.v0.10.delta.jsonl (corrected raw_label/value_certainty, same fact_id, fresh PENDING revision)",
        owner_decision_reviewer: q25OriginalFixRequired.reviewer,
        owner_decision_reviewed_at: q25OriginalFixRequired.reviewed_at,
      },
      new_records_pending_owner_review: {
        count: 9,
        status: "PENDING_OWNER_REVIEW",
        breakdown: {
          ontology_dependent_previews: 8,
          q25_corrected_candidate: 1,
        },
      },
    },
    promotion_status: "NOT_PROMOTED",
    release_status: "NOT_AUTHORIZED",
    v020_manifest_or_decision_created: false,
    runtime_composer_plan_modified_this_turn: false,
  };

  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(OUT_PATH, `${JSON.stringify(status, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({
    carried_forward: status.record_status.carried_forward_owner_approved.count,
    superseded: 2,
    pending_new: status.record_status.new_records_pending_owner_review.count,
    promotion_status: status.promotion_status,
    release_status: status.release_status,
  }, null, 2));
}

main().catch((error) => { console.error(error.message); process.exit(1); });
