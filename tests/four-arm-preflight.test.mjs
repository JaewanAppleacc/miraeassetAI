import test from "node:test";
import assert from "node:assert/strict";
import { assembleFourArmPreflightManifest } from "../domain/agent-comparison/four-arm-ac/four-arm-preflight.mjs";

const CONDITIONS_SHA = "83d5b8a02de2e3e79e388ec417ed104c81b08eb0a8dc8a8366b020df36b5e527";
const UNIVERSE_SHA = "96560165c836b10e315cb253ab96a99b369478c3f71a0415d16b7b6fadbfa1dc";
const MANIFEST_SHA = "04750795e1a2d5c35f73e4bb7766ebede02ff3512d33c382bd4c3a51daba3364";
const CODE_SHA = "44f05231de8b9a3b6fdb6ff422435d0586937941";
const CONFIG_SHA_A = "1".repeat(64);
const CONFIG_SHA_C = "2".repeat(64);
const CORPUS_MANIFEST_SHA = "8cc6628eb38fff0ee48cf138a586978a627260a7e41157dddd45e52f97761d4e";
const INDEX_SHA = CORPUS_MANIFEST_SHA;
const B_RESULTS_SHA = "de661a1cbd20d8de268e24b84ccac8ab41feeace0af2502891d401a2c0898985";
const D_RESULTS_SHA = "0f1112219d28442115f0bc07924d580320c40303b365ef1f2325fc5afa29cf6b";

function readyArmReadiness(overrides = {}) {
  return { official_experiment_ready: true, reasons: [], ...overrides };
}

function bdRunJson({ codeSha = "04b847c4a2e61042da9f025735af8b2e2e56311e", configSha = "3".repeat(64), conditions = CONDITIONS_SHA, universe = UNIVERSE_SHA, manifest = MANIFEST_SHA } = {}) {
  return { code_sha256: codeSha, config_sha256: configSha, input_sha256: { conditions, universe, manifest } };
}

function ownerResolutionsValidation(overrides = {}) {
  return {
    official_execution_ready: true,
    file_sha256: "9".repeat(64),
    distribution: { total: 17, critical: 2, ARM_SPECIFIC: 2, COMMON_SOURCE: 0, UNKNOWN: 15 },
    critical_packet_ids: ["u-1b6cd184a87f", "u-8564414f6080"],
    unknown_packet_ids: Array.from({ length: 15 }, (_, i) => `u-unknown-${i}`),
    ...overrides,
  };
}

function baseArgs(overrides = {}) {
  return {
    batchId: "batch1",
    conditionsValidation: { official_execution_ready: true, file_sha256: CONDITIONS_SHA },
    universeValidation: { official_execution_ready: true, file_sha256: UNIVERSE_SHA },
    ownerResolutionsValidation: ownerResolutionsValidation(),
    armA: { readiness: readyArmReadiness(), codeHeadSha256: CODE_SHA, configSha256: CONFIG_SHA_A, corpusManifestSha256: CORPUS_MANIFEST_SHA, indexSha256: INDEX_SHA },
    armC: { readiness: readyArmReadiness(), codeHeadSha256: CODE_SHA, configSha256: CONFIG_SHA_C, corpusManifestSha256: CORPUS_MANIFEST_SHA, indexSha256: INDEX_SHA },
    armBRunJson: bdRunJson(),
    armDRunJson: bdRunJson(),
    armBResultsSha256: B_RESULTS_SHA,
    armDResultsSha256: D_RESULTS_SHA,
    ...overrides,
  };
}

test("all pins/artifacts verified, B/D hard-gate-failed -> official_batch_execution_ready=true, final_selection_ready=false", () => {
  const manifest = assembleFourArmPreflightManifest(baseArgs());
  assert.equal(manifest.official_batch_execution_ready, true, JSON.stringify(manifest.blockers));
  assert.equal(manifest.final_selection_ready, false);
  assert.deepEqual(manifest.blockers, []);
  assert.equal(manifest.selection.status, "EXECUTION_PENDING");
  assert.equal(manifest.dev_tune_executed, false);
  assert.equal(manifest.dev_check_holdout_accessed, false);
  assert.equal(manifest.production_wiring_performed, false);
});

test("B/D arm states report HARD_GATE_FAILED / selection_eligible=false with the ARM_SPECIFIC_CRITICAL_2 reason", () => {
  const manifest = assembleFourArmPreflightManifest(baseArgs());
  const b = manifest.arm_states.find((s) => s.arm === "B");
  const d = manifest.arm_states.find((s) => s.arm === "D");
  assert.equal(b.arm_hard_gate_state, "HARD_GATE_FAILED");
  assert.equal(b.arm_selection_eligible, false);
  assert.equal(b.failure_reason, "ARM_SPECIFIC_CRITICAL_2");
  assert.equal(d.arm_hard_gate_state, "HARD_GATE_FAILED");
  assert.equal(d.arm_selection_eligible, false);
});

test("A/C arm states report NOT_EXECUTED_PENDING_DEVTUNE / selection_eligible=null -- execution required, not blocked", () => {
  const manifest = assembleFourArmPreflightManifest(baseArgs());
  const a = manifest.arm_states.find((s) => s.arm === "A");
  const c = manifest.arm_states.find((s) => s.arm === "C");
  assert.equal(a.arm_execution_state, "NOT_EXECUTED_PENDING_DEVTUNE");
  assert.equal(a.arm_hard_gate_state, "HARD_GATE_PENDING_EXECUTION");
  assert.equal(a.arm_selection_eligible, null);
  assert.equal(c.arm_execution_state, "NOT_EXECUTED_PENDING_DEVTUNE");
  assert.equal(c.arm_selection_eligible, null);
});

test("B/D's known hard-gate failure does NOT block official_batch_execution_ready -- A/C may still execute", () => {
  const manifest = assembleFourArmPreflightManifest(baseArgs());
  assert.equal(manifest.official_batch_execution_ready, true);
  assert.ok(!manifest.blockers.some((b) => /HARD_GATE/.test(b)), "no hard-gate-derived blocker should appear in the execution-readiness blocker list");
});

test("a conditions/universe pin mismatch on any arm blocks official_batch_execution_ready", () => {
  const manifest = assembleFourArmPreflightManifest(baseArgs({ armBRunJson: bdRunJson({ conditions: "f".repeat(64) }) }));
  assert.equal(manifest.official_batch_execution_ready, false);
  assert.ok(manifest.blockers.includes("ARM_B_CONDITIONS_PIN_MISMATCH"));
});

test("Owner resolutions artifact not verified blocks execution readiness fail-closed", () => {
  const manifest = assembleFourArmPreflightManifest(baseArgs({ ownerResolutionsValidation: { official_execution_ready: false } }));
  assert.equal(manifest.official_batch_execution_ready, false);
  assert.ok(manifest.blockers.includes("OWNER_RESOLUTIONS_ARTIFACT_NOT_VERIFIED"));
});

test("conditions/universe artifact not verified blocks execution readiness fail-closed", () => {
  const manifest = assembleFourArmPreflightManifest(baseArgs({ conditionsValidation: { official_execution_ready: false } }));
  assert.equal(manifest.official_batch_execution_ready, false);
  assert.ok(manifest.blockers.includes("CONDITIONS_ARTIFACT_NOT_VERIFIED"));
});

test("arm A infra not ready blocks official_batch_execution_ready with a specific reason", () => {
  const manifest = assembleFourArmPreflightManifest(baseArgs({
    armA: { readiness: readyArmReadiness({ official_experiment_ready: false, reasons: ["A_DENSE_INDEX_NOT_READY_OR_PIN_MISMATCH"] }), codeHeadSha256: CODE_SHA, configSha256: CONFIG_SHA_A, corpusManifestSha256: CORPUS_MANIFEST_SHA, indexSha256: INDEX_SHA },
  }));
  assert.equal(manifest.official_batch_execution_ready, false);
  assert.ok(manifest.blockers.some((b) => b.startsWith("ARM_A_INFRA_NOT_OFFICIAL_EXPERIMENT_READY")));
});

test("B/D result/run SHA inputs are recorded unchanged in the ledger -- never rewritten by this assembler", () => {
  const manifest = assembleFourArmPreflightManifest(baseArgs());
  const b = manifest.ledger.entries.find((e) => e.arm === "B");
  const d = manifest.ledger.entries.find((e) => e.arm === "D");
  assert.equal(b.results_sha256, B_RESULTS_SHA);
  assert.equal(d.results_sha256, D_RESULTS_SHA);
  assert.equal(b.status, "REUSED_VERIFIED");
  assert.equal(d.status, "REUSED_VERIFIED");
});

test("UNKNOWN packet count from the Owner resolutions stays visible in the manifest as provisional info", () => {
  const manifest = assembleFourArmPreflightManifest(baseArgs());
  assert.equal(manifest.owner_resolutions_artifact.unknown_packet_ids.length, 15);
});

test("once A executes and passes its own hard/quality gate, final_selection_ready still waits on C", () => {
  const manifest = assembleFourArmPreflightManifest(baseArgs({
    armA: {
      readiness: readyArmReadiness(), codeHeadSha256: CODE_SHA, configSha256: CONFIG_SHA_A,
      corpusManifestSha256: CORPUS_MANIFEST_SHA, indexSha256: INDEX_SHA,
      executionState: "EXECUTED", resultsSha256: "a".repeat(64),
      qualityMetrics: { hard_gate_state: "HARD_GATE_PASSED", primary_recall: 0.6 },
    },
  }));
  assert.equal(manifest.final_selection_ready, false);
  assert.equal(manifest.selection.status, "EXECUTION_PENDING");
  const a = manifest.arm_states.find((s) => s.arm === "A");
  assert.equal(a.arm_selection_eligible, true);
});

test("once BOTH A and C execute and pass, final_selection_ready=true and a provisional winner is picked from the eligible pool", () => {
  const manifest = assembleFourArmPreflightManifest(baseArgs({
    armA: {
      readiness: readyArmReadiness(), codeHeadSha256: CODE_SHA, configSha256: CONFIG_SHA_A,
      corpusManifestSha256: CORPUS_MANIFEST_SHA, indexSha256: INDEX_SHA,
      executionState: "EXECUTED", resultsSha256: "a".repeat(64),
      qualityMetrics: { hard_gate_state: "HARD_GATE_PASSED", primary_recall: 0.6 },
    },
    armC: {
      readiness: readyArmReadiness(), codeHeadSha256: CODE_SHA, configSha256: CONFIG_SHA_C,
      corpusManifestSha256: CORPUS_MANIFEST_SHA, indexSha256: INDEX_SHA,
      executionState: "EXECUTED", resultsSha256: "c".repeat(64),
      qualityMetrics: { hard_gate_state: "HARD_GATE_PASSED", primary_recall: 0.5 },
    },
  }));
  assert.equal(manifest.final_selection_ready, true);
  assert.equal(manifest.selection.status, "PROVISIONAL_WINNER");
  assert.equal(manifest.selection.winner, "A");
  // B/D, despite being "final", are never candidates -- excluded by their own hard-gate failure.
  assert.ok(!manifest.selection.eligible_arms.includes("B"));
  assert.ok(!manifest.selection.eligible_arms.includes("D"));
});

test("if A and C both fail their own hard/quality gate once executed, NO_SELECTION_BLOCKED (all 4 arms failed)", () => {
  const manifest = assembleFourArmPreflightManifest(baseArgs({
    armA: {
      readiness: readyArmReadiness(), codeHeadSha256: CODE_SHA, configSha256: CONFIG_SHA_A,
      corpusManifestSha256: CORPUS_MANIFEST_SHA, indexSha256: INDEX_SHA,
      executionState: "EXECUTED", resultsSha256: "a".repeat(64),
      qualityMetrics: { hard_gate_state: "HARD_GATE_FAILED" },
    },
    armC: {
      readiness: readyArmReadiness(), codeHeadSha256: CODE_SHA, configSha256: CONFIG_SHA_C,
      corpusManifestSha256: CORPUS_MANIFEST_SHA, indexSha256: INDEX_SHA,
      executionState: "EXECUTED", resultsSha256: "c".repeat(64),
      qualityMetrics: { hard_gate_state: "HARD_GATE_FAILED" },
    },
  }));
  assert.equal(manifest.final_selection_ready, true);
  assert.equal(manifest.selection.status, "NO_SELECTION_BLOCKED");
  assert.equal(manifest.selection.winner, null);
});

test("cutoff_contract in the manifest matches the shared k=20/10/[5,10,20] contract", () => {
  const manifest = assembleFourArmPreflightManifest(baseArgs());
  assert.deepEqual(manifest.cutoff_contract, { retrieval_output_k: 20, primary_evaluation_k: 10, reported_cutoffs: [5, 10, 20] });
});
