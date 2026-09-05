// Turn AC-OFFICIAL-INTEGRATION-V1 / FOURARM-INTEGRATION-OWNER-DECISION-AND-
// EXECUTION-GATE: assembles ONE combined preflight manifest for all four
// arms (A/B/C/D) -- code/config/input/index/results SHAs, the shared
// cutoff contract, the Owner's ratified B/D hard-gate outcome (recorded,
// never relaxed), and TWO separately reported readiness verdicts:
//
//   official_batch_execution_ready -- can this batch run at all (every
//     arm's identity/pins verified, ledger complete, Owner resolutions
//     artifact verified)? Independent of whether any arm passes its own
//     hard safety gate -- a hard-gate-failed arm does not block OTHER
//     arms from executing, it only excludes itself from selection.
//
//   final_selection_ready -- can a winner be picked yet? False until
//     every arm in the batch has a FINAL (non-pending) hard-gate
//     evaluation, i.e. until A/C have actually executed and been
//     evaluated. B/D's hard-gate state is already final (from frozen,
//     Owner-ratified results) the moment their Owner resolutions artifact
//     is verified -- it does not wait on A/C.
//
// This module NEVER runs an evaluation itself (no HCX calls, no retrieval
// calls, no scoring) -- it only aggregates already-computed identity/
// readiness facts into one report. scripts/p11f0-fourarm-preflight.mjs is
// the thin CLI wrapper that gathers the real inputs (live DB readiness,
// real file hashes, the imported Owner resolutions artifact) and calls
// this.
import { assertSingleCompleteBatch, validateLedgerEntry } from "./four-arm-run-ledger.mjs";
import { RETRIEVAL_OUTPUT_K, PRIMARY_EVALUATION_K, REPORTED_CUTOFFS } from "./four-arm-cutoff-contract.mjs";
import { deriveHardGateFromOwnerResolutions } from "./four-arm-owner-resolutions-importer.mjs";
import { deriveArmSelectionState, selectWinner } from "./four-arm-winner-selection.mjs";

// armReadiness: the real, live createArmRetrieverAdapter(...).readiness()
// output for arm A or C (see scripts/p11f0-fourarm-preflight.mjs).
// executionState/qualityMetrics default to "not executed yet" -- once a
// real DEV_TUNE-101 run exists for an arm, the caller passes
// executionState:"EXECUTED" and qualityMetrics so this same function can
// build its final (non-pending) ledger/selection state.
function armLedgerEntryFromReadiness({
  arm, readiness, batchId, codeHeadSha256, configSha256, conditionsSha256, universeSha256,
  corpusManifestSha256, indexSha256, executionState = "NOT_EXECUTED_PENDING_DEVTUNE",
  resultsSha256 = null, qualityMetrics = null,
}) {
  const blockers = [];
  if (!readiness.official_experiment_ready) blockers.push(`ARM_${arm}_INFRA_NOT_OFFICIAL_EXPERIMENT_READY: ${JSON.stringify(readiness.reasons)}`);
  const entry = Object.freeze({
    arm,
    role: "AC_LIVE",
    batch_id: batchId,
    status: executionState,
    code_sha256: codeHeadSha256,
    config_sha256: configSha256,
    input_sha256: Object.freeze({
      conditions: conditionsSha256,
      universe: universeSha256,
      corpus_manifest: corpusManifestSha256,
    }),
    index_sha256: indexSha256,
    results_sha256: resultsSha256,
    infra_readiness: readiness,
  });
  validateLedgerEntry(entry);
  // Hard gate for A/C cannot be evaluated before real execution -- there
  // is no quality-gate input yet, and readiness()==true only means the
  // INFRASTRUCTURE is ready, not that any evaluation has happened. Once a
  // real run exists, the caller supplies qualityMetrics.hard_gate_state
  // (computed by whatever applies vFINAL's hard/quality gate to the real
  // results -- not this module's job).
  const hardGateState = executionState === "EXECUTED" ? (qualityMetrics?.hard_gate_state ?? "HARD_GATE_PENDING_EXECUTION") : "HARD_GATE_PENDING_EXECUTION";
  return { entry, blockers, hardGateState, qualityMetrics };
}

// bdRunJson: the imported B.run.json/D.run.json content (already read from
// disk by the caller). bdResultsSha256: from official/IMPORT_MANIFEST.json
// (already SHA-verified at import time). hardGate: the Owner-ratified,
// already-final hard-gate outcome (deriveHardGateFromOwnerResolutions) --
// B and D share the exact same two critical packets, so the same object
// applies to both.
function bdLedgerEntryFromImport({ arm, batchId, runJson, resultsSha256, conditionsSha256, universeSha256 }) {
  const entry = Object.freeze({
    arm,
    role: "BD_IMPORTED_REFERENCE",
    batch_id: batchId,
    status: "REUSED_VERIFIED",
    code_sha256: runJson.code_sha256,
    config_sha256: runJson.config_sha256,
    input_sha256: Object.freeze({
      conditions: runJson.input_sha256.conditions,
      universe: runJson.input_sha256.universe,
      document_ir_manifest: runJson.input_sha256.manifest,
    }),
    index_sha256: null,
    results_sha256: resultsSha256,
  });
  validateLedgerEntry(entry);
  const pinMismatches = [];
  if (runJson.input_sha256.conditions !== conditionsSha256) pinMismatches.push(`ARM_${arm}_CONDITIONS_PIN_MISMATCH`);
  if (runJson.input_sha256.universe !== universeSha256) pinMismatches.push(`ARM_${arm}_UNIVERSE_PIN_MISMATCH`);
  return { entry, blockers: pinMismatches };
}

export function assembleFourArmPreflightManifest({
  batchId,
  conditionsValidation, universeValidation, ownerResolutionsValidation,
  armA, armC, // { readiness, codeHeadSha256, configSha256, corpusManifestSha256, indexSha256, executionState?, resultsSha256?, qualityMetrics? }
  armBRunJson, armDRunJson, armBResultsSha256, armDResultsSha256,
}) {
  const blockers = [];

  const conditionsOk = Boolean(conditionsValidation?.official_execution_ready) && typeof conditionsValidation?.file_sha256 === "string";
  const universeOk = Boolean(universeValidation?.official_execution_ready) && typeof universeValidation?.file_sha256 === "string";
  const ownerResolutionsOk = Boolean(ownerResolutionsValidation?.official_execution_ready);
  if (!conditionsOk) blockers.push("CONDITIONS_ARTIFACT_NOT_VERIFIED");
  if (!universeOk) blockers.push("UNIVERSE_ARTIFACT_NOT_VERIFIED");
  if (!ownerResolutionsOk) blockers.push("OWNER_RESOLUTIONS_ARTIFACT_NOT_VERIFIED");

  // Ledger entries embed the conditions/universe SHAs as part of each arm's
  // own input_sha256 -- an unverified artifact has no trustworthy SHA to
  // embed, so no entry is even attempted (fail closed) rather than
  // fabricating a null/placeholder hash.
  const entries = [];
  const armStates = [];
  if (conditionsOk && universeOk && ownerResolutionsOk) {
    const bdHardGate = deriveHardGateFromOwnerResolutions(ownerResolutionsValidation);

    const acBuilders = [
      ["A", armA], ["C", armC],
    ].map(([arm, cfg]) => () => {
      const built = armLedgerEntryFromReadiness({
        arm, batchId, readiness: cfg.readiness, codeHeadSha256: cfg.codeHeadSha256,
        configSha256: cfg.configSha256, conditionsSha256: conditionsValidation.file_sha256,
        universeSha256: universeValidation.file_sha256, corpusManifestSha256: cfg.corpusManifestSha256,
        indexSha256: cfg.indexSha256, executionState: cfg.executionState, resultsSha256: cfg.resultsSha256,
        qualityMetrics: cfg.qualityMetrics,
      });
      const selection = deriveArmSelectionState({
        arm, executionState: built.entry.status, hardGateState: built.hardGateState,
      });
      return { ...built, selection, qualityMetrics: cfg.qualityMetrics };
    });

    const bdBuilders = [
      ["B", armBRunJson, armBResultsSha256], ["D", armDRunJson, armDResultsSha256],
    ].map(([arm, runJson, resultsSha256]) => () => {
      const built = bdLedgerEntryFromImport({
        arm, batchId, runJson, resultsSha256,
        conditionsSha256: conditionsValidation.file_sha256, universeSha256: universeValidation.file_sha256,
      });
      const selection = deriveArmSelectionState({
        arm, executionState: "REUSED_VERIFIED", hardGateState: bdHardGate.hard_gate_state,
        failureReason: bdHardGate.failure_reason,
      });
      return { ...built, selection, qualityMetrics: null, bdHardGate };
    });

    for (const build of [...acBuilders, ...bdBuilders]) {
      try {
        const result = build();
        blockers.push(...result.blockers);
        entries.push(result.entry);
        armStates.push(Object.freeze({ ...result.selection, quality_metrics: result.qualityMetrics ?? null }));
      } catch (error) {
        blockers.push(`RUN_LEDGER_ENTRY_CONSTRUCTION_FAILED: ${error.message}`);
      }
    }
  }

  let batch = null;
  if (entries.length > 0) {
    try {
      batch = assertSingleCompleteBatch(entries);
    } catch (error) {
      blockers.push(`RUN_LEDGER_BATCH_INVALID: ${error.message}`);
      batch = null;
    }
  }

  // official_batch_execution_ready is deliberately NOT gated on any arm's
  // hard-gate outcome -- a batch where B/D are already known hard-gate-
  // failed is still a batch A/C can (and per section E, should) execute
  // in. It IS gated on the batch being structurally complete/verified.
  const officialBatchExecutionReady = blockers.length === 0 && batch !== null;

  let selectionResult = null;
  let finalSelectionReady = false;
  if (armStates.length === 4) {
    selectionResult = selectWinner(armStates);
    finalSelectionReady = selectionResult.status !== "EXECUTION_PENDING";
  }

  return Object.freeze({
    schema_version: "0.2.0",
    turn: "FOURARM-INTEGRATION-OWNER-DECISION-AND-EXECUTION-GATE",
    batch_id: batchId,
    cutoff_contract: Object.freeze({
      retrieval_output_k: RETRIEVAL_OUTPUT_K,
      primary_evaluation_k: PRIMARY_EVALUATION_K,
      reported_cutoffs: REPORTED_CUTOFFS,
    }),
    conditions_artifact: conditionsValidation,
    universe_artifact: universeValidation,
    owner_resolutions_artifact: ownerResolutionsValidation,
    ledger: Object.freeze({ batch, entries: Object.freeze(entries) }),
    arm_states: Object.freeze(armStates),
    official_batch_execution_ready: officialBatchExecutionReady,
    final_selection_ready: finalSelectionReady,
    selection: selectionResult,
    blockers: Object.freeze(blockers.filter(Boolean)),
    dev_tune_executed: false,
    dev_check_holdout_accessed: false,
    production_wiring_performed: false,
  });
}
