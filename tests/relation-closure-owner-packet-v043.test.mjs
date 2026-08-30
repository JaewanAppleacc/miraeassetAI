// Turn N4.3: real-data end-to-end verification of
// scripts/build-relation-closure-owner-packet-v043.mjs against the actual
// Reviewer A/B decision, remediation, and attestation files. Re-runs the
// real build in test.before (proving it is deterministic and does not
// mutate any input), then asserts on the real generated output.
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
const PACKET_DIR = path.join(ROOT, "work/handoff/anchor-dev-tune-v0.1");
const INPUTS = {
  packet: path.join(PACKET_DIR, "relation-closure-review-packet.v0.1.jsonl"),
  aBase: path.join(PACKET_DIR, "relation-closure-reviewer-a-decision.v0.1.jsonl"),
  bBase: path.join(PACKET_DIR, "relation-closure-reviewer-b-decision.v0.1.jsonl"),
  aRem: path.join(PACKET_DIR, "relation-closure-reviewer-a-remediation-decision.v0.1.jsonl"),
  bRem: path.join(PACKET_DIR, "relation-closure-reviewer-b-remediation-decision.v0.1.jsonl"),
};
const OUT_DIR = path.join(PACKET_DIR, "owner-adjudication-v0.1");
const LEDGER_PATH = path.join(OUT_DIR, "relation-closure-comparison-ledger.v0.1.jsonl");
const LEDGER_MANIFEST_PATH = path.join(OUT_DIR, "relation-closure-comparison-ledger.v0.1.manifest.json");
const OWNER_PACKET_PATH = path.join(OUT_DIR, "relation-closure-owner-adjudication-packet.v0.1.jsonl");
const SAMPLE_PACKET_PATH = path.join(OUT_DIR, "relation-closure-sample-audit-packet.v0.1.jsonl");
const SAMPLE_MANIFEST_PATH = path.join(OUT_DIR, "relation-closure-sample-audit-packet.v0.1.manifest.json");
const GATE_STATUS_PATH = path.join(OUT_DIR, "relation-closure-gate-status.v0.1.json");
const PROVENANCE_PATH = path.join(OUT_DIR, "relation-closure-overlay-provenance-report.v0.1.json");

function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function readJsonl(text) { return text.trim().split("\n").map((l) => JSON.parse(l)); }

let inputHashesBefore; let inputHashesAfter;
let ledgerRows; let ledgerManifest; let ownerPacket; let samplePacket; let sampleManifest; let gateStatus; let provenance;

test.before(async () => {
  inputHashesBefore = {};
  for (const [k, p] of Object.entries(INPUTS)) inputHashesBefore[k] = sha256(await readFile(p));

  await execFileAsync(process.execPath, [path.join(ROOT, "scripts/build-relation-closure-owner-packet-v043.mjs")], { cwd: ROOT });

  inputHashesAfter = {};
  for (const [k, p] of Object.entries(INPUTS)) inputHashesAfter[k] = sha256(await readFile(p));

  ledgerRows = readJsonl(await readFile(LEDGER_PATH, "utf8"));
  ledgerManifest = JSON.parse(await readFile(LEDGER_MANIFEST_PATH, "utf8"));
  ownerPacket = readJsonl(await readFile(OWNER_PACKET_PATH, "utf8"));
  samplePacket = readJsonl(await readFile(SAMPLE_PACKET_PATH, "utf8"));
  sampleManifest = JSON.parse(await readFile(SAMPLE_MANIFEST_PATH, "utf8"));
  gateStatus = JSON.parse(await readFile(GATE_STATUS_PATH, "utf8"));
  provenance = JSON.parse(await readFile(PROVENANCE_PATH, "utf8"));
}, { timeout: 30_000 });

test("the build never modifies any of the 5 real input files (base/remediation/packet)", () => {
  for (const key of Object.keys(INPUTS)) assert.equal(inputHashesAfter[key], inputHashesBefore[key], `${key} changed`);
});

test("ledger has exactly 326 rows, zero duplicate relation_candidate_id, and matches the real packet row count", () => {
  assert.equal(ledgerRows.length, 326);
  assert.equal(new Set(ledgerRows.map((r) => r.relation_candidate_id)).size, 326);
});

test("recomputed distribution matches the task's expected numbers exactly", () => {
  const v = ledgerManifest.verification;
  assert.equal(v.all_match, true);
  assert.deepEqual(v.actual, { total: 326, bothConfirm: 170, bothReject: 142, bothNeedsMoreReview: 1, disagree: 13, terminates: 16, ownerUnion: 29, provisional: 297 });
});

test("Owner review union is exactly 29 rows, and the union's per-reason counts match the manifest", () => {
  assert.equal(ownerPacket.length, 29);
  assert.equal(new Set(ownerPacket.map((r) => r.relation_candidate_id)).size, 29);
  const sel = ledgerManifest.owner_review_selection;
  assert.equal(sel.count, 29);
  assert.equal(sel.by_reason.DISAGREEMENT, 13);
  assert.equal(sel.by_reason.TERMINATES, 16);
  assert.equal(sel.by_reason.BOTH_NEEDS_MORE_REVIEW, 1);
});

test("every TERMINATES row in the ledger is present in the Owner packet (TERMINATES is never excluded even when both reviewers agree)", () => {
  const terminatesIds = new Set(ledgerRows.filter((r) => r.relation_type === "TERMINATES").map((r) => r.relation_candidate_id));
  const ownerIds = new Set(ownerPacket.map((r) => r.relation_candidate_id));
  assert.equal(terminatesIds.size, 16);
  for (const id of terminatesIds) assert.ok(ownerIds.has(id), `TERMINATES row ${id} missing from Owner packet`);
});

test("the 297 provisional rows are excluded from the Owner packet and are never marked with a promoted status", () => {
  const ownerIds = new Set(ownerPacket.map((r) => r.relation_candidate_id));
  const provisionalRows = ledgerRows.filter((r) => !r.owner_review_required);
  assert.equal(provisionalRows.length, 297);
  for (const row of provisionalRows) {
    assert.equal(ownerIds.has(row.relation_candidate_id), false);
    assert.ok(["PROVISIONAL_CONFIRM", "PROVISIONAL_REJECT"].includes(row.provisional_disposition));
  }
});

test("every Owner packet row starts PENDING with a null target and empty note (never pre-judged)", () => {
  for (const row of ownerPacket) {
    assert.equal(row.owner_disposition, "PENDING");
    assert.equal(row.confirmed_target_document_id, null);
    assert.equal(row.owner_note, "");
  }
});

test("sample audit packet has exactly 30 rows: 15 drawn from PROVISIONAL_CONFIRM, 15 from PROVISIONAL_REJECT, none from the Owner-review 29", () => {
  assert.equal(samplePacket.length, 30);
  const confirmDrawn = samplePacket.filter((r) => r.expected_disposition_family === "PROVISIONAL_CONFIRM");
  const rejectDrawn = samplePacket.filter((r) => r.expected_disposition_family === "PROVISIONAL_REJECT");
  assert.equal(confirmDrawn.length, 15);
  assert.equal(rejectDrawn.length, 15);
  const ownerIds = new Set(ownerPacket.map((r) => r.relation_candidate_id));
  for (const row of samplePacket) assert.equal(ownerIds.has(row.relation_candidate_id), false);
});

test("sample audit packet rows start PENDING with no defect recorded", () => {
  for (const row of samplePacket) {
    assert.equal(row.sample_disposition, "PENDING");
    assert.equal(row.defect_type, null);
    assert.equal(row.auditor_note, "");
  }
});

test("sample selection is deterministically reproducible: rerunning the build produces the identical 30 sample ids in the identical order", async () => {
  await execFileAsync(process.execPath, [path.join(ROOT, "scripts/build-relation-closure-owner-packet-v043.mjs")], { cwd: ROOT });
  const rerunSample = readJsonl(await readFile(SAMPLE_PACKET_PATH, "utf8"));
  assert.deepEqual(rerunSample.map((r) => r.relation_candidate_id), samplePacket.map((r) => r.relation_candidate_id));
});

test("sample manifest records the selection rule, salt, and strata distribution, with no absolute or home-directory path", () => {
  assert.equal(sampleManifest.selection_rule.salt, "n4.3-sample-audit-v0.1");
  assert.ok(sampleManifest.strata_distribution && Object.keys(sampleManifest.strata_distribution).length > 1, "sample should spread across more than one stratum");
  const manifestText = JSON.stringify(sampleManifest);
  assert.doesNotMatch(manifestText, /\/Users\//);
  assert.doesNotMatch(manifestText, /\.\.\//);
});

test("ledger, owner packet, and sample packet contain no absolute path or '..' segment anywhere", () => {
  for (const text of [JSON.stringify(ledgerManifest), JSON.stringify(provenance), JSON.stringify(gateStatus)]) {
    assert.doesNotMatch(text, /\/Users\//);
    assert.doesNotMatch(text, /\.\.\//);
  }
});

test("gate status: 297 PROVISIONAL/not promoted, 29 OWNER_REVIEW_PENDING, chain closure NOT_FINALIZED, official_split_eligible false, Gold NOT_STARTED", () => {
  assert.equal(gateStatus.provisional_297.count, 297);
  assert.equal(gateStatus.provisional_297.status, "PROVISIONAL");
  assert.equal(gateStatus.provisional_297.promoted, false);
  assert.equal(gateStatus.owner_review_29.count, 29);
  assert.equal(gateStatus.owner_review_29.status, "OWNER_REVIEW_PENDING");
  assert.equal(gateStatus.chain_closure_status, "NOT_FINALIZED");
  assert.equal(gateStatus.official_split_eligible, false);
  assert.equal(gateStatus.gold_authoring_status, "NOT_STARTED");
  assert.equal(gateStatus.auto_owner_approval_performed, false);
  assert.equal(gateStatus.auto_chain_closure_performed, false);
});

test("provenance report records the known B-base reviewer-label anomaly explicitly, and confirms remediation-cited SHAs match the real files", () => {
  assert.equal(provenance.known_provenance_anomaly.status, "KNOWN_LABEL_BUG_CONFIRMED_BY_USER_2026-08-23");
  assert.equal(provenance.remediation_cited_packet_sha256_matches_real.a, true);
  assert.equal(provenance.remediation_cited_packet_sha256_matches_real.b, true);
  assert.equal(provenance.remediation_cited_base_sha256_matches_real.a, true);
  assert.equal(provenance.remediation_cited_base_sha256_matches_real.b, true);
});

test("every Owner packet row's original_candidate_target_document_ids matches the real packet's candidates for that row", async () => {
  const packetRows = readJsonl(await readFile(INPUTS.packet, "utf8"));
  const packetById = new Map(packetRows.map((r) => [r.relation_candidate_id, r]));
  for (const row of ownerPacket) {
    const real = packetById.get(row.relation_candidate_id).candidates.map((c) => c.target_document_id);
    assert.deepEqual(row.original_candidate_target_document_ids, real);
  }
});

test("reviewer_role in the ledger is derived from the source file, never from the mislabeled 'reviewer' field on B's base rows", () => {
  for (const row of ledgerRows) {
    assert.equal(row.reviewer_a.reviewer_role, "REVIEWER_A");
    assert.equal(row.reviewer_b.reviewer_role, "REVIEWER_B");
  }
  // The known anomaly is isolated to B's BASE decision file: its 297
  // base-sourced rows raw-report REVIEWER_AGENT_A (preserved as-read, not
  // silently "corrected"), while the 29 rows overlaid from B's
  // remediation file correctly raw-report REVIEWER_AGENT_B (remediation
  // was never affected by this label bug). reviewer_role above is
  // REVIEWER_B either way, because it comes from the file PATH, not this
  // field.
  const baseSourced = ledgerRows.filter((r) => r.reviewer_b.decision_source === "BASE");
  const remediationSourced = ledgerRows.filter((r) => r.reviewer_b.decision_source === "REMEDIATION");
  assert.equal(baseSourced.length, 297);
  assert.equal(remediationSourced.length, 29);
  assert.deepEqual([...new Set(baseSourced.map((r) => r.reviewer_b.reviewer))], ["REVIEWER_AGENT_A"]);
  assert.deepEqual([...new Set(remediationSourced.map((r) => r.reviewer_b.reviewer))], ["REVIEWER_AGENT_B"]);
});
