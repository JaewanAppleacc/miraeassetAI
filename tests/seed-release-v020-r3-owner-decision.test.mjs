import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DECISION_PATH = "domain/releases/seed-release.v0.20-r3.candidate.owner-decision.approved.json";
const POST_GATE_PATH = "domain/releases/seed-release.v0.20-r3.candidate.RELEASE_GATE_STATUS.v0.2.json";
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const read = (relativePath) => readFile(path.join(ROOT, relativePath));

test("v0.20-r3 Owner decision is a separate APPROVED artifact whose five checklist fields are all true", async () => {
  const decision = JSON.parse((await read(DECISION_PATH)).toString("utf8"));
  assert.equal(decision.status, "APPROVED");
  assert.equal(decision.owner_disposition, "APPROVE");
  assert.equal(decision.reviewer, "최재완");
  assert.equal(Object.keys(decision.checklist).length, 5);
  assert.ok(Object.values(decision.checklist).every((value) => value === true));
  assert.equal(decision.authorization_scope.final_release_manifest_authorized, false);
  assert.equal(decision.authorization_scope.production_runtime_switch_authorized, false);
  assert.equal(decision.authorization_scope.commit_or_push_authorized, false);
});

test("every subject pin in the approved decision matches the real immutable bytes", async () => {
  const decision = JSON.parse((await read(DECISION_PATH)).toString("utf8"));
  for (const subject of [
    decision.supersedes_template,
    { path: decision.subject_release_manifest.path, sha256: decision.subject_release_manifest.raw_sha256 },
    decision.subject_bundle_manifest,
    decision.subject_preapproval_gate_status,
    decision.subject_closure_report,
    decision.subject_owner_review_summary,
  ]) {
    assert.equal(sha256(await read(subject.path)), subject.sha256, subject.path);
  }
});

test("the original template remains PENDING and byte-pinned instead of being edited into an approval", async () => {
  const decision = JSON.parse((await read(DECISION_PATH)).toString("utf8"));
  const templateBytes = await read(decision.supersedes_template.path);
  assert.equal(sha256(templateBytes), decision.supersedes_template.sha256);
  const template = JSON.parse(templateBytes.toString("utf8"));
  assert.equal(template.status, "PENDING");
  assert.equal(template.owner_disposition, "PENDING");
});

test("post-approval gate pins the decision but still blocks release/deployment until clean-clone", async () => {
  const gate = JSON.parse((await read(POST_GATE_PATH)).toString("utf8"));
  assert.equal(gate.owner_decision.sha256, sha256(await read(DECISION_PATH)));
  assert.equal(gate.gates.final_integration_owner_review, "PASS");
  assert.equal(gate.gates.official_clean_clone, "BLOCKED_BY_UNCOMMITTED_SOURCE");
  assert.equal(gate.gates.deployment, "BLOCKED");
  assert.equal(gate.overall, "BLOCKED_BY_UNCOMMITTED_SOURCE");
});
