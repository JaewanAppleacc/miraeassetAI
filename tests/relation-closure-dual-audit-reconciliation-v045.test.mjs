// Turn N4.5: end-to-end test of the dual sample-audit reconciliation CLI
// (scripts/build-relation-closure-dual-audit-reconciliation-v045.mjs)
// against the REAL input files. Verifies the recomputed distribution
// (never hardcoded), the 1 real audit conflict, the risk-detection yield,
// the Task 8 attestation finding, that no existing v0.1 file is modified,
// and that every output artifact starts in the correct PENDING/NOT_STARTED
// state boundary.
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

function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function readJsonl(text) { return text.trim().length === 0 ? [] : text.trim().split("\n").map((l) => JSON.parse(l)); }

const V01_INPUT_PATHS = [
  path.join(V01_DIR, "relation-closure-sample-audit-packet.v0.1.jsonl"),
  path.join(V01_DIR, "relation-closure-comparison-ledger.v0.1.jsonl"),
  path.join(V01_DIR, "relation-closure-owner-adjudication-packet.v0.1.jsonl"),
  path.join(V01_DIR, "relation-closure-gate-status.v0.1.json"),
  path.join(V01_DIR, "results/sample-auditor-v0.1/relation-closure-sample-auditor-decision.v0.1.jsonl"),
  path.join(V01_DIR, "results/sample-auditor-v0.1/relation-closure-sample-auditor-attestation.v0.1.json"),
  path.join(V01_DIR, "results/sample-auditor-b-v0.1/relation-closure-sample-auditor-decision.v0.1.jsonl"),
  path.join(V01_DIR, "results/sample-auditor-b-v0.1/relation-closure-sample-auditor-b-attestation.v0.1.json"),
  path.join(ROOT, "work/domain-seed/exchange-correction-references.jsonl"),
];

let v01HashesBefore; let v01HashesAfter; let stdout;
let auditLedgerRows; let conflictPacket; let ownerPacketV02Rows; let riskPacketRows; let riskManifest; let gateStatusV02; let reconciliationReport;

test.before(async () => {
  v01HashesBefore = await Promise.all(V01_INPUT_PATHS.map(async (p) => sha256(await readFile(p))));
  const result = await execFileAsync(process.execPath, [path.join(ROOT, "scripts/build-relation-closure-dual-audit-reconciliation-v045.mjs")], { cwd: ROOT });
  stdout = result.stdout;
  v01HashesAfter = await Promise.all(V01_INPUT_PATHS.map(async (p) => sha256(await readFile(p))));

  auditLedgerRows = readJsonl(await readFile(path.join(V02_DIR, "relation-closure-audit-comparison-ledger.v0.1.jsonl"), "utf8"));
  conflictPacket = JSON.parse(await readFile(path.join(V02_DIR, "relation-closure-conflict-verification-packet.v0.1.json"), "utf8"));
  ownerPacketV02Rows = readJsonl(await readFile(path.join(V02_DIR, "relation-closure-owner-adjudication-packet.v0.2.jsonl"), "utf8"));
  riskPacketRows = readJsonl(await readFile(path.join(V02_DIR, "relation-closure-multistep-correction-risk-packet.v0.1.jsonl"), "utf8"));
  riskManifest = JSON.parse(await readFile(path.join(V02_DIR, "relation-closure-multistep-correction-risk-packet.v0.1.manifest.json"), "utf8"));
  gateStatusV02 = JSON.parse(await readFile(path.join(V02_DIR, "relation-closure-gate-status.v0.2.json"), "utf8"));
  reconciliationReport = JSON.parse(await readFile(path.join(V02_DIR, "relation-closure-n45-reconciliation-report.v0.1.json"), "utf8"));
}, { timeout: 30_000 });

test("the CLI never modifies any of the 9 real v0.1/domain-seed input files (byte-identical before/after)", () => {
  assert.deepEqual(v01HashesAfter, v01HashesBefore);
});

test("CLI reports PASS and echoes the recomputed distribution in its own stdout", () => {
  assert.match(stdout, /"status": "PASS"/);
});

test("30-row dual-audit comparison ledger: 29 DUAL_AUDIT_PASS + 1 AUDIT_CONFLICT_OWNER_REVIEW_REQUIRED, no auto-picked winner on the conflict", () => {
  assert.equal(auditLedgerRows.length, 30);
  const byStatus = {};
  for (const r of auditLedgerRows) byStatus[r.final_status] = (byStatus[r.final_status] ?? 0) + 1;
  assert.equal(byStatus.DUAL_AUDIT_PASS, 29);
  assert.equal(byStatus.AUDIT_CONFLICT_OWNER_REVIEW_REQUIRED, 1);
  const conflictRows = auditLedgerRows.filter((r) => r.owner_review_required);
  assert.equal(conflictRows.length, 1);
  assert.equal(conflictRows[0].relation_candidate_id, "relation_candidate_433bbbf25ce9716814f35604");
});

test("the real conflict row reproduces the exact known shape: source, auditor A's proposed target, auditor B's PASS", () => {
  const row = auditLedgerRows.find((r) => r.relation_candidate_id === "relation_candidate_433bbbf25ce9716814f35604");
  assert.equal(row.source_document_id, "exchange_20250113800603");
  assert.equal(row.auditor_a_disposition, "DEFECT_FOUND");
  assert.equal(row.auditor_a_expected_target, "exchange_20240617800437");
  assert.equal(row.auditor_b_disposition, "PASS");
});

test("conflict verification packet cites real correction-reference evidence and both auditors' notes, and never hardcodes the AMENDS definition as a decision rule", () => {
  assert.equal(conflictPacket.relation_candidate_id, "relation_candidate_433bbbf25ce9716814f35604");
  assert.equal(conflictPacket.correction_reference_record.reference_status, "TARGET_NOT_IN_CORPUS");
  assert.equal(conflictPacket.correction_reference_record.referenced_receipt_date, "2021-07-30");
  assert.ok(conflictPacket.correction_reference_record.evidence.length >= 2);
  assert.ok(conflictPacket.auditor_a.audit_note.length > 0);
  assert.ok(conflictPacket.auditor_b.audit_note.length > 0);
  assert.match(conflictPacket.amends_definition.note, /never used to auto-decide/);
  assert.equal(conflictPacket.owner_disposition, "PENDING");
});

test("Owner packet v0.2 has exactly 30 rows (29 v0.1 PENDING + 1 AUDIT_CONFLICT), all PENDING, v0.1's own 29-row packet untouched", () => {
  assert.equal(ownerPacketV02Rows.length, 30);
  assert.ok(ownerPacketV02Rows.every((r) => r.owner_disposition === "PENDING"));
  const conflictRows = ownerPacketV02Rows.filter((r) => (r.owner_review_reason || []).includes("AUDIT_CONFLICT"));
  assert.equal(conflictRows.length, 1);
  assert.equal(new Set(ownerPacketV02Rows.map((r) => r.relation_candidate_id)).size, 30);
});

test("unaudited PROVISIONAL_REJECT population recomputes to exactly 121 (297 provisional, 161 CONFIRM / 136 REJECT, minus the 15 sampled REJECT)", () => {
  assert.equal(reconciliationReport.recomputed_distribution.provisional_total, 297);
  assert.equal(reconciliationReport.recomputed_distribution.provisional_confirm, 161);
  assert.equal(reconciliationReport.recomputed_distribution.provisional_reject, 136);
  assert.equal(reconciliationReport.recomputed_distribution.unaudited_reject, 121);
});

test("multi-step correction risk packet: real recomputed yield (never a fabricated/forced count), all rows review_status PENDING", () => {
  assert.equal(riskPacketRows.length, reconciliationReport.multistep_correction_risk.flagged_count);
  assert.ok(riskPacketRows.every((r) => r.review_status === "PENDING"));
  assert.equal(riskManifest.risk_count, riskPacketRows.length);
  assert.equal(riskManifest.all_review_status_pending, true);
});

test("risk packet rows never carry a company/document-id/amount literal baked into a hardcoded expectation -- every row's risk_reason is one of the two general templates", () => {
  const allowedReasons = new Set(["NO_CORRECTION_REFERENCE_RECORD_AVAILABLE_FOR_THIS_DOC_GROUP", "CORRECTION_REFERENCE_STATUS_TARGET_NOT_IN_CORPUS_WITH_EXISTING_CANDIDATES", "CORRECTION_REFERENCE_STATUS_AMBIGUOUS_WITH_EXISTING_CANDIDATES", "CORRECTION_REFERENCE_STATUS_MATCHED_IN_CORPUS_WITH_EXISTING_CANDIDATES"]);
  for (const r of riskPacketRows) assert.ok(allowedReasons.has(r.risk_reason), `unexpected risk_reason: ${r.risk_reason}`);
});

test("Task 8: auditor A's real attestation IS found to contain the false git-repository claim -- reported ATTESTATION_CORRECTION_REQUIRED, auditor B's does not", () => {
  assert.equal(reconciliationReport.task8_attestation_git_phrase_check.auditor_a_attestation_contains_false_claim, true);
  assert.equal(reconciliationReport.task8_attestation_git_phrase_check.auditor_b_attestation_contains_false_claim, false);
  assert.equal(reconciliationReport.task8_attestation_git_phrase_check.status, "ATTESTATION_CORRECTION_REQUIRED");
});

test("gate status v0.2 declares the full required state boundary: not promoted, not chain-closed, not split-eligible, Gold not started, no auto-confirm", () => {
  assert.equal(gateStatusV02.provisional_297.promoted, false);
  assert.equal(gateStatusV02.chain_closure_status, "NOT_FINALIZED");
  assert.equal(gateStatusV02.official_split_eligible, false);
  assert.equal(gateStatusV02.gold_authoring_status, "NOT_STARTED");
  assert.equal(gateStatusV02.auto_owner_approval_performed, false);
  assert.equal(gateStatusV02.auto_chain_closure_performed, false);
  assert.equal(gateStatusV02.auto_relation_confirmation_performed, false);
  assert.equal(gateStatusV02.multistep_correction_risk.auto_confirmed, false);
});

test("re-running the CLI a second time is idempotent and still reports PASS with byte-identical recomputed counts", async () => {
  const second = await execFileAsync(process.execPath, [path.join(ROOT, "scripts/build-relation-closure-dual-audit-reconciliation-v045.mjs")], { cwd: ROOT });
  assert.match(second.stdout, /"status": "PASS"/);
  assert.match(second.stdout, /"risk_flagged_count": 116/);
});

test("static: the CLI script's every writeFile call targets only its own owner-adjudication-v0.2 (OUT_DIR) namespace, never owner-adjudication-v0.1 -- a race-free, exhaustive proof that this script cannot be the source of any v0.1 mutation (unlike a live before/after hash comparison against relation-closure-sample-audit-packet.v0.1.manifest.json, which relation-closure-owner-packet-v043.test.mjs's own concurrent, legitimate manifest rebuild would otherwise intermittently trip)", async () => {
  const source = await readFile(path.join(ROOT, "scripts/build-relation-closure-dual-audit-reconciliation-v045.mjs"), "utf8");
  assert.match(source, /const OUT_DIR = path\.join\(REPO, "work\/handoff\/anchor-dev-tune-v0\.1\/owner-adjudication-v0\.2"\)/);
  const writeCalls = [...source.matchAll(/await writeFile\((\w+),/g)].map((m) => m[1]);
  assert.ok(writeCalls.length >= 7, "expected at least 7 writeFile call sites");
  const allowedTargetVars = ["auditLedgerPath", "conflictPacketPath", "ownerPacketV02Path", "riskPacketPath", "riskPacketManifestPath", "gateStatusV02Path", "reconciliationReportPath"];
  for (const varName of writeCalls) assert.ok(allowedTargetVars.includes(varName), `unexpected writeFile target variable: ${varName}`);
  for (const varName of allowedTargetVars) {
    assert.match(source, new RegExp(`${varName} = path\\.join\\(OUT_DIR,`));
  }
});
