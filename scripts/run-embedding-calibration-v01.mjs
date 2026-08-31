#!/usr/bin/env node
// Turn P9: FAKE_DETERMINISTIC-only calibration smoke driver. This script
// NEVER reads an arbitrary set of environment variables and never performs
// a real network call -- it hardcodes adapter_kind=FAKE_DETERMINISTIC for
// its own default run (a real provider run is a DIFFERENT CalibrationConfig
// the OWNER constructs explicitly, with actual_external_call_authorized
// set to true and a real api_key_env_var NAME -- this script does not do
// that on anyone's behalf).
//
// Reads ONLY VERIFIED Evidence/Fact from the already-approved v0.20-r3
// bundle (read-only, materialize-then-cleanup -- see dataset.mjs). Writes
// its four output documents under the gitignored work/ directory, never
// under domain/ or any tracked path.
import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import {
  collectVerifiedCalibrationCandidates, selectCalibrationDataset, buildCalibrationDatasetManifest,
} from "../domain/agent-comparison/embedding-calibration/dataset.mjs";
import { runEmbeddingCalibration } from "../domain/agent-comparison/embedding-calibration/runner.mjs";
import {
  buildCalibrationRunManifest, buildCalibrationGateStatus, buildRequiredOwnerInputsChecklist,
} from "../domain/agent-comparison/embedding-calibration/report.mjs";
import { validateCalibrationConfig } from "../domain/agent-comparison/embedding-calibration/contracts.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const OUT_DIR = path.join(ROOT, "work", "embedding-calibration-v0.1");

const BUNDLE_OPTIONS = Object.freeze({
  root: ROOT,
  bundleDir: path.join(ROOT, "domain/releases/bundles/seed-release-v0.20-r3.candidate"),
  bundleManifestPath: path.join(ROOT, "domain/releases/bundles/seed-release-v0.20-r3.candidate/bundle-manifest.json"),
  finalManifestPath: path.join(ROOT, "domain/releases/seed-release.v0.20.manifest.json"),
  finalDecisionPath: path.join(ROOT, "domain/releases/seed-release.v0.20.decision.json"),
  expectedReleaseId: "seed-release-v0.20",
});

async function main() {
  console.error("[calibration] collecting VERIFIED Evidence/Fact candidates from the v0.20-r3 bundle (read-only, temp-materialized, auto-cleaned)...");
  const candidates = await collectVerifiedCalibrationCandidates(BUNDLE_OPTIONS);
  console.error(`[calibration] ${candidates.length} candidate(s) with a resolvable fact_id + corp_code`);

  const sampleSalt = "turn-p9-fake-smoke-v01";
  const maximumItemCount = Math.min(200, candidates.length);
  const datasetItems = selectCalibrationDataset({ candidates, maximumItemCount, sampleSalt });
  const datasetManifest = buildCalibrationDatasetManifest({
    datasetId: "calibration_dataset_fake_smoke_v01", sampleSalt, datasetItems, candidatePoolSize: candidates.length,
  });
  console.error(`[calibration] dataset: ${datasetManifest.item_count} item(s), sha256=${datasetManifest.calibration_dataset_sha256}`);

  const calibrationConfig = {
    schema_version: "0.1.0",
    calibration_id: "calibration_fake_deterministic_smoke_v01",
    adapter_kind: "FAKE_DETERMINISTIC",
    provider_id: "test-fixture",
    model_id: "deterministic-fake-embedding-v1",
    endpoint: "unused-for-fake-deterministic",
    expected_dimension: 16,
    batch_size: 20,
    request_timeout_ms: 30000,
    maximum_item_count: 200,
    maximum_request_count: 20,
    maximum_total_input_units: 500000,
    sample_salt: sampleSalt,
    dataset_manifest_sha256: datasetManifest.calibration_dataset_sha256,
    code_revision: "turn-p9",
    cache_policy: { enabled: true },
    retry_policy: { max_attempts_per_request: 1, retryable_error_codes: [], backoff_ms: 0 },
    input_price_per_million_units: null,
    actual_external_call_authorized: false,
  };
  const configErrors = validateCalibrationConfig(calibrationConfig);
  if (configErrors.length > 0) throw new Error(`invalid CalibrationConfig: ${configErrors.join("; ")}`);

  console.error("[calibration] running FAKE_DETERMINISTIC smoke (zero network calls)...");
  const result = await runEmbeddingCalibration({ calibrationConfig, datasetItems });
  console.error(`[calibration] run_status=${result.run_status} recall@1=${result.quality?.self_match_recall_at_1} mrr=${result.quality?.mrr}`);

  const runManifest = buildCalibrationRunManifest({ calibrationConfig, datasetManifest, codeRevision: "turn-p9" });
  const gateStatus = buildCalibrationGateStatus({ runResult: result });

  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(path.join(OUT_DIR, "calibration-run-manifest.v0.1.json"), JSON.stringify(runManifest, null, 2));
  await writeFile(path.join(OUT_DIR, "calibration-dataset-manifest.v0.1.json"), JSON.stringify(datasetManifest, null, 2));
  await writeFile(path.join(OUT_DIR, "calibration-result.v0.1.json"), JSON.stringify(result, null, 2));
  await writeFile(path.join(OUT_DIR, "calibration-gate-status.v0.1.json"), JSON.stringify(gateStatus, null, 2));
  console.error(`[calibration] wrote 4 output documents under ${OUT_DIR}`);
  console.error(`[calibration] gate: ${gateStatus.gate}`);
  console.error("[calibration] REAL_EMBEDDING_FULL_LOAD_NOT_STARTED -- no real provider/model was configured or called this run.");
  console.error("[calibration] required owner inputs for a REAL run:");
  for (const field of buildRequiredOwnerInputsChecklist()) console.error(`  - ${field}`);
}

main().catch((error) => {
  console.error(`[calibration] FAILED: ${error.stack ?? error.message}`);
  process.exit(1);
});
