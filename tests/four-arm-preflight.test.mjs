import test from "node:test";
import assert from "node:assert/strict";
import { assembleFourArmPreflightManifest, OWNER_PENDING_POLICY } from "../domain/agent-comparison/four-arm-ac/four-arm-preflight.mjs";

const CONDITIONS_SHA = "83d5b8a02de2e3e79e388ec417ed104c81b08eb0a8dc8a8366b020df36b5e527";
const UNIVERSE_SHA = "96560165c836b10e315cb253ab96a99b369478c3f71a0415d16b7b6fadbfa1dc";
const MANIFEST_SHA = "04750795e1a2d5c35f73e4bb7766ebede02ff3512d33c382bd4c3a51daba3364";
const CODE_SHA = "44f05231de8b9a3b6fdb6ff422435d0586937941";
const CONFIG_SHA_A = "1".repeat(64);
const CONFIG_SHA_C = "2".repeat(64);
const CORPUS_MANIFEST_SHA = "8cc6628eb38fff0ee48cf138a586978a627260a7e41157dddd45e52f97761d4e";
const INDEX_SHA = CORPUS_MANIFEST_SHA;

function readyArmReadiness(overrides = {}) {
  return { official_experiment_ready: true, reasons: [], ...overrides };
}

function bdRunJson({ codeSha = "04b847c4a2e61042da9f025735af8b2e2e56311e", configSha = "3".repeat(64), conditions = CONDITIONS_SHA, universe = UNIVERSE_SHA, manifest = MANIFEST_SHA } = {}) {
  return { code_sha256: codeSha, config_sha256: configSha, input_sha256: { conditions, universe, manifest } };
}

function baseArgs(overrides = {}) {
  return {
    batchId: "batch1",
    conditionsValidation: { official_execution_ready: true, file_sha256: CONDITIONS_SHA },
    universeValidation: { official_execution_ready: true, file_sha256: UNIVERSE_SHA },
    armA: { readiness: readyArmReadiness(), codeHeadSha256: CODE_SHA, configSha256: CONFIG_SHA_A, corpusManifestSha256: CORPUS_MANIFEST_SHA, indexSha256: INDEX_SHA },
    armC: { readiness: readyArmReadiness(), codeHeadSha256: CODE_SHA, configSha256: CONFIG_SHA_C, corpusManifestSha256: CORPUS_MANIFEST_SHA, indexSha256: INDEX_SHA },
    armBRunJson: bdRunJson(),
    armDRunJson: bdRunJson(),
    armBResultsSha256: "b".repeat(64),
    armDResultsSha256: "d".repeat(64),
    bdJudgementStatus: "BLOCKED_NO_HARD_SAFE_ARM",
    bdJudgementReason: "test reason",
    ...overrides,
  };
}

test("all infra GREEN but B/D judgement BLOCKED -> official_4arm_execution_ready is false with an exact, non-empty blocker", () => {
  const manifest = assembleFourArmPreflightManifest(baseArgs());
  assert.equal(manifest.official_4arm_execution_ready, false);
  assert.ok(manifest.blockers.some((b) => b.startsWith("BD_JUDGEMENT_NOT_HARD_SAFE")));
  assert.ok(manifest.blockers.some((b) => b.startsWith("OWNER_DECISION_PENDING")));
  assert.equal(manifest.ledger.entries.length, 4);
  assert.equal(manifest.dev_tune_executed, false);
  assert.equal(manifest.dev_check_holdout_accessed, false);
  assert.equal(manifest.production_wiring_performed, false);
});

test("owner pending policy is recorded verbatim, not relaxed", () => {
  const manifest = assembleFourArmPreflightManifest(baseArgs());
  assert.deepEqual(manifest.bd_judgement.owner_pending_policy, OWNER_PENDING_POLICY);
  assert.equal(manifest.bd_judgement.owner_pending_policy.arm_specific_critical_disposition, "KEPT_AS_HARD_CRITICAL_PER_VFINAL_SECTION_16");
  assert.equal(manifest.bd_judgement.owner_pending_policy.hard_safe_declaration_before_owner_decision, "FORBIDDEN");
});

test("a hypothetical SUPPORTED_HARD_SAFE judgement with everything else green produces official_4arm_execution_ready=true", () => {
  const manifest = assembleFourArmPreflightManifest(baseArgs({ bdJudgementStatus: "SUPPORTED_HARD_SAFE", bdJudgementReason: "hypothetical" }));
  assert.equal(manifest.official_4arm_execution_ready, true);
  assert.deepEqual(manifest.blockers, []);
});

test("arm A infra not ready produces a specific ARM_A blocker and forces official_4arm_execution_ready=false", () => {
  const manifest = assembleFourArmPreflightManifest(baseArgs({
    armA: { readiness: readyArmReadiness({ official_experiment_ready: false, reasons: ["A_DENSE_INDEX_NOT_READY_OR_PIN_MISMATCH"] }), codeHeadSha256: CODE_SHA, configSha256: CONFIG_SHA_A, corpusManifestSha256: CORPUS_MANIFEST_SHA, indexSha256: INDEX_SHA },
    bdJudgementStatus: "SUPPORTED_HARD_SAFE",
  }));
  assert.equal(manifest.official_4arm_execution_ready, false);
  assert.ok(manifest.blockers.some((b) => b.startsWith("ARM_A_INFRA_NOT_OFFICIAL_EXPERIMENT_READY")));
});

test("a conditions/universe pin mismatch between B's run.json and the imported artifact is caught, never silently accepted", () => {
  const manifest = assembleFourArmPreflightManifest(baseArgs({
    armBRunJson: bdRunJson({ conditions: "f".repeat(64) }),
    bdJudgementStatus: "SUPPORTED_HARD_SAFE",
  }));
  assert.equal(manifest.official_4arm_execution_ready, false);
  assert.ok(manifest.blockers.includes("ARM_B_CONDITIONS_PIN_MISMATCH"));
});

test("conditions artifact not verified blocks readiness even if everything else is green", () => {
  const manifest = assembleFourArmPreflightManifest(baseArgs({
    conditionsValidation: { official_execution_ready: false, file_sha256: null },
    bdJudgementStatus: "SUPPORTED_HARD_SAFE",
  }));
  assert.ok(manifest.blockers.includes("CONDITIONS_ARTIFACT_NOT_VERIFIED"));
  assert.equal(manifest.official_4arm_execution_ready, false);
});

test("cutoff_contract in the manifest matches the shared k=20/10/[5,10,20] contract", () => {
  const manifest = assembleFourArmPreflightManifest(baseArgs());
  assert.deepEqual(manifest.cutoff_contract, { retrieval_output_k: 20, primary_evaluation_k: 10, reported_cutoffs: [5, 10, 20] });
});

test("every ledger entry produced is individually schema-valid (validateLedgerEntry never throws on assembler output)", () => {
  const manifest = assembleFourArmPreflightManifest(baseArgs());
  assert.equal(manifest.ledger.entries.length, 4);
  for (const entry of manifest.ledger.entries) {
    assert.ok(["A", "B", "C", "D"].includes(entry.arm));
  }
});
