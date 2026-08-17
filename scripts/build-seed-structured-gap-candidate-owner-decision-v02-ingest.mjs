// Turn M5 Section 1: ingest the externally-authored Owner decision file
// (delivered outside the repo) as a byte-identical, NEW immutable
// artifact, plus a manifest and an independent re-verification report.
// This script NEVER edits or rewrites the Owner decision content -- it
// only copies bytes and reports on them. Read-only over the source
// Candidate deltas (v0.8/v0.9) and VERIFIED Evidence -- never modifies
// them.
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE_PATH = process.env.SEED_STRUCTURED_GAP_OWNER_DECISION_PATH ?? process.argv[2];
const EXPECTED_SHA256 = "899be2dea69a40ea42f610b92997127bea7785520e0d9a07d2d2ca7670d1215d";
const CANDIDATES_V08_PATH = path.join(REPO, "work/domain-seed/seed-facts-candidates.v0.8.delta.jsonl");
const CANDIDATES_V09_PATH = path.join(REPO, "work/domain-seed/seed-facts-candidates.v0.9.delta.jsonl");
const EVIDENCE_VERIFIED_PATH = path.join(REPO, "work/domain-seed/seed-evidence-verified.v0.9.jsonl");
const OUT_DIR = path.join(REPO, "work/handoff/seed-final-response-owner-review/results");
const OUT_JSONL_PATH = path.join(OUT_DIR, "seed-structured-gap-candidate-owner-decision.v0.2.jsonl");
const OUT_MANIFEST_PATH = path.join(OUT_DIR, "seed-structured-gap-candidate-owner-decision.v0.2.manifest.json");
const OUT_VERIFICATION_PATH = path.join(OUT_DIR, "seed-structured-gap-candidate-owner-decision.v0.2.verification-report.json");

function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function sha256hex(s) { return createHash("sha256").update(s, "utf8").digest("hex"); }
function jsonl(text) { return text.trim().split("\n").map((l) => JSON.parse(l)); }
function fail(msg) { throw new Error(`INGEST_BLOCKED: ${msg}`); }

async function main() {
  if (!SOURCE_PATH) fail("provide SEED_STRUCTURED_GAP_OWNER_DECISION_PATH or the source path as argv[2]");
  const sourceBytes = await readFile(SOURCE_PATH);
  const actualSha = sha256(sourceBytes);
  if (actualSha !== EXPECTED_SHA256) {
    fail(`source file sha256 mismatch: expected ${EXPECTED_SHA256}, actual ${actualSha} -- refusing to ingest a file that does not match the pinned hash`);
  }

  await mkdir(OUT_DIR, { recursive: true });
  await copyFile(SOURCE_PATH, OUT_JSONL_PATH);
  const copiedBytes = await readFile(OUT_JSONL_PATH);
  if (sha256(copiedBytes) !== EXPECTED_SHA256) fail("byte-identical copy verification failed after copyFile");

  const decisionRows = jsonl(copiedBytes.toString("utf8"));

  // -- Structural checks -------------------------------------------------
  if (decisionRows.length !== 8) fail(`expected 8 records, found ${decisionRows.length}`);
  const dispositionCounts = { APPROVE: 0, FIX_REQUIRED: 0, PENDING: 0, REJECT: 0 };
  const factIdSeen = new Set();
  const missingReviewerOrDate = [];
  const duplicateFactIds = [];
  for (const row of decisionRows) {
    dispositionCounts[row.owner_disposition] = (dispositionCounts[row.owner_disposition] ?? 0) + 1;
    if (factIdSeen.has(row.fact_id)) duplicateFactIds.push(row.fact_id);
    factIdSeen.add(row.fact_id);
    if (!row.reviewer || !row.reviewed_at) missingReviewerOrDate.push(row.fact_id);
  }
  if (dispositionCounts.APPROVE !== 6) fail(`expected 6 APPROVE, found ${dispositionCounts.APPROVE}`);
  if (dispositionCounts.FIX_REQUIRED !== 2) fail(`expected 2 FIX_REQUIRED, found ${dispositionCounts.FIX_REQUIRED}`);
  if (dispositionCounts.PENDING !== 0) fail(`expected 0 PENDING, found ${dispositionCounts.PENDING}`);
  if (missingReviewerOrDate.length !== 0) fail(`records missing reviewer/reviewed_at: ${missingReviewerOrDate.join(",")}`);
  if (duplicateFactIds.length !== 0) fail(`duplicate fact_id(s): ${duplicateFactIds.join(",")}`);

  // -- Source Candidate / Evidence re-verification ------------------------
  const v08Bytes = await readFile(CANDIDATES_V08_PATH);
  const v08Rows = jsonl(v08Bytes.toString("utf8"));
  const v08ByFactId = new Map(v08Rows.map((r) => [r.fact_id, r]));
  const v09Bytes = await readFile(CANDIDATES_V09_PATH);
  const v09Rows = jsonl(v09Bytes.toString("utf8"));
  const v09ByFactId = new Map(v09Rows.map((r) => [r.fact_id, r]));
  const evidenceBytes = await readFile(EVIDENCE_VERIFIED_PATH);
  const evidenceRows = jsonl(evidenceBytes.toString("utf8"));
  const evidenceById = new Map(evidenceRows.map((e) => [e.evidence_id, e]));

  const perRecordVerification = [];
  for (const row of decisionRows) {
    const supersede = v09ByFactId.get(row.fact_id);
    const base = v08ByFactId.get(row.fact_id);
    const sourceCandidate = supersede ?? base;
    // candidate_superseded_by_v09 is informational only (true for exactly
    // the 1 fact Turn M4 corrected) -- never part of the pass/fail gate.
    const checks = {
      candidate_found_in_v08: Boolean(base),
      metric_code_matches: sourceCandidate ? sourceCandidate.metric_code === row.metric_code : false,
      evidence_all_verified: false,
      evidence_quote_sha256_matches: false,
    };
    const candidateSupersededByV09 = Boolean(supersede);
    if (sourceCandidate) {
      const evChecks = sourceCandidate.evidence_ids.map((eid) => {
        const ev = evidenceById.get(eid);
        if (!ev) return { evidence_id: eid, found: false };
        return {
          evidence_id: eid, found: true,
          verified: ev.verification_status === "VERIFIED",
          quote_sha256_matches: sha256hex(ev.quoted_text) === ev.quote_sha256,
        };
      });
      checks.evidence_all_verified = evChecks.every((e) => e.found && e.verified);
      checks.evidence_quote_sha256_matches = evChecks.every((e) => e.found && e.quote_sha256_matches);
      checks.evidence_detail = evChecks;
    }
    const allPass = Object.entries(checks).every(([k, v]) => k === "evidence_detail" || v === true);
    perRecordVerification.push({
      fact_id: row.fact_id,
      question_id: row.question_id,
      owner_disposition: row.owner_disposition,
      source_candidate_content_sha256: sourceCandidate ? sha256hex(JSON.stringify(sourceCandidate)) : null,
      source_candidate_revision: supersede ? "v0.9" : (base ? "v0.8" : null),
      candidate_superseded_by_v09: candidateSupersededByV09,
      checks,
      verdict: allPass ? "RE_VERIFIED_OK" : "RE_VERIFICATION_FAILED",
    });
  }
  const failedVerifications = perRecordVerification.filter((v) => v.verdict !== "RE_VERIFIED_OK");
  if (failedVerifications.length !== 0) {
    fail(`re-verification failed for: ${failedVerifications.map((v) => v.fact_id).join(",")}`);
  }

  const manifest = {
    schema_version: "0.1.0",
    generated_at: new Date().toISOString(),
    source_path_outside_repo: SOURCE_PATH,
    artifact: "work/handoff/seed-final-response-owner-review/results/seed-structured-gap-candidate-owner-decision.v0.2.jsonl",
    artifact_sha256: EXPECTED_SHA256,
    byte_identical_to_source: true,
    record_count: decisionRows.length,
    disposition_counts: dispositionCounts,
    reviewer_reviewed_at_missing_count: missingReviewerOrDate.length,
    duplicate_fact_id_count: duplicateFactIds.length,
    fact_ids: decisionRows.map((r) => r.fact_id),
    content_never_rewritten: true,
  };
  await writeFile(OUT_MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  const verificationReport = {
    schema_version: "0.1.0",
    generated_at: manifest.generated_at,
    input_decision_artifact_sha256: EXPECTED_SHA256,
    candidates_v08_path: "work/domain-seed/seed-facts-candidates.v0.8.delta.jsonl",
    candidates_v08_sha256: sha256(v08Bytes),
    candidates_v09_path: "work/domain-seed/seed-facts-candidates.v0.9.delta.jsonl",
    candidates_v09_sha256: sha256(v09Bytes),
    evidence_verified_path: "work/domain-seed/seed-evidence-verified.v0.9.jsonl",
    evidence_verified_sha256: sha256(evidenceBytes),
    per_record: perRecordVerification,
    all_records_re_verified_ok: failedVerifications.length === 0,
  };
  await writeFile(OUT_VERIFICATION_PATH, `${JSON.stringify(verificationReport, null, 2)}\n`, "utf8");

  console.log(JSON.stringify({
    artifact_sha256: manifest.artifact_sha256,
    record_count: manifest.record_count,
    disposition_counts: manifest.disposition_counts,
    all_records_re_verified_ok: verificationReport.all_records_re_verified_ok,
  }, null, 2));
}

main().catch((error) => { console.error(error.message); process.exit(1); });
