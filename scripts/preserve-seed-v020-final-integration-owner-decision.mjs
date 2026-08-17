// Turn M10 Section 1: preserves the user-supplied Turn M9 FINAL Owner
// decision (6 FIX_REQUIRED records, extracted from the offline
// final-integration-v0.1 review UI) as a byte-identical repo artifact,
// then independently re-verifies its content against every invariant
// Turn M10 requires before any Composer/Validator work begins.
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE_PATH = process.env.SEED_V020_FINAL_INTEGRATION_OWNER_DECISION_PATH ?? process.argv[2];
const EXPECTED_SOURCE_SHA256 = "db50fc817d03edfd6872cada0b723dc6ce80d601be13f35107acea509fa57797";
const OUT_PATH = "work/handoff/seed-final-response-owner-review/results/seed-v020-final-integration-owner-decision.v0.1.jsonl";
const MANIFEST_PATH = "work/handoff/seed-final-response-owner-review/results/seed-v020-final-integration-owner-decision.v0.1.manifest.json";
const VERIFICATION_REPORT_PATH = "work/handoff/seed-final-response-owner-review/results/seed-v020-final-integration-owner-decision.v0.1.verification-report.json";

const EXPECTED_QUESTION_IDS = new Set([
  "question_seed_v07_06", "question_seed_v07_09", "question_seed_v07_17",
  "question_seed_v07_18", "question_seed_v07_20", "question_seed_v07_25",
]);
const EXPECTED_INTEGRATION_PACKET_SHA256 = "cda1cb4a25d0462f470e0e0ec5551fb4c1262aec888e56e14c0ba8e2f61847e5";

function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function fail(msg) { throw new Error(`M10_OWNER_DECISION_PRESERVATION_BLOCKED: ${msg}`); }

// Parses JSONL that may or may not have a trailing newline -- splitting
// on "\n" and filtering empty trailing segments handles both cases
// identically, so a missing final newline never drops or merges the
// last record.
function parseJsonl(text) {
  return text.split("\n").filter((line) => line.trim().length > 0).map((line, idx) => {
    try { return JSON.parse(line); } catch (error) { fail(`line ${idx + 1} is not valid JSON: ${error.message}`); }
  });
}

async function main() {
  if (!SOURCE_PATH) fail("provide SEED_V020_FINAL_INTEGRATION_OWNER_DECISION_PATH or the source path as argv[2]");
  const sourceBytes = await readFile(SOURCE_PATH);
  const sourceSha256 = sha256(sourceBytes);
  if (sourceSha256 !== EXPECTED_SOURCE_SHA256) fail(`source sha256 mismatch (expected ${EXPECTED_SOURCE_SHA256}, actual ${sourceSha256})`);

  const sourceText = sourceBytes.toString("utf8");
  const hadTrailingNewline = sourceText.endsWith("\n");
  const records = parseJsonl(sourceText);
  if (records.length !== 6) fail(`expected exactly 6 records, parsed ${records.length}`);

  const seenIds = new Set();
  const checks = [];
  function check(label, pass, detail) { checks.push({ label, pass, detail: detail ?? null }); if (!pass) fail(`${label}: ${detail ?? "failed"}`); }

  for (const record of records) {
    if (seenIds.has(record.question_id)) fail(`duplicate question_id: ${record.question_id}`);
    seenIds.add(record.question_id);
  }
  check("question_id set is exactly the 6 target questions", [...seenIds].sort().join(",") === [...EXPECTED_QUESTION_IDS].sort().join(","),
    [...seenIds].sort().join(","));

  for (const record of records) {
    const label = `${record.question_id}`;
    check(`${label}: owner_disposition is FIX_REQUIRED`, record.owner_disposition === "FIX_REQUIRED", record.owner_disposition);
    check(`${label}: reviewer is 최재완`, record.reviewer === "최재완", record.reviewer);
    check(`${label}: reviewed_at is a valid ISO datetime`, typeof record.reviewed_at === "string" && !Number.isNaN(Date.parse(record.reviewed_at)), record.reviewed_at);
    check(`${label}: release_recommendation is NEEDS_FIX_BEFORE_V020`, record.release_recommendation === "NEEDS_FIX_BEFORE_V020", record.release_recommendation);
    check(`${label}: integration_packet_sha256 matches Turn M8 packet`, record.integration_packet_sha256 === EXPECTED_INTEGRATION_PACKET_SHA256, record.integration_packet_sha256);
    check(`${label}: r13_response_sha256 is a 64-hex string`, typeof record.r13_response_sha256 === "string" && /^[0-9a-f]{64}$/.test(record.r13_response_sha256), record.r13_response_sha256);
    check(`${label}: checklist_results.common/specific are non-empty arrays`, Array.isArray(record.checklist_results?.common) && record.checklist_results.common.length > 0
      && Array.isArray(record.checklist_results?.specific) && record.checklist_results.specific.length > 0, null);
  }

  const q18 = records.find((r) => r.question_id === "question_seed_v07_18");
  check("Q18: information_limit_accepted is true", q18.information_limit_accepted === true, q18.information_limit_accepted);
  for (const record of records) {
    if (record.question_id === "question_seed_v07_18") continue;
    check(`${record.question_id}: information_limit_accepted is null (not applicable)`, record.information_limit_accepted === null, record.information_limit_accepted);
  }
  const pendingCount = records.filter((r) => r.owner_disposition === "PENDING").length;
  check("0 records remain PENDING", pendingCount === 0, pendingCount);
  const fixRequiredCount = records.filter((r) => r.owner_disposition === "FIX_REQUIRED").length;
  check("exactly 6 records are FIX_REQUIRED", fixRequiredCount === 6, fixRequiredCount);

  // byte-identical preservation: write the SAME bytes read from source,
  // never re-serialized (re-serializing via JSON.stringify could subtly
  // reorder keys or change whitespace -- this writes verbatim source
  // bytes so "byte-identical" is literal, not merely "semantically
  // equal").
  await mkdir(path.join(REPO, path.dirname(OUT_PATH)), { recursive: true });
  await writeFile(path.join(REPO, OUT_PATH), sourceBytes);
  const preservedBytes = await readFile(path.join(REPO, OUT_PATH));
  if (!preservedBytes.equals(sourceBytes)) fail("preserved file bytes do not match source bytes");
  const preservedSha256 = sha256(preservedBytes);
  if (preservedSha256 !== sourceSha256) fail("preserved file sha256 does not match source sha256");

  const manifest = {
    schema_version: "0.1.0",
    generated_at: new Date().toISOString(),
    source_path_note: "User-supplied file outside the repo (Codex attachment) -- path itself intentionally not recorded (personal path); only its hash is pinned.",
    source_sha256: sourceSha256,
    preserved_path: OUT_PATH,
    preserved_sha256: preservedSha256,
    preserved_bytes: preservedBytes.length,
    record_count: records.length,
    had_trailing_newline_in_source: hadTrailingNewline,
    question_ids: [...seenIds].sort(),
    integration_packet_sha256: EXPECTED_INTEGRATION_PACKET_SHA256,
  };
  await writeFile(path.join(REPO, MANIFEST_PATH), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  const verificationReport = {
    schema_version: "0.1.0",
    generated_at: new Date().toISOString(),
    subject: OUT_PATH,
    subject_sha256: preservedSha256,
    total_checks: checks.length,
    total_pass: checks.filter((c) => c.pass).length,
    checks,
    records_summary: records.map((r) => ({
      question_id: r.question_id, owner_disposition: r.owner_disposition, reviewer: r.reviewer, reviewed_at: r.reviewed_at,
      information_limit_accepted: r.information_limit_accepted, r13_response_sha256: r.r13_response_sha256,
      checklist_common_count: r.checklist_results.common.length, checklist_specific_count: r.checklist_results.specific.length,
      checklist_common_checked: r.checklist_results.common.filter((c) => c.checked).length,
      checklist_specific_checked: r.checklist_results.specific.filter((c) => c.checked).length,
    })),
  };
  await writeFile(path.join(REPO, VERIFICATION_REPORT_PATH), `${JSON.stringify(verificationReport, null, 2)}\n`, "utf8");

  console.log(JSON.stringify({
    preserved_path: OUT_PATH, preserved_sha256: preservedSha256, record_count: records.length,
    total_checks: checks.length, total_pass: verificationReport.total_pass,
    manifest_path: MANIFEST_PATH, verification_report_path: VERIFICATION_REPORT_PATH,
  }, null, 2));
}

main().catch((error) => { console.error(error.message); process.exit(1); });
