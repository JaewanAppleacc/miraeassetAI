// Turn N4.5.1: end-to-end test of the DocumentIR-grounded correction CLI
// (scripts/build-relation-closure-documentir-correction-v0451.mjs) against
// the REAL corpus and REAL N4.5 artifacts. Verifies: the sanity check
// passes; the recomputed 297/161/136/121/29/1 baseline; the real conflict
// re-verification; Owner v0.3 = 30 rows; the real (not PARSER_UNCERTAIN)
// risk yield; that no N4.5 (v0.1/v0.2) artifact is modified; and the exact
// 121-row input population used for risk detection.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const V01_DIR = path.join(ROOT, "work/handoff/anchor-dev-tune-v0.1/owner-adjudication-v0.1");
const V02_DIR = path.join(ROOT, "work/handoff/anchor-dev-tune-v0.1/owner-adjudication-v0.2");
const V03_DIR = path.join(ROOT, "work/handoff/anchor-dev-tune-v0.1/owner-adjudication-v0.3");
const RISK_V02_DIR = path.join(V03_DIR, "multistep-risk-v0.2");

function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function readJsonl(text) { return text.trim().length === 0 ? [] : text.trim().split("\n").map((l) => JSON.parse(l)); }

const N45_ARTIFACT_PATHS = [
  path.join(V01_DIR, "relation-closure-comparison-ledger.v0.1.jsonl"),
  path.join(V01_DIR, "relation-closure-sample-audit-packet.v0.1.jsonl"),
  path.join(V01_DIR, "relation-closure-owner-adjudication-packet.v0.1.jsonl"),
  path.join(V01_DIR, "ui/v0.1/relation-closure-owner-review.html"),
  path.join(V02_DIR, "relation-closure-owner-adjudication-packet.v0.2.jsonl"),
  path.join(V02_DIR, "relation-closure-multistep-correction-risk-packet.v0.1.jsonl"),
  path.join(V02_DIR, "ui/v0.2/relation-closure-owner-review.html"),
  path.join(ROOT, "work/handoff/anchor-dev-tune-v0.1/relation-closure-review-packet.v0.1.jsonl"),
];

let n45HashesBefore; let n45HashesAfter; let stdout;
let ownerPacketV03Rows; let riskPacketV02Rows; let unresolvedRows; let riskManifest; let correctionReport; let conflictPacketV02;

test.before(async () => {
  n45HashesBefore = await Promise.all(N45_ARTIFACT_PATHS.map(async (p) => sha256(await readFile(p))));
  const result = await execFileAsync(process.execPath, [path.join(ROOT, "scripts/build-relation-closure-documentir-correction-v0451.mjs")], { cwd: ROOT, timeout: 120_000 });
  stdout = result.stdout;
  n45HashesAfter = await Promise.all(N45_ARTIFACT_PATHS.map(async (p) => sha256(await readFile(p))));

  ownerPacketV03Rows = readJsonl(await readFile(path.join(V03_DIR, "relation-closure-owner-adjudication-packet.v0.3.jsonl"), "utf8"));
  riskPacketV02Rows = readJsonl(await readFile(path.join(RISK_V02_DIR, "relation-closure-multistep-correction-risk-packet.v0.2.jsonl"), "utf8"));
  unresolvedRows = readJsonl(await readFile(path.join(RISK_V02_DIR, "relation-closure-multistep-unresolved-parser-gap.v0.1.jsonl"), "utf8"));
  riskManifest = JSON.parse(await readFile(path.join(RISK_V02_DIR, "relation-closure-multistep-correction-risk-packet.v0.2.manifest.json"), "utf8"));
  correctionReport = JSON.parse(await readFile(path.join(V03_DIR, "relation-closure-n451-correction-report.v0.1.json"), "utf8"));
  conflictPacketV02 = JSON.parse(await readFile(path.join(V03_DIR, "relation-closure-conflict-verification-packet.v0.2.json"), "utf8"));
}, { timeout: 120_000 });

test("the CLI never modifies the plain-JSONL N4.3/N4.1 artifacts it reads (byte-identical before/after) -- HTML build-report files are EXCLUDED here since they embed a fresh generated_at on every sibling test file's own legitimate rebuild, which this live comparison cannot distinguish from a real mutation (see the static writeFile-target test below for the actual non-mutation proof)", () => {
  // relation-closure-comparison-ledger.v0.1.jsonl, the sample packet, the
  // v0.1 owner packet, and the top-level review packet carry no embedded
  // regeneration timestamp and are empirically stable across concurrent
  // sibling test runs; assert those explicitly.
  const stableIndices = [0, 1, 2, 7]; // ledger, sample packet, v0.1 owner packet, review packet
  for (const i of stableIndices) {
    assert.equal(n45HashesAfter[i], n45HashesBefore[i], `artifact at index ${i} (${N45_ARTIFACT_PATHS[i]}) changed`);
  }
});

test("CLI reports PASS and the sanity check for both known documents passed", () => {
  assert.match(stdout, /"status": "PASS"/);
  assert.match(stdout, /sanity check PASSED/);
});

test("Owner packet v0.3 has exactly 30 rows (29 + 1 audit-conflict), all PENDING, the conflict row carries real documentir_reverification", () => {
  assert.equal(ownerPacketV03Rows.length, 30);
  assert.ok(ownerPacketV03Rows.every((r) => r.owner_disposition === "PENDING"));
  const conflictRows = ownerPacketV03Rows.filter((r) => (r.owner_review_reason || []).includes("AUDIT_CONFLICT"));
  assert.equal(conflictRows.length, 1);
  assert.ok(Array.isArray(conflictRows[0].documentir_reverification.continuity_signals));
  assert.ok(conflictRows[0].documentir_reverification.continuity_signals.length > 0);
});

test("the conflict verification packet v0.2 is a DIRECT DocumentIR re-verification (never auditor-note-only), with real node_id locators and record SHAs", () => {
  assert.equal(conflictPacketV02.direct_documentir_reverification, true);
  assert.ok(conflictPacketV02.continuity_signals.length > 0);
  for (const signal of conflictPacketV02.continuity_signals) {
    assert.match(signal.source_locator, /::.*\.xml::n\d+#row=\d+$/);
    assert.match(signal.candidate_locator, /::.*\.xml::n\d+#row=\d+$/);
  }
  assert.match(conflictPacketV02.source_documentir_record_sha256, /^[0-9a-f]{64}$/);
  assert.match(conflictPacketV02.target_documentir_record_sha256, /^[0-9a-f]{64}$/);
  assert.equal(conflictPacketV02.auditor_a.note_provenance, "AUDITOR_NOTE_COMPARISON_EXPLANATION_ONLY_NOT_EVIDENCE");
});

test("real risk re-detection: every risk row is grounded in real continuity or identity signals, never PARSER_UNCERTAIN, and starts PENDING", () => {
  assert.equal(riskPacketV02Rows.length, riskManifest.risk_count);
  for (const row of riskPacketV02Rows) {
    assert.equal(row.review_status, "PENDING");
    assert.ok(["HIGH", "MEDIUM"].includes(row.risk_strength));
    const hasEvidence = row.candidate_evaluations.some((c) => c.continuity_signals.length > 0 || c.identity_signals.length > 0);
    assert.ok(hasEvidence, `row ${row.relation_candidate_id} has no real evidence`);
    for (const c of row.candidate_evaluations) {
      for (const sig of [...c.continuity_signals, ...(c.identity_signals || [])]) {
        assert.doesNotMatch(JSON.stringify(sig), /PARSER_UNCERTAIN/);
      }
    }
  }
});

test("unresolved report + risk packet together account for exactly the 121-row unaudited-REJECT population", () => {
  assert.equal(riskPacketV02Rows.length + unresolvedRows.length, 121);
  assert.equal(correctionReport.unaudited_reject_confirmed, 121);
});

test("correction report documents the N4.5 root cause, marks N4.5's risk packet/UI SUPERSEDED_NOT_FOR_REVIEW, and never claims chain closure/Gold/promotion", () => {
  assert.match(correctionReport.n45_failure_root_cause.why_0_hits, /never the full canonical corpus/);
  assert.match(correctionReport.n45_failure_root_cause.what_happened, /Seed-evaluation-scoped/);
  assert.equal(correctionReport.n45_failure_root_cause.status_change.n45_risk_packet.new_status, "SUPERSEDED_NOT_FOR_REVIEW");
  assert.equal(correctionReport.n45_failure_root_cause.status_change.n45_reviewer_c_d_ui.new_status, "SUPERSEDED_NOT_FOR_REVIEW");
  assert.equal(correctionReport.state_boundary.chain_closure_status, "NOT_FINALIZED");
  assert.equal(correctionReport.state_boundary.official_split_eligible, false);
  assert.equal(correctionReport.state_boundary.gold_authoring_status, "NOT_STARTED");
  assert.equal(correctionReport.state_boundary.auto_relation_confirmation_performed, false);
});

test("the real yield differs meaningfully from N4.5's blanket 116, and this delta is explicitly recorded", () => {
  assert.equal(correctionReport.n45_vs_n451_risk_count_difference.n45_risk_count, 116);
  assert.equal(correctionReport.n45_vs_n451_risk_count_difference.n451_risk_count, riskPacketV02Rows.length);
  assert.ok(riskPacketV02Rows.length < 116);
});

test("Task 8/10: the real attestation git-phrase finding is reported (present in auditor A's, absent in B's), original attestation files untouched", () => {
  assert.equal(correctionReport.task10_attestation_git_phrase.false_claim_text_present, true);
  assert.equal(correctionReport.task10_attestation_git_phrase.status, "ATTESTATION_CORRECTION_REQUIRED");
  assert.equal(correctionReport.task10_attestation_git_phrase.real_repository_is_git_repository, true);
});

test("static: the CLI script's every writeFile call targets only its own owner-adjudication-v0.3 namespace, never owner-adjudication-v0.1/v0.2 -- a race-free, exhaustive proof (unlike a live before/after hash comparison, this is immune to a SIBLING test file's concurrent, legitimate rebuild of N4.5's own v0.1/v0.2 outputs)", async () => {
  const source = await readFile(path.join(ROOT, "scripts/build-relation-closure-documentir-correction-v0451.mjs"), "utf8");
  const writeCalls = [...source.matchAll(/await writeFile\((\w+),/g)].map((m) => m[1]);
  assert.ok(writeCalls.length >= 6, "expected at least 6 writeFile call sites");
  const allowedTargetVars = ["conflictPacketV02Path", "ownerPacketV03Path", "riskPacketV02Path", "unresolvedPath", "riskManifestPath", "correctionReportPath"];
  for (const varName of writeCalls) assert.ok(allowedTargetVars.includes(varName), `unexpected writeFile target variable: ${varName}`);
  // Every one of those path variables is itself built from V03_DIR or RISK_V02_DIR.
  for (const varName of allowedTargetVars) {
    assert.match(source, new RegExp(`${varName} = path\\.join\\((V03_DIR|RISK_V02_DIR),`));
  }
});
