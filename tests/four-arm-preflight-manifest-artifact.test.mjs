import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateLedgerEntry, assertSingleCompleteBatch } from "../domain/agent-comparison/four-arm-ac/four-arm-run-ledger.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MANIFEST_PATH = path.resolve(__dirname, "../domain/agent-comparison/four-arm-ac/official/four-arm-preflight-manifest.json");

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

test("committed preflight manifest: overall readiness is false, blocked ONLY on the B/D Owner-pending judgement", async () => {
  const manifest = await loadManifest();
  assert.equal(manifest.official_4arm_execution_ready, false);
  assert.ok(manifest.blockers.length > 0);
  assert.ok(manifest.blockers.every((b) => b.startsWith("BD_JUDGEMENT_NOT_HARD_SAFE") || b.startsWith("OWNER_DECISION_PENDING")));
});

test("committed preflight manifest: conditions/universe pins match the literal authoritative SHAs everywhere", async () => {
  const manifest = await loadManifest();
  const expectedConditions = "83d5b8a02de2e3e79e388ec417ed104c81b08eb0a8dc8a8366b020df36b5e527";
  const expectedUniverse = "96560165c836b10e315cb253ab96a99b369478c3f71a0415d16b7b6fadbfa1dc";
  assert.equal(manifest.conditions_artifact.file_sha256, expectedConditions);
  assert.equal(manifest.universe_artifact.file_sha256, expectedUniverse);
  for (const entry of manifest.ledger.entries) {
    assert.equal(entry.input_sha256.conditions, expectedConditions);
    assert.equal(entry.input_sha256.universe, expectedUniverse);
  }
});

test("committed preflight manifest: no evaluation was executed, no DEV_CHECK/HOLDOUT access, no production wiring", async () => {
  const manifest = await loadManifest();
  assert.equal(manifest.dev_tune_executed, false);
  assert.equal(manifest.dev_check_holdout_accessed, false);
  assert.equal(manifest.production_wiring_performed, false);
  for (const entry of manifest.ledger.entries) {
    if (entry.role === "AC_LIVE") assert.equal(entry.status, "NOT_EXECUTED_PENDING_DEVTUNE");
  }
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
  assert.equal(b.results_sha256, importManifest.bd_result_run_files.B_results_jsonl_sha256 ?? importManifest.bd_result_run_files["B.results.jsonl_sha256"]);
  assert.equal(d.results_sha256, importManifest.bd_result_run_files["D.results.jsonl_sha256"]);
});
