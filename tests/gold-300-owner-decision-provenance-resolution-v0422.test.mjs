// Turn N4.22 Part B/E: regression coverage for the provenance-resolution
// artifact that names both the superseded chat-reconstructed decision and
// the active file-verified decision side by side. Also covers Part E.10
// (no Gold/HOLDOUT/Owner content leaks into this script's CLI stdout).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { buildGold300OwnerDecisionProvenanceResolution, PROVENANCE_RESOLUTION_PATH } from "../scripts/build-gold-300-owner-decision-provenance-resolution-v0422.mjs";
import { verifyAndRecordGold300OwnerDecisionV02 } from "../scripts/build-gold-300-owner-decision-v0.2-verification-v04202.mjs";

const REPO_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
function readJson(p) { return JSON.parse(readFileSync(p, "utf8")); }

test.before(() => { verifyAndRecordGold300OwnerDecisionV02(); });

test("buildGold300OwnerDecisionProvenanceResolution: lists exactly the two known decisions, with the untrusted one marked not usable for authorization", () => {
  const result = buildGold300OwnerDecisionProvenanceResolution();
  const ids = result.resolution.decisions.map((d) => d.decision_id).sort();
  assert.deepEqual(ids, ["93c5b69c-6e37-46fd-b319-17179a0d6402", "e266789a-5263-4015-9dc1-7fa8e6eb36c2"].sort());
  const untrusted = result.resolution.decisions.find((d) => d.decision_id === "e266789a-5263-4015-9dc1-7fa8e6eb36c2");
  assert.equal(untrusted.status, "SUPERSEDED_UNTRUSTED_CHAT_RECONSTRUCTION");
  assert.equal(untrusted.usable_for_authoring_authorization, false);
  const active = result.resolution.decisions.find((d) => d.decision_id === "93c5b69c-6e37-46fd-b319-17179a0d6402");
  assert.equal(active.status, "ACTIVE_FILE_VERIFIED_OWNER_DECISION");
  assert.equal(active.usable_for_authoring_authorization, true);
  assert.equal(active.sha256, "db5ea49b9b4e29c1076cbcc26f5002a8060b4004a50730e2a184fac2324ab13e");
});

test("buildGold300OwnerDecisionProvenanceResolution: canonical_active_decision_id/sha256 match the pin exactly, and the live cross-check confirms it", () => {
  const result = buildGold300OwnerDecisionProvenanceResolution();
  assert.equal(result.resolution.canonical_active_decision_id, "93c5b69c-6e37-46fd-b319-17179a0d6402");
  assert.equal(result.resolution.canonical_active_decision_sha256, "db5ea49b9b4e29c1076cbcc26f5002a8060b4004a50730e2a184fac2324ab13e");
  assert.equal(result.resolution.live_verification_cross_check.matches_pin, true);
  assert.equal(result.resolution.live_verification_cross_check.all_checks_passed, true);
});

test("buildGold300OwnerDecisionProvenanceResolution: names the historical untrusted commit and confirms it is reachable (git history was not rewritten)", () => {
  const result = buildGold300OwnerDecisionProvenanceResolution();
  assert.equal(result.resolution.untrusted_decision_never_deleted_evidence.historical_commit_sha, "512799f27806d287dd0add0043872d34213885e8");
  assert.equal(result.resolution.untrusted_decision_never_deleted_evidence.historical_commit_reachable, true);
});

test("the written artifact on disk matches the returned resolution exactly", () => {
  const result = buildGold300OwnerDecisionProvenanceResolution();
  const onDisk = readJson(PROVENANCE_RESOLUTION_PATH);
  assert.deepEqual(onDisk, result.resolution);
});

test("superseded_decisions_usable_for_authorization is unconditionally false", () => {
  const result = buildGold300OwnerDecisionProvenanceResolution();
  assert.equal(result.resolution.superseded_decisions_usable_for_authorization, false);
});

test("Part E.10: the CLI's stdout never includes the Owner's name, any owner_note, or any row/assignment content -- only ids, statuses, and booleans", () => {
  const scriptPath = resolve(REPO_ROOT, "scripts/build-gold-300-owner-decision-provenance-resolution-v0422.mjs");
  const stdout = execFileSync("node", [scriptPath], { cwd: REPO_ROOT, encoding: "utf8" });
  assert.doesNotMatch(stdout, /최재완/, "the real Owner's name must never appear in CLI output");
  assert.doesNotMatch(stdout, /assignment_id/);
  assert.doesNotMatch(stdout, /question|expected_answer|evidence_citations/);
  const parsed = JSON.parse(stdout);
  assert.equal(parsed.status, "PROVENANCE_RESOLUTION_WRITTEN");
});
