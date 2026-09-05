// Turn AC-OFFICIAL-INTEGRATION-V1: assembles ONE combined preflight
// manifest for all four arms (A/B/C/D) -- code/config/input/index/results
// SHAs, the shared cutoff contract, the B/D judgement's Owner-pending
// state (recorded, never relaxed), and a final official_4arm_execution_
// ready verdict with an exact blocker list. This module is PURE (no DB/
// file I/O) so it is fully unit-testable with fixtures; scripts/
// p11f0-fourarm-preflight.mjs is the thin CLI wrapper that gathers the
// real inputs (live DB readiness, real file hashes) and calls this.
//
// This module NEVER runs an evaluation itself (no HCX calls, no retrieval
// calls, no scoring) -- it only aggregates already-computed identity/
// readiness facts into one report and applies the Owner-pending policy
// this Turn was explicitly told to preserve, not resolve.
import { assertSingleCompleteBatch, validateLedgerEntry } from "./four-arm-run-ledger.mjs";
import { RETRIEVAL_OUTPUT_K, PRIMARY_EVALUATION_K, REPORTED_CUTOFFS } from "./four-arm-cutoff-contract.mjs";

export const OWNER_PENDING_POLICY = Object.freeze({
  // vFINAL section 16's own ARM_SPECIFIC critical classification, applied
  // by the adopted ac_scorer_50cc1aa package's Owner arm-blind adjudication
  // (resolutions.json) -- kept exactly as adjudicated. This Turn does not
  // reclassify these as ordinary slot-found failures to make B/D pass.
  arm_specific_critical_packets: Object.freeze(["u-1b6cd184a87f", "u-8564414f6080"]),
  arm_specific_critical_disposition: "KEPT_AS_HARD_CRITICAL_PER_VFINAL_SECTION_16",
  ordinary_slot_failure_relaxation_forbidden: true,
  unknown_packet_count: 15,
  unknown_disposition: "OWNER_ARM_BLIND_ADJUDICATION_PENDING",
  common_source_exclusion_limit: 5,
  hard_safe_declaration_before_owner_decision: "FORBIDDEN",
  open_owner_decisions: Object.freeze([
    "whether the 2 ARM_SPECIFIC critical packets should be reclassified as ordinary slot-found failures under section 16 B / section 14's retrieval-false-positive language (would return B/D to hard-safe with those slots counted as misses)",
    "final disposition of the 15 remaining UNKNOWN packets (new resolution class vs. indefinite hold)",
  ]),
});

function sortedKeys(obj) {
  return Object.keys(obj).sort();
}

// armReadiness: the real, live createArmRetrieverAdapter(...).readiness()
// output for arm A or C (see scripts/p11f0-fourarm-preflight.mjs).
function armLedgerEntryFromReadiness({ arm, readiness, batchId, codeHeadSha256, configSha256, conditionsSha256, universeSha256, corpusManifestSha256, indexSha256 }) {
  const blockers = [];
  if (!readiness.official_experiment_ready) blockers.push(`ARM_${arm}_INFRA_NOT_OFFICIAL_EXPERIMENT_READY: ${JSON.stringify(readiness.reasons)}`);
  const entry = Object.freeze({
    arm,
    role: "AC_LIVE",
    batch_id: batchId,
    status: "NOT_EXECUTED_PENDING_DEVTUNE",
    code_sha256: codeHeadSha256,
    config_sha256: configSha256,
    input_sha256: Object.freeze({
      conditions: conditionsSha256,
      universe: universeSha256,
      corpus_manifest: corpusManifestSha256,
    }),
    index_sha256: indexSha256,
    results_sha256: null,
    infra_readiness: readiness,
  });
  validateLedgerEntry(entry);
  return { entry, blockers };
}

// bdRunJson: the imported B.run.json/D.run.json content (already read from
// disk by the caller). bdResultsSha256/bdJudgement: from
// official/IMPORT_MANIFEST.json (already SHA-verified at import time).
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
  conditionsValidation, universeValidation,
  armA, armC, // { readiness, codeHeadSha256, configSha256, corpusManifestSha256, indexSha256 }
  armBRunJson, armDRunJson, armBResultsSha256, armDResultsSha256,
  bdJudgementStatus, bdJudgementReason,
  ownerPendingPolicy = OWNER_PENDING_POLICY,
}) {
  const blockers = [];

  const conditionsOk = Boolean(conditionsValidation?.official_execution_ready) && typeof conditionsValidation?.file_sha256 === "string";
  const universeOk = Boolean(universeValidation?.official_execution_ready) && typeof universeValidation?.file_sha256 === "string";
  if (!conditionsOk) blockers.push("CONDITIONS_ARTIFACT_NOT_VERIFIED");
  if (!universeOk) blockers.push("UNIVERSE_ARTIFACT_NOT_VERIFIED");

  // Ledger entries embed the conditions/universe SHAs as part of each arm's
  // own input_sha256 -- an unverified artifact has no trustworthy SHA to
  // embed, so no entry is even attempted (fail closed) rather than
  // fabricating a null/placeholder hash that would itself violate the
  // ledger entry contract (validateLedgerEntry requires every present
  // input_sha256 value to be a real sha256).
  const entries = [];
  if (conditionsOk && universeOk) {
    const builders = [
      () => armLedgerEntryFromReadiness({
        arm: "A", batchId, readiness: armA.readiness, codeHeadSha256: armA.codeHeadSha256,
        configSha256: armA.configSha256, conditionsSha256: conditionsValidation.file_sha256,
        universeSha256: universeValidation.file_sha256, corpusManifestSha256: armA.corpusManifestSha256,
        indexSha256: armA.indexSha256,
      }),
      () => armLedgerEntryFromReadiness({
        arm: "C", batchId, readiness: armC.readiness, codeHeadSha256: armC.codeHeadSha256,
        configSha256: armC.configSha256, conditionsSha256: conditionsValidation.file_sha256,
        universeSha256: universeValidation.file_sha256, corpusManifestSha256: armC.corpusManifestSha256,
        indexSha256: armC.indexSha256,
      }),
      () => bdLedgerEntryFromImport({
        arm: "B", batchId, runJson: armBRunJson, resultsSha256: armBResultsSha256,
        conditionsSha256: conditionsValidation.file_sha256, universeSha256: universeValidation.file_sha256,
      }),
      () => bdLedgerEntryFromImport({
        arm: "D", batchId, runJson: armDRunJson, resultsSha256: armDResultsSha256,
        conditionsSha256: conditionsValidation.file_sha256, universeSha256: universeValidation.file_sha256,
      }),
    ];
    for (const build of builders) {
      try {
        const result = build();
        blockers.push(...result.blockers);
        entries.push(result.entry);
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

  if (bdJudgementStatus !== "SUPPORTED_HARD_SAFE") {
    blockers.push(`BD_JUDGEMENT_NOT_HARD_SAFE: status=${bdJudgementStatus} reason=${bdJudgementReason}`);
  }
  if (ownerPendingPolicy.hard_safe_declaration_before_owner_decision === "FORBIDDEN"
      && bdJudgementStatus !== "SUPPORTED_HARD_SAFE") {
    blockers.push("OWNER_DECISION_PENDING: B/D cannot be declared hard-safe before the Owner resolves the 2 open decisions recorded in OWNER_PENDING_POLICY");
  }

  const finalBlockers = blockers.filter(Boolean);

  const officialReady = finalBlockers.length === 0;

  return Object.freeze({
    schema_version: "0.1.0",
    turn: "AC-OFFICIAL-INTEGRATION-V1",
    batch_id: batchId,
    cutoff_contract: Object.freeze({
      retrieval_output_k: RETRIEVAL_OUTPUT_K,
      primary_evaluation_k: PRIMARY_EVALUATION_K,
      reported_cutoffs: REPORTED_CUTOFFS,
    }),
    conditions_artifact: conditionsValidation,
    universe_artifact: universeValidation,
    ledger: Object.freeze({
      batch: batch,
      entries: Object.freeze(entries),
    }),
    bd_judgement: Object.freeze({
      status: bdJudgementStatus,
      reason: bdJudgementReason,
      owner_pending_policy: ownerPendingPolicy,
    }),
    official_4arm_execution_ready: officialReady,
    blockers: Object.freeze(finalBlockers),
    dev_tune_executed: false,
    dev_check_holdout_accessed: false,
    production_wiring_performed: false,
  });
}
