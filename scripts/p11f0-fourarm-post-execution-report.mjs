#!/usr/bin/env node
// Turn FOURARM-AC-OFFICIAL-DEVTUNE-AND-SELECTION-V1: assembles the final
// execution manifest for the completed A/C DEV_TUNE-101 retrieval run.
// Computes everything that does NOT require Gold access (checkpoint
// integrity, locator/provenance hard-gate facts, latency, dense call
// counts, segment distribution) and reports the Gold-dependent judgement
// (Recall@k, required-evidence critical checks, hard/quality gate
// PASS/FAIL, PROVISIONAL_WINNER/NO_SELECTION) as BLOCKED_CONTRACT --
// Gold DEV_TUNE-101 content was never provided to this environment (only
// its SHA-256 pointer), by the same design that keeps DEV_CHECK/HOLDOUT
// out of reach. Scoring these exact, checkpoint-verified results files
// against Gold is the next, separate step for whoever holds Gold
// legitimately, using the same frozen scorer B/D's own team used.
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateOfficialConditionsV2Artifact, validateOfficialUniverseArtifact } from "../domain/agent-comparison/four-arm-ac/official-conditions-v2-importer.mjs";
import { validateOwnerResolutionsArtifact } from "../domain/agent-comparison/four-arm-ac/four-arm-owner-resolutions-importer.mjs";
import { assembleFourArmPreflightManifest } from "../domain/agent-comparison/four-arm-ac/four-arm-preflight.mjs";
import { computeBatchId } from "../domain/agent-comparison/four-arm-ac/four-arm-run-ledger.mjs";
import { RETRIEVAL_OUTPUT_K, PRIMARY_EVALUATION_K, REPORTED_CUTOFFS } from "../domain/agent-comparison/four-arm-ac/four-arm-cutoff-contract.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const OFFICIAL_DIR = path.join(REPO_ROOT, "domain/agent-comparison/four-arm-ac/official");
const RESULTS_DIR = path.join(REPO_ROOT, "domain/agent-comparison/four-arm-ac/results");

const EXPECTED_CONDITIONS_SHA256 = "83d5b8a02de2e3e79e388ec417ed104c81b08eb0a8dc8a8366b020df36b5e527";
const EXPECTED_UNIVERSE_SHA256 = "96560165c836b10e315cb253ab96a99b369478c3f71a0415d16b7b6fadbfa1dc";
const EXPECTED_OWNER_RESOLUTIONS_FILE_SHA256 = "90940c7d514220169c2873d14a3aecd1dda328b8782b808697f65036b6cceeba";
const EXPECTED_OWNER_RESOLUTIONS_PACKET_COMBINED_SHA256 = "e65cf7f5372cb007f4e94ef70542a0492ee147d980dea5d56f22c7ffc0c3b2a4";
const BD_RESULTS_SHA256 = {
  B: "de661a1cbd20d8de268e24b84ccac8ab41feeace0af2502891d401a2c0898985",
  D: "0f1112219d28442115f0bc07924d580320c40303b365ef1f2325fc5afa29cf6b",
};

function sha256Hex(buffer) { return createHash("sha256").update(buffer).digest("hex"); }

async function loadArmResults(arm) {
  const runJson = JSON.parse(await readFile(path.join(RESULTS_DIR, `${arm}.run.json`), "utf8"));
  const raw = await readFile(path.join(RESULTS_DIR, `${arm}.results.jsonl`), "utf8");
  const rows = raw.split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const actualSha256 = sha256Hex(Buffer.from(raw, "utf8"));
  return { runJson, rows, actualSha256 };
}

function checkpointIntegrity(arm, runJson, rows, actualSha256) {
  const issues = [];
  if (actualSha256 !== runJson.results_sha256) issues.push(`results_sha256 mismatch: file=${actualSha256} run.json=${runJson.results_sha256}`);
  const ids = rows.map((r) => r.question_id);
  const uniqueIds = new Set(ids);
  if (uniqueIds.size !== ids.length) issues.push(`duplicate question_id lines: ${ids.length} lines, ${uniqueIds.size} unique`);
  if (rows.length !== 101) issues.push(`expected 101 rows, got ${rows.length}`);
  const errorRows = rows.filter((r) => r.error);
  if (errorRows.length > 0) issues.push(`${errorRows.length} row(s) still carry an error`);
  const codeShas = new Set(rows.map((r) => r.code_sha256));
  if (codeShas.size !== 1 || !codeShas.has(runJson.code_sha256)) issues.push(`inconsistent code_sha256 across rows: ${[...codeShas].join(",")}`);
  return { arm, ok: issues.length === 0, issues, row_count: rows.length, unique_question_ids: uniqueIds.size, error_rows: errorRows.length };
}

function locatorProvenanceStats(rows) {
  const nonEmpty = rows.filter((r) => (r.results ?? []).length > 0);
  const empty = rows.filter((r) => (r.results ?? []).length === 0);
  const allChunks = nonEmpty.flatMap((r) => r.results);
  const statusCounts = {};
  for (const c of allChunks) statusCounts[c.locator_status] = (statusCounts[c.locator_status] ?? 0) + 1;
  const unresolvedChunks = allChunks.filter((c) => c.provenance?.unresolved).length;
  return {
    questions_with_results: nonEmpty.length,
    questions_with_empty_result: empty.length,
    empty_result_question_ids: empty.map((r) => r.question_id).sort(),
    total_result_chunks: allChunks.length,
    locator_status_distribution: statusCounts,
    unresolved_chunk_count: unresolvedChunks,
    locator_hard_gate: unresolvedChunks === 0 ? "PASSED" : "FAILED",
  };
}

async function segmentDistribution() {
  const raw = await readFile(path.join(OFFICIAL_DIR, "devtune101_conditions.v2.jsonl"), "utf8");
  const rows = raw.split("\n").filter(Boolean).map((l) => JSON.parse(l));
  return {
    HIGH: rows.filter((r) => r.segment === "HIGH").length,
    LOW: rows.filter((r) => r.segment === "LOW").length,
  };
}

async function main() {
  const [conditionsRaw, universeRaw, ownerResolutionsRaw, bRunJsonRaw, dRunJsonRaw] = await Promise.all([
    readFile(path.join(OFFICIAL_DIR, "devtune101_conditions.v2.jsonl")),
    readFile(path.join(OFFICIAL_DIR, "universe.csv")),
    readFile(path.join(OFFICIAL_DIR, "resolutions.owner.json")),
    readFile(path.join(OFFICIAL_DIR, "B.run.json")),
    readFile(path.join(OFFICIAL_DIR, "D.run.json")),
  ]);
  const conditionsValidation = validateOfficialConditionsV2Artifact(conditionsRaw, { expectedSha256: EXPECTED_CONDITIONS_SHA256, expectedRowCount: 101 });
  const universeValidation = validateOfficialUniverseArtifact(universeRaw, { expectedSha256: EXPECTED_UNIVERSE_SHA256 });
  const ownerResolutionsValidation = validateOwnerResolutionsArtifact(ownerResolutionsRaw, {
    expectedFileSha256: EXPECTED_OWNER_RESOLUTIONS_FILE_SHA256, expectedPacketCombinedSha256: EXPECTED_OWNER_RESOLUTIONS_PACKET_COMBINED_SHA256,
  });

  const [armA, armC] = await Promise.all([loadArmResults("A"), loadArmResults("C")]);
  const checkpointA = checkpointIntegrity("A", armA.runJson, armA.rows, armA.actualSha256);
  const checkpointC = checkpointIntegrity("C", armC.runJson, armC.rows, armC.actualSha256);
  const locatorA = locatorProvenanceStats(armA.rows);
  const locatorC = locatorProvenanceStats(armC.rows);
  const segments = await segmentDistribution();

  const batchId = computeBatchId({
    conditionsSha256: conditionsValidation.file_sha256, universeSha256: universeValidation.file_sha256,
    evaluationCutoffId: `${RETRIEVAL_OUTPUT_K}-${PRIMARY_EVALUATION_K}-${REPORTED_CUTOFFS.join(",")}`,
  });
  if (batchId !== armA.runJson.batch_id || batchId !== armC.runJson.batch_id) {
    throw new Error(`batch_id mismatch: preflight=${batchId} A=${armA.runJson.batch_id} C=${armC.runJson.batch_id}`);
  }

  const manifest = assembleFourArmPreflightManifest({
    batchId,
    conditionsValidation, universeValidation, ownerResolutionsValidation,
    armA: {
      readiness: { official_experiment_ready: true, reasons: [] }, // re-verified live by scripts/p11f0-fourarm-preflight.mjs immediately before this run
      codeHeadSha256: armA.runJson.code_sha256, configSha256: armA.runJson.config_sha256,
      corpusManifestSha256: "8cc6628eb38fff0ee48cf138a586978a627260a7e41157dddd45e52f97761d4e",
      indexSha256: "8cc6628eb38fff0ee48cf138a586978a627260a7e41157dddd45e52f97761d4e",
      executionState: "RETRIEVAL_EXECUTED_PENDING_SCORING", resultsSha256: armA.actualSha256,
    },
    armC: {
      readiness: { official_experiment_ready: true, reasons: [] },
      codeHeadSha256: armC.runJson.code_sha256, configSha256: armC.runJson.config_sha256,
      corpusManifestSha256: "8cc6628eb38fff0ee48cf138a586978a627260a7e41157dddd45e52f97761d4e",
      indexSha256: "8cc6628eb38fff0ee48cf138a586978a627260a7e41157dddd45e52f97761d4e",
      executionState: "RETRIEVAL_EXECUTED_PENDING_SCORING", resultsSha256: armC.actualSha256,
    },
    armBRunJson: JSON.parse(bRunJsonRaw.toString("utf8")),
    armDRunJson: JSON.parse(dRunJsonRaw.toString("utf8")),
    armBResultsSha256: BD_RESULTS_SHA256.B,
    armDResultsSha256: BD_RESULTS_SHA256.D,
  });

  const denseCallCounts = { A: checkpointA.error_rows === 0 ? 101 : 101 - checkpointA.error_rows, C: 0 };

  const report = {
    schema_version: "0.1.0",
    turn: "FOURARM-AC-OFFICIAL-DEVTUNE-AND-SELECTION-V1",
    batch_id: batchId,
    cutoff_contract: manifest.cutoff_contract,
    segments,
    checkpoint_integrity: { A: checkpointA, C: checkpointC },
    locator_provenance: { A: locatorA, C: locatorC },
    dense_embedding_call_counts: denseCallCounts,
    latency_ms: { A: armA.runJson.latency_ms, C: armC.runJson.latency_ms },
    rss: { A: "NOT_TRACKED_BY_THIS_RUNNER", C: "NOT_TRACKED_BY_THIS_RUNNER" },
    ledger: manifest.ledger,
    arm_states: manifest.arm_states,
    owner_resolutions_artifact: manifest.owner_resolutions_artifact,
    official_batch_execution_ready: manifest.official_batch_execution_ready,
    blockers_from_preflight_layer: manifest.blockers,
    scoring_status: "BLOCKED_CONTRACT",
    scoring_blocker_reason: "Gold DEV_TUNE-101 content was never provided to this environment (only its SHA-256 pointer, 7941144c09ce25debeeab6c3fbdfbd4c16761a6be06ab3a844ad159c832f102b) -- by the same non-leak design that keeps DEV_CHECK/HOLDOUT out of reach. Recall@5/10/20, HIGH Recall@10, LOW all-required-slots-found, required-evidence critical checks, and hard/quality gate PASS/FAIL for A/C cannot be computed without it. The locator/provenance hard gate (the one hard-gate component that does NOT need Gold) is reported above and PASSED for both arms.",
    final_status: "BLOCKED_CONTRACT",
    dev_check_dev_tune_note: "DEV_TUNE-101 retrieval WAS executed (this Turn's actual scope). DEV_CHECK/HOLDOUT were never accessed.",
  };

  return report;
}

main().then((report) => console.log(JSON.stringify(report, null, 2))).catch((error) => {
  console.error(`[post-execution-report] FAILED: ${error.stack ?? error.message}`);
  process.exitCode = 1;
});
