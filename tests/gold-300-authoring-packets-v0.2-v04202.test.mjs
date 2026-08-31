// Turn N4.20.2: regression coverage for the AUTHORIZED v0.2 authoring
// packets, built only after a real Owner decision has been ingested and
// verified. Confirms row-level authoring_status matches the plan-vs-row
// authorization separation, per-author counts match the real recorded
// decision exactly, HOLDOUT rows never carry an implicit Agent-access
// grant, and the v0.1 packets remain byte-unmodified.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { verifyAndRecordGold300OwnerDecisionV02, REAL_DECISION_PATH } from "../scripts/build-gold-300-owner-decision-v0.2-verification-v04202.mjs";
import { buildGold300AuthoringPacketsV02 } from "../scripts/build-gold-300-authoring-packets-v0.2-v04202.mjs";

const REPO_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
function readJsonl(p) { return readFileSync(p, "utf8").trim().split("\n").map((l) => JSON.parse(l)); }
function readJson(p) { return JSON.parse(readFileSync(p, "utf8")); }
function sha256(buf) { return createHash("sha256").update(buf).digest("hex"); }

// This suite requires the real decision to already be recorded as
// genuinely authorized (Turn N4.20.2's verification test suite guarantees
// this by the time test:domain reaches this file in a full run; a
// standalone run of just this file re-verifies it here too).
test.before(() => { verifyAndRecordGold300OwnerDecisionV02(); });

test("buildGold300AuthoringPacketsV02: refuses to run if the recorded gate status does not show a genuinely authorized plan", () => {
  const realBytes = readFileSync(REAL_DECISION_PATH);
  const tampered = JSON.parse(realBytes.toString("utf8"));
  tampered.blocked_authoring_authorized = true; // makes the decision fail domain verification -> not recorded as authorized
  try {
    writeFileSync(REAL_DECISION_PATH, `${JSON.stringify(tampered, null, 2)}\n`);
    verifyAndRecordGold300OwnerDecisionV02();
    assert.throws(() => buildGold300AuthoringPacketsV02(), /real_decision_verified|plan is not authorized|refusing to mark/);
  } finally {
    writeFileSync(REAL_DECISION_PATH, realBytes);
    verifyAndRecordGold300OwnerDecisionV02();
  }
});

test("buildGold300AuthoringPacketsV02: real recorded decision -- per-author AUTHORING_ALLOWED/MANUAL_REVIEW/BLOCKED counts match the decision exactly (A: 120/9/21, B: 87/3/60)", () => {
  const result = buildGold300AuthoringPacketsV02();
  assert.deepEqual(result.countsA, { AUTHORING_ALLOWED_AFTER_OWNER_APPROVAL: 120, MANUAL_REVIEW_REQUIRED_BEFORE_AUTHORING: 9, AUTHORING_BLOCKED: 21 });
  assert.deepEqual(result.countsB, { AUTHORING_ALLOWED_AFTER_OWNER_APPROVAL: 87, MANUAL_REVIEW_REQUIRED_BEFORE_AUTHORING: 3, AUTHORING_BLOCKED: 60 });
});

test("buildGold300AuthoringPacketsV02: never modifies the real v0.1 packets", () => {
  const paths = [
    "work/handoff/anchor-dev-tune-v0.2/gold-authoring-300-v0.1/author-a-gold-150-authoring-packet.v0.1.jsonl",
    "work/handoff/anchor-dev-tune-v0.2/gold-authoring-300-v0.1/author-b-gold-150-authoring-packet.v0.1.jsonl",
  ].map((p) => resolve(REPO_ROOT, p));
  const before = paths.map((p) => sha256(readFileSync(p)));
  buildGold300AuthoringPacketsV02();
  const after = paths.map((p) => sha256(readFileSync(p)));
  assert.deepEqual(after, before);
  const manifest = readJson(resolve(REPO_ROOT, "work/handoff/anchor-dev-tune-v0.2/gold-authoring-300-v0.2/gold-authoring-300-packet-manifest.v0.2.json"));
  assert.equal(manifest.v01_packets_unmodified.author_a, true);
  assert.equal(manifest.v01_packets_unmodified.author_b, true);
});

test("buildGold300AuthoringPacketsV02: every row's agent_access_to_this_row_authorized is false, including HOLDOUT-split rows -- authoring_status never implies Agent access", () => {
  const result = buildGold300AuthoringPacketsV02();
  const rowsA = readJsonl(result.pathA);
  const rowsB = readJsonl(result.pathB);
  const allRows = [...rowsA, ...rowsB];
  assert.ok(allRows.some((r) => r.provisional_split === "HOLDOUT"), "sanity: this real plan does include HOLDOUT rows");
  for (const row of allRows) {
    assert.equal(row.agent_access_to_this_row_authorized, false, `${row.assignment_id} must never carry agent access`);
  }
  const holdoutRows = allRows.filter((r) => r.provisional_split === "HOLDOUT");
  for (const row of holdoutRows) {
    assert.equal(row.agent_access_to_this_row_authorized, false, `HOLDOUT row ${row.assignment_id} must never carry agent access even if AUTHORING_ALLOWED`);
  }
});

test("buildGold300AuthoringPacketsV02: no question/expected_answer/citation content is ever generated -- every row stays NOT_AUTHORED regardless of authoring_status", () => {
  const result = buildGold300AuthoringPacketsV02();
  const allRows = [...readJsonl(result.pathA), ...readJsonl(result.pathB)];
  for (const row of allRows) {
    assert.equal(row.question_status, "NOT_AUTHORED");
    assert.equal(row.expected_answer_status, "NOT_AUTHORED");
    assert.equal(row.citation_status, "NOT_AUTHORED");
    assert.equal(row.question, null);
    assert.equal(row.expected_answer, null);
    assert.deepEqual(row.evidence_citations, []);
  }
});

test("buildGold300AuthoringPacketsV02: row-level authoring_status matches the ELIGIBILITY-to-STATUS mapping exactly for at least one row of each category", () => {
  const result = buildGold300AuthoringPacketsV02();
  const allRows = [...readJsonl(result.pathA), ...readJsonl(result.pathB)];
  const byEligibility = {};
  for (const row of allRows) byEligibility[row.authoring_eligibility] = row;
  assert.equal(byEligibility.ELIGIBLE_DOCUMENT_LOCAL.authoring_status, "AUTHORING_ALLOWED_AFTER_OWNER_APPROVAL");
  assert.equal(byEligibility.ELIGIBLE_VERIFIED_RELATION.authoring_status, "AUTHORING_ALLOWED_AFTER_OWNER_APPROVAL");
  assert.equal(byEligibility.NEEDS_MANUAL_SOURCE_REVIEW.authoring_status, "MANUAL_REVIEW_REQUIRED_BEFORE_AUTHORING");
  assert.equal(byEligibility.BLOCKED_PROVISIONAL_RELATION.authoring_status, "AUTHORING_BLOCKED");
  assert.equal(byEligibility.BLOCKED_PARSE_FAILED.authoring_status, "AUTHORING_BLOCKED");
});

test("buildGold300AuthoringPacketsV02: the packet manifest explicitly documents holdout_agent_access_authorized/holdout_evaluation_authorized as false", () => {
  buildGold300AuthoringPacketsV02();
  const manifest = readJson(resolve(REPO_ROOT, "work/handoff/anchor-dev-tune-v0.2/gold-authoring-300-v0.2/gold-authoring-300-packet-manifest.v0.2.json"));
  assert.equal(manifest.holdout_authoring_vs_agent_access.holdout_agent_access_authorized, false);
  assert.equal(manifest.holdout_authoring_vs_agent_access.holdout_evaluation_authorized, false);
});

// -- Turn N4.22 Part D: packet provenance re-verification -----------------

test("Turn N4.22: the packet manifest records active_decision_pin_matched=true against the real recorded decision, with source_decision_id/sha256 exactly matching decision_id 93c5b69c... and SHA db5ea49b...", () => {
  buildGold300AuthoringPacketsV02();
  const manifest = readJson(resolve(REPO_ROOT, "work/handoff/anchor-dev-tune-v0.2/gold-authoring-300-v0.2/gold-authoring-300-packet-manifest.v0.2.json"));
  assert.equal(manifest.source_decision_id, "93c5b69c-6e37-46fd-b319-17179a0d6402");
  assert.equal(manifest.source_decision_sha256, "db5ea49b9b4e29c1076cbcc26f5002a8060b4004a50730e2a184fac2324ab13e");
  assert.equal(manifest.active_decision_pin_matched, true);
});

test("Turn N4.22: buildGold300AuthoringPacketsV02 refuses to run when the recorded decision's decision_id/SHA does not match the pinned active decision, even if the gate's own real_decision_verified/gold_300_plan_authorized somehow still read true", () => {
  const realBytes = readFileSync(REAL_DECISION_PATH);
  const tampered = JSON.parse(realBytes.toString("utf8"));
  tampered.decision_id = "e266789a-5263-4015-9dc1-7fa8e6eb36c2";
  try {
    // Ensure the gate file itself is genuinely up to date (in practice this
    // tamper also fails verifyAndRecordGold300OwnerDecisionV02 and the gate
    // would already read false -- this test targets the packet builder's
    // OWN independent pin re-check as defense in depth, not just the gate).
    writeFileSync(REAL_DECISION_PATH, `${JSON.stringify(tampered, null, 2)}\n`);
    assert.throws(() => buildGold300AuthoringPacketsV02(), /does not match the pinned active decision|plan is not authorized|real_decision_verified/);
  } finally {
    writeFileSync(REAL_DECISION_PATH, realBytes);
    verifyAndRecordGold300OwnerDecisionV02();
  }
});

test("Turn N4.22 Part E.10: buildGold300AuthoringPacketsV02's CLI stdout never includes the Owner's name or any row/assignment content -- only status, counts, and booleans", () => {
  const scriptPath = resolve(REPO_ROOT, "scripts/build-gold-300-authoring-packets-v0.2-v04202.mjs");
  const stdout = execFileSync("node", [scriptPath], { cwd: REPO_ROOT, encoding: "utf8" });
  assert.doesNotMatch(stdout, /최재완/, "the real Owner's name must never appear in CLI output");
  assert.doesNotMatch(stdout, /assignment_id/);
  assert.doesNotMatch(stdout, /"question"|"expected_answer"|"evidence_citations"/);
  const parsed = JSON.parse(stdout);
  assert.equal(parsed.status, "V02_AUTHORIZED_PACKETS_BUILT");
});
