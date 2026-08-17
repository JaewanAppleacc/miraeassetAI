// Turn M6 Section 1: ingest the two externally-authored Owner decision
// files (ontology proposal v0.2, final Candidate v0.1) as byte-identical
// NEW immutable artifacts, plus manifests and independent re-verification
// reports. Never edits/rewrites decision content. Read-only over the
// Turn M5 artifacts these decisions reference (ontology packet v0.2,
// Candidate preview v0.1, promotion pin v0.1) -- never modifies them.
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const ONTOLOGY_SOURCE_PATH = process.env.SEED_ONTOLOGY_OWNER_DECISION_PATH ?? process.argv[2];
const ONTOLOGY_EXPECTED_SHA256 = "9503cc79b2bd63c2ac6b52e6da1e4ffbb01c72232781ef33b296fa0f840d49ee";
const CANDIDATE_SOURCE_PATH = process.env.SEED_FINAL_CANDIDATE_OWNER_DECISION_PATH ?? process.argv[3];
const CANDIDATE_EXPECTED_SHA256 = "99a0394b63a2e073c984bcd525fb6c7e78c4d523a07a952743201d662375a8f6";

const ONTOLOGY_PACKET_V02_PATH = path.join(REPO, "work/handoff/seed-final-response-owner-review/results/seed-response-ontology-proposal-decision-packet.v0.2.json");
const CANDIDATE_PREVIEW_PATH = path.join(REPO, "work/domain-seed/seed-structured-gap-candidate-preview.v0.1.jsonl");
const CANDIDATES_V10_PATH = path.join(REPO, "work/domain-seed/seed-facts-candidates.v0.10.delta.jsonl");
const PROMOTION_PIN_PATH = path.join(REPO, "work/handoff/seed-final-response-owner-review/results/seed-structured-gap-candidate-promotion-pin.v0.1.jsonl");

const OUT_DIR = path.join(REPO, "work/handoff/seed-final-response-owner-review/results");
const ONTOLOGY_OUT_PATH = path.join(OUT_DIR, "seed-response-ontology-proposal-owner-decision.v0.2.jsonl");
const ONTOLOGY_MANIFEST_PATH = path.join(OUT_DIR, "seed-response-ontology-proposal-owner-decision.v0.2.manifest.json");
const ONTOLOGY_VERIFICATION_PATH = path.join(OUT_DIR, "seed-response-ontology-proposal-owner-decision.v0.2.verification-report.json");
const CANDIDATE_OUT_PATH = path.join(OUT_DIR, "seed-structured-gap-final-candidate-owner-decision.v0.1.jsonl");
const CANDIDATE_MANIFEST_PATH = path.join(OUT_DIR, "seed-structured-gap-final-candidate-owner-decision.v0.1.manifest.json");
const CANDIDATE_VERIFICATION_PATH = path.join(OUT_DIR, "seed-structured-gap-final-candidate-owner-decision.v0.1.verification-report.json");

function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function jsonl(text) { return text.trim().split("\n").map((l) => JSON.parse(l)); }
function fail(msg) { throw new Error(`M6_INGEST_BLOCKED: ${msg}`); }

async function ingestByteIdentical(sourcePath, expectedSha256, outPath) {
  const sourceBytes = await readFile(sourcePath);
  const actualSha = sha256(sourceBytes);
  if (actualSha !== expectedSha256) fail(`${sourcePath} sha256 mismatch: expected ${expectedSha256}, actual ${actualSha}`);
  await copyFile(sourcePath, outPath);
  const copiedBytes = await readFile(outPath);
  if (sha256(copiedBytes) !== expectedSha256) fail(`byte-identical copy verification failed for ${outPath}`);
  return copiedBytes;
}

async function main() {
  if (!ONTOLOGY_SOURCE_PATH || !CANDIDATE_SOURCE_PATH) {
    fail("provide ontology and final-Candidate Owner decision paths via environment variables or argv[2]/argv[3]");
  }
  await mkdir(OUT_DIR, { recursive: true });

  // -- Ontology proposal owner decision v0.2 ------------------------------
  const ontologyBytes = await ingestByteIdentical(ONTOLOGY_SOURCE_PATH, ONTOLOGY_EXPECTED_SHA256, ONTOLOGY_OUT_PATH);
  const ontologyRows = jsonl(ontologyBytes.toString("utf8"));
  if (ontologyRows.length !== 5) fail(`expected 5 ontology decision rows, found ${ontologyRows.length}`);
  const ontologyDispositions = { APPROVE: 0, PENDING: 0, FIX_REQUIRED: 0, REJECT: 0 };
  const ontologyMissingReviewer = [];
  const ontologyCardIds = new Set();
  for (const row of ontologyRows) {
    ontologyDispositions[row.owner_disposition] = (ontologyDispositions[row.owner_disposition] ?? 0) + 1;
    if (!row.reviewer || !row.reviewed_at || Number.isNaN(Date.parse(row.reviewed_at))) ontologyMissingReviewer.push(row.card_id);
    if (row.reviewer !== "최재완") fail(`unexpected reviewer for card ${row.card_id}: ${row.reviewer}`);
    ontologyCardIds.add(row.card_id);
  }
  if (ontologyDispositions.APPROVE !== 5) fail(`expected 5 APPROVE ontology cards, found ${ontologyDispositions.APPROVE}`);
  if ((ontologyDispositions.PENDING ?? 0) !== 0 || (ontologyDispositions.FIX_REQUIRED ?? 0) !== 0 || (ontologyDispositions.REJECT ?? 0) !== 0) {
    fail(`expected 0 PENDING/FIX_REQUIRED/REJECT ontology cards, found ${JSON.stringify(ontologyDispositions)}`);
  }
  if (ontologyMissingReviewer.length) fail(`ontology cards missing reviewer/reviewed_at: ${ontologyMissingReviewer.join(",")}`);
  if (ontologyCardIds.size !== 5) fail(`expected 5 distinct card_id, found ${ontologyCardIds.size}`);

  const approvedTokens = ontologyRows.flatMap((r) => r.proposed_tokens);
  const expectedTokens = ["INVESTMENT_PURPOSE", "INVESTMENT_TARGET_ASSET", "ACQUISITION_PLANNED_SHARES", "TRUST_CONTRACT_INSTITUTION", "CORRECTION_REASON", "ISSUANCE_AMOUNT"];
  if (JSON.stringify([...approvedTokens].sort()) !== JSON.stringify([...expectedTokens].sort())) {
    fail(`approved token set mismatch: expected ${expectedTokens.sort().join(",")}, got ${approvedTokens.sort().join(",")}`);
  }

  // Cross-verify against Turn M5's ontology packet v0.2 (card_id -> token/dependent-preview linkage must match exactly).
  const ontologyPacketBytes = await readFile(ONTOLOGY_PACKET_V02_PATH);
  const ontologyPacket = JSON.parse(ontologyPacketBytes.toString("utf8"));
  const packetCardById = new Map(ontologyPacket.cards.map((c) => [c.card_id, c]));
  const ontologyCrossCheck = ontologyRows.map((row) => {
    const packetCard = packetCardById.get(row.card_id);
    const tokensMatch = packetCard ? JSON.stringify(packetCard.proposed_tokens.map((t) => t.token)) === JSON.stringify(row.proposed_tokens) : false;
    return { card_id: row.card_id, found_in_packet_v02: Boolean(packetCard), tokens_match: tokensMatch, title_matches: packetCard ? packetCard.title === row.title : false };
  });
  if (ontologyCrossCheck.some((c) => !c.found_in_packet_v02 || !c.tokens_match || !c.title_matches)) {
    fail(`ontology decision does not cleanly cross-verify against packet v0.2: ${JSON.stringify(ontologyCrossCheck)}`);
  }

  const ontologyManifest = {
    schema_version: "0.1.0",
    generated_at: new Date().toISOString(),
    source_path_outside_repo: ONTOLOGY_SOURCE_PATH,
    artifact: "work/handoff/seed-final-response-owner-review/results/seed-response-ontology-proposal-owner-decision.v0.2.jsonl",
    artifact_sha256: ONTOLOGY_EXPECTED_SHA256,
    byte_identical_to_source: true,
    record_count: ontologyRows.length,
    disposition_counts: ontologyDispositions,
    approved_tokens: expectedTokens,
    card_ids: [...ontologyCardIds].sort((a, b) => a - b),
    content_never_rewritten: true,
    // Turn M6 Section 1 explicit clarification: ontology approval is
    // approval of the TOKEN DESIGN only, never an automatic approval of
    // every dependent Candidate record. Card 5 (ISSUANCE_AMOUNT) is
    // approved as a TOKEN even though its dependent preview
    // (fact_f2e453495b94543bbd236303) is separately FIX_REQUIRED in the
    // Candidate decision below -- these are two independent judgments.
    ontology_approval_scope_note: "Ontology 카드 APPROVE는 토큰 설계(의미/재사용성/과적합 위험) 승인이며, dependent_preview_fact_ids로 연결된 Candidate 레코드의 자동 승인이 아니다. 각 Candidate의 실제 승격 가능 여부는 seed-structured-gap-final-candidate-owner-decision.v0.1.jsonl의 개별 owner_disposition을 따른다.",
  };
  await writeFile(ONTOLOGY_MANIFEST_PATH, `${JSON.stringify(ontologyManifest, null, 2)}\n`, "utf8");

  const ontologyVerification = {
    schema_version: "0.1.0",
    generated_at: ontologyManifest.generated_at,
    input_decision_artifact_sha256: ONTOLOGY_EXPECTED_SHA256,
    ontology_packet_v02_path: "work/handoff/seed-final-response-owner-review/results/seed-response-ontology-proposal-decision-packet.v0.2.json",
    ontology_packet_v02_sha256: sha256(ontologyPacketBytes),
    per_card_cross_check: ontologyCrossCheck,
    all_cards_cross_verified_ok: ontologyCrossCheck.every((c) => c.found_in_packet_v02 && c.tokens_match && c.title_matches),
  };
  await writeFile(ONTOLOGY_VERIFICATION_PATH, `${JSON.stringify(ontologyVerification, null, 2)}\n`, "utf8");

  // -- Final Candidate owner decision v0.1 --------------------------------
  const candidateBytes = await ingestByteIdentical(CANDIDATE_SOURCE_PATH, CANDIDATE_EXPECTED_SHA256, CANDIDATE_OUT_PATH);
  const candidateRows = jsonl(candidateBytes.toString("utf8"));
  if (candidateRows.length !== 9) fail(`expected 9 candidate decision rows, found ${candidateRows.length}`);
  const candidateDispositions = { APPROVE: 0, PENDING: 0, FIX_REQUIRED: 0, REJECT: 0 };
  const candidateMissingReviewer = [];
  const candidateFactIds = new Set();
  for (const row of candidateRows) {
    candidateDispositions[row.owner_disposition] = (candidateDispositions[row.owner_disposition] ?? 0) + 1;
    if (!row.reviewer || !row.reviewed_at || Number.isNaN(Date.parse(row.reviewed_at))) candidateMissingReviewer.push(row.fact_id);
    if (row.reviewer !== "최재완") fail(`unexpected reviewer for ${row.fact_id}: ${row.reviewer}`);
    if (candidateFactIds.has(row.fact_id)) fail(`duplicate fact_id in candidate decision: ${row.fact_id}`);
    candidateFactIds.add(row.fact_id);
  }
  if (candidateDispositions.APPROVE !== 8) fail(`expected 8 APPROVE, found ${candidateDispositions.APPROVE}`);
  if (candidateDispositions.FIX_REQUIRED !== 1) fail(`expected 1 FIX_REQUIRED, found ${candidateDispositions.FIX_REQUIRED}`);
  if ((candidateDispositions.PENDING ?? 0) !== 0 || (candidateDispositions.REJECT ?? 0) !== 0) {
    fail(`expected 0 PENDING/REJECT, found ${JSON.stringify(candidateDispositions)}`);
  }
  if (candidateMissingReviewer.length) fail(`candidate rows missing reviewer/reviewed_at: ${candidateMissingReviewer.join(",")}`);

  const expectedApproved = new Set([
    "fact_75c2403584e5facb73b1ddf7", "fact_e853c77fed4888d55bfb1eae", "fact_1690ba78472f78be1d768b46",
    "fact_293afe50abda3d753a570fe0", "fact_df45402adfdb244214c751c5", "fact_d7f3008248d324ba2a878323",
    "fact_0234b056c7df027a63856980", "fact_f82c1de6278abecc5d72436f",
  ]);
  const actualApproved = new Set(candidateRows.filter((r) => r.owner_disposition === "APPROVE").map((r) => r.fact_id));
  if (JSON.stringify([...actualApproved].sort()) !== JSON.stringify([...expectedApproved].sort())) {
    fail(`APPROVE fact_id set mismatch: expected ${[...expectedApproved].sort().join(",")}, got ${[...actualApproved].sort().join(",")}`);
  }
  const fixRequiredRow = candidateRows.find((r) => r.owner_disposition === "FIX_REQUIRED");
  if (!fixRequiredRow || fixRequiredRow.fact_id !== "fact_f2e453495b94543bbd236303" || fixRequiredRow.metric_code !== "ISSUANCE_AMOUNT" || fixRequiredRow.question_id !== "question_seed_v07_18") {
    fail(`FIX_REQUIRED row does not match expected Q18 ISSUANCE_AMOUNT record: ${JSON.stringify(fixRequiredRow)}`);
  }

  // Cross-verify against Turn M5's Candidate preview v0.1 (8 ontology-dependent) + v0.10 delta (Q25 correction).
  const previewBytes = await readFile(CANDIDATE_PREVIEW_PATH);
  const previewRows = jsonl(previewBytes.toString("utf8"));
  const previewByFactId = new Map(previewRows.map((r) => [r.fact.fact_id, r]));
  const v10Bytes = await readFile(CANDIDATES_V10_PATH);
  const v10Rows = jsonl(v10Bytes.toString("utf8"));
  const v10ByFactId = new Map(v10Rows.map((r) => [r.fact_id, r]));

  const candidateCrossCheck = candidateRows.map((row) => {
    const preview = previewByFactId.get(row.fact_id);
    const q25 = v10ByFactId.get(row.fact_id);
    const source = preview ? "preview_v0.1" : (q25 ? "candidates_v0.10" : null);
    const metricCodeMatches = preview ? preview.fact.metric_code === row.metric_code : (q25 ? q25.metric_code === row.metric_code : false);
    return { fact_id: row.fact_id, source_found: Boolean(source), source, metric_code_matches: metricCodeMatches };
  });
  if (candidateCrossCheck.some((c) => !c.source_found || !c.metric_code_matches)) {
    fail(`candidate decision does not cleanly cross-verify against Turn M5 artifacts: ${JSON.stringify(candidateCrossCheck)}`);
  }

  const promotionPinBytes = await readFile(PROMOTION_PIN_PATH);
  const promotionPinRows = jsonl(promotionPinBytes.toString("utf8"));

  const candidateManifest = {
    schema_version: "0.1.0",
    generated_at: new Date().toISOString(),
    source_path_outside_repo: CANDIDATE_SOURCE_PATH,
    artifact: "work/handoff/seed-final-response-owner-review/results/seed-structured-gap-final-candidate-owner-decision.v0.1.jsonl",
    artifact_sha256: CANDIDATE_EXPECTED_SHA256,
    byte_identical_to_source: true,
    record_count: candidateRows.length,
    disposition_counts: candidateDispositions,
    approved_fact_ids: [...expectedApproved].sort(),
    fix_required_fact_ids: [fixRequiredRow.fact_id],
    content_never_rewritten: true,
    turn_m5_carried_forward_unaffected: promotionPinRows.map((r) => r.fact_id),
    note: "Turn M5에서 이미 CARRIED_FORWARD_OWNER_APPROVED로 pin된 6건은 이 decision 파일에 포함되지 않으며 재검수 대상도 아니다 -- 이 decision은 오직 9건(ontology-dependent preview 8건 + Q25 교정본 1건)만 다룬다.",
  };
  await writeFile(CANDIDATE_MANIFEST_PATH, `${JSON.stringify(candidateManifest, null, 2)}\n`, "utf8");

  const candidateVerification = {
    schema_version: "0.1.0",
    generated_at: candidateManifest.generated_at,
    input_decision_artifact_sha256: CANDIDATE_EXPECTED_SHA256,
    candidate_preview_v01_path: "work/domain-seed/seed-structured-gap-candidate-preview.v0.1.jsonl",
    candidate_preview_v01_sha256: sha256(previewBytes),
    candidates_v10_path: "work/domain-seed/seed-facts-candidates.v0.10.delta.jsonl",
    candidates_v10_sha256: sha256(v10Bytes),
    per_record_cross_check: candidateCrossCheck,
    all_records_cross_verified_ok: candidateCrossCheck.every((c) => c.source_found && c.metric_code_matches),
  };
  await writeFile(CANDIDATE_VERIFICATION_PATH, `${JSON.stringify(candidateVerification, null, 2)}\n`, "utf8");

  console.log(JSON.stringify({
    ontology: { sha256: ONTOLOGY_EXPECTED_SHA256, record_count: ontologyRows.length, disposition_counts: ontologyDispositions, all_cross_verified_ok: ontologyVerification.all_cards_cross_verified_ok },
    candidate: { sha256: CANDIDATE_EXPECTED_SHA256, record_count: candidateRows.length, disposition_counts: candidateDispositions, all_cross_verified_ok: candidateVerification.all_records_cross_verified_ok },
  }, null, 2));
}

main().catch((error) => { console.error(error.message); process.exit(1); });
