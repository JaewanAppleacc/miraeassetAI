import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateLedgerEntry, assertSingleCompleteBatch } from "../domain/agent-comparison/four-arm-ac/four-arm-run-ledger.mjs";
import { selectWinner } from "../domain/agent-comparison/four-arm-ac/four-arm-winner-selection.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MANIFEST_PATH = path.resolve(__dirname, "../domain/agent-comparison/four-arm-ac/official/four-arm-preflight-manifest.json");
const OWNER_RESOLUTIONS_SHA = "90940c7d514220169c2873d14a3aecd1dda328b8782b808697f65036b6cceeba";

async function loadManifest() {
  return JSON.parse(await readFile(MANIFEST_PATH, "utf8"));
}

test("committed preflight manifest: every ledger entry is independently schema-valid", async () => {
  const manifest = await loadManifest();
  for (const entry of manifest.ledger.entries) validateLedgerEntry(entry);
});

test("committed preflight manifest: exactly one complete A/B/C/D batch, single batch_id", async () => {
  const manifest = await loadManifest();
  const batch = assertSingleCompleteBatch(manifest.ledger.entries);
  assert.deepEqual(batch.arms, ["A", "B", "C", "D"]);
  assert.equal(batch.batch_id, manifest.batch_id);
});

test("committed preflight manifest: A and C infra are officially experiment-ready", async () => {
  const manifest = await loadManifest();
  const a = manifest.ledger.entries.find((e) => e.arm === "A");
  const c = manifest.ledger.entries.find((e) => e.arm === "C");
  assert.equal(a.infra_readiness.official_experiment_ready, true);
  assert.equal(c.infra_readiness.official_experiment_ready, true);
});

test("committed preflight manifest: official_batch_execution_ready=true with zero blockers", async () => {
  const manifest = await loadManifest();
  assert.equal(manifest.official_batch_execution_ready, true);
  assert.deepEqual(manifest.blockers, []);
});

test("committed preflight manifest: final_selection_ready=false -- A/C have not executed yet", async () => {
  const manifest = await loadManifest();
  assert.equal(manifest.final_selection_ready, false);
  assert.equal(manifest.selection.status, "EXECUTION_PENDING");
  assert.equal(manifest.selection.winner, null);
});

test("committed preflight manifest: B/D are HARD_GATE_FAILED / selection_eligible=false; A/C are pending, not blocked", async () => {
  const manifest = await loadManifest();
  const byArm = Object.fromEntries(manifest.arm_states.map((s) => [s.arm, s]));
  assert.equal(byArm.B.arm_hard_gate_state, "HARD_GATE_FAILED");
  assert.equal(byArm.B.arm_selection_eligible, false);
  assert.equal(byArm.B.failure_reason, "ARM_SPECIFIC_CRITICAL_2");
  assert.equal(byArm.D.arm_hard_gate_state, "HARD_GATE_FAILED");
  assert.equal(byArm.D.arm_selection_eligible, false);
  assert.equal(byArm.A.arm_execution_state, "NOT_EXECUTED_PENDING_DEVTUNE");
  assert.equal(byArm.A.arm_selection_eligible, null);
  assert.equal(byArm.C.arm_execution_state, "NOT_EXECUTED_PENDING_DEVTUNE");
  assert.equal(byArm.C.arm_selection_eligible, null);
});

test("committed preflight manifest: re-running selectWinner over the manifest's own arm_states reproduces EXECUTION_PENDING", async () => {
  const manifest = await loadManifest();
  const result = selectWinner(manifest.arm_states);
  assert.deepEqual(result, manifest.selection);
});

test("committed preflight manifest: conditions/universe/owner-resolutions pins match the literal authoritative SHAs everywhere", async () => {
  const manifest = await loadManifest();
  const expectedConditions = "83d5b8a02de2e3e79e388ec417ed104c81b08eb0a8dc8a8366b020df36b5e527";
  const expectedUniverse = "96560165c836b10e315cb253ab96a99b369478c3f71a0415d16b7b6fadbfa1dc";
  assert.equal(manifest.conditions_artifact.file_sha256, expectedConditions);
  assert.equal(manifest.universe_artifact.file_sha256, expectedUniverse);
  assert.equal(manifest.owner_resolutions_artifact.file_sha256, OWNER_RESOLUTIONS_SHA);
  for (const entry of manifest.ledger.entries) {
    assert.equal(entry.input_sha256.conditions, expectedConditions);
    assert.equal(entry.input_sha256.universe, expectedUniverse);
  }
});

test("committed preflight manifest: owner_resolutions_artifact never carries an adjudicator/email field", async () => {
  const manifest = await loadManifest();
  const serialized = JSON.stringify(manifest.owner_resolutions_artifact);
  assert.equal(serialized.includes("@"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(manifest.owner_resolutions_artifact, "adjudicator"), false);
});

test("committed preflight manifest: 15 UNKNOWN packets remain visible as provisional info, not silently dropped", async () => {
  const manifest = await loadManifest();
  assert.equal(manifest.owner_resolutions_artifact.unknown_packet_ids.length, 15);
  assert.equal(manifest.owner_resolutions_artifact.distribution.UNKNOWN, 15);
  assert.equal(manifest.owner_resolutions_artifact.distribution.critical, 2);
});

test("committed preflight manifest: no evaluation was executed, no DEV_CHECK/HOLDOUT access, no production wiring", async () => {
  const manifest = await loadManifest();
  assert.equal(manifest.dev_tune_executed, false);
  assert.equal(manifest.dev_check_holdout_accessed, false);
  assert.equal(manifest.production_wiring_performed, false);
});

test("committed preflight manifest: B and D results are REUSED_VERIFIED against the SAME imported SHAs recorded in IMPORT_MANIFEST.json", async () => {
  const [manifest, importManifest] = await Promise.all([
    loadManifest(),
    readFile(path.resolve(__dirname, "../domain/agent-comparison/four-arm-ac/official/IMPORT_MANIFEST.json"), "utf8").then(JSON.parse),
  ]);
  const b = manifest.ledger.entries.find((e) => e.arm === "B");
  const d = manifest.ledger.entries.find((e) => e.arm === "D");
  assert.equal(b.status, "REUSED_VERIFIED");
  assert.equal(d.status, "REUSED_VERIFIED");
  assert.equal(b.results_sha256, importManifest.bd_result_run_files["B.results.jsonl_sha256"]);
  assert.equal(d.results_sha256, importManifest.bd_result_run_files["D.results.jsonl_sha256"]);
});
