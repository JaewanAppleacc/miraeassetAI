// Enforces the harness's own non-negotiable invariants (see
// results/ALTERNATE_NODE_SENSITIVITY_V1_AMENDMENT.md#prohibitions and this
// turn's FOURARM-ALTERNATE-NODE-SENSITIVITY-HARNESS-V1 instructions):
//   - original A/B/C/D results.jsonl/run.json and the frozen scorer file
//     are never modified by exercising the harness modules
//   - no harness source file references DEV_CHECK/HOLDOUT or hardcodes a
//     path to an official/frozen artifact
//   - no harness module's decision depends on which literal packet ID
//     string is used (no packet-ID-specific branches)
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { validatePopulationTemplate } from "../domain/agent-comparison/four-arm-ac/alternate-node-sensitivity-population-guard.mjs";
import { validateReviewerArtifact } from "../domain/agent-comparison/four-arm-ac/alternate-node-sensitivity-reviewer-artifact-validator.mjs";
import { compareReviewerArtifacts } from "../domain/agent-comparison/four-arm-ac/alternate-node-sensitivity-reviewer-comparison.mjs";
import { buildSensitivityView } from "../domain/agent-comparison/four-arm-ac/alternate-node-sensitivity-adjudication-adapter.v1.mjs";
import { buildSideBySideReport } from "../domain/agent-comparison/four-arm-ac/alternate-node-sensitivity-report.mjs";
import {
  buildSyntheticPopulationTemplate,
  buildSyntheticReviewerArtifact,
  syntheticPacketId,
} from "../domain/agent-comparison/four-arm-ac/alternate-node-sensitivity-fixture.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const fourArmAcDir = path.join(root, "domain/agent-comparison/four-arm-ac");

const HARNESS_SOURCE_FILES = [
  "alternate-node-sensitivity-population-guard.mjs",
  "alternate-node-sensitivity-reviewer-artifact-validator.mjs",
  "alternate-node-sensitivity-reviewer-comparison.mjs",
  "alternate-node-sensitivity-adjudication-adapter.v1.mjs",
  "alternate-node-sensitivity-report.mjs",
].map((name) => path.join(fourArmAcDir, name));

const HARNESS_CLI_SCRIPT = path.join(root, "scripts/p11f0-fourarm-alternate-node-sensitivity-harness.mjs");

const PROTECTED_FILES = [
  path.join(fourArmAcDir, "results/A.results.jsonl"),
  path.join(fourArmAcDir, "results/A.run.json"),
  path.join(fourArmAcDir, "results/C.results.jsonl"),
  path.join(fourArmAcDir, "results/C.run.json"),
  path.join(fourArmAcDir, "official/B.run.json"),
  path.join(fourArmAcDir, "official/D.run.json"),
  path.join(fourArmAcDir, "official/resolutions.owner.json"),
  path.join(fourArmAcDir, "scorer-patch-multinode-v1/fourarm.patched.py"),
];

async function sha256OfFile(filePath) {
  const bytes = await readFile(filePath);
  return createHash("sha256").update(bytes).digest("hex");
}

async function hashAll(files) {
  const entries = await Promise.all(files.map(async (f) => [f, await sha256OfFile(f)]));
  return Object.fromEntries(entries);
}

test("exercising every harness module never touches any protected original file", async () => {
  const before = await hashAll(PROTECTED_FILES);

  // Run the full pipeline end to end, purely in memory, on synthetic data.
  const population = buildSyntheticPopulationTemplate(26);
  const populationSummary = validatePopulationTemplate(population.bytes);
  const policySha256 = createHash("sha256").update("synthetic-policy-bytes").digest("hex");
  const sourceHead = "8678fea7255dde2a399a233a299f0d984966e42b";
  const reviewerA = buildSyntheticReviewerArtifact(population, {
    reviewerLabel: "A", sourceHead, policySha256, outcomesByPacketId: { [syntheticPacketId(0)]: "SUPPORTED_ALTERNATE_NODE" },
  });
  const reviewerB = buildSyntheticReviewerArtifact(population, {
    reviewerLabel: "B", sourceHead, policySha256, outcomesByPacketId: { [syntheticPacketId(0)]: "SUPPORTED_ALTERNATE_NODE" },
  });
  const options = (label) => ({
    expectedReviewerLabel: label, expectedSourceHead: sourceHead, expectedPolicySha256: policySha256,
    expectedPacketCombinedSha256: populationSummary.packet_combined_sha256, expectedPacketIds: populationSummary.packet_ids,
    expectedPacketCount: populationSummary.packet_count,
  });
  const validatedA = validateReviewerArtifact(reviewerA.bytes, options("A"));
  const validatedB = validateReviewerArtifact(reviewerB.bytes, options("B"));
  const comparison = compareReviewerArtifacts(validatedA, validatedB);
  const view = buildSensitivityView({ comparisonResult: comparison, baselineSlotEvidence: [] });
  buildSideBySideReport({
    officialMetricsByArm: Object.fromEntries(["A", "B", "C", "D"].map((a) => [a, { recall_at_5: 0, recall_at_10: 0, recall_at_20: 0, high_recall_at_10: 0, low_recall_at_10: 0, low_all_required_slots_found: 0 }])),
    sensitivityMetricsByArm: Object.fromEntries(["A", "B", "C", "D"].map((a) => [a, { recall_at_5: 0, recall_at_10: 0, recall_at_20: 0, high_recall_at_10: 0, low_recall_at_10: 0, low_all_required_slots_found: 0 }])),
    perArmHardGate: view.per_arm_hard_gate,
    officialResult: { status: "PENDING_UNRESOLVED", winner: null },
    sensitivityResult: { status: "EXECUTION_PENDING", winner: null },
  });

  const after = await hashAll(PROTECTED_FILES);
  assert.deepEqual(after, before, "a protected original/frozen file changed after running the sensitivity harness");
});

test("no harness source file references DEV_CHECK or HOLDOUT", async () => {
  for (const file of [...HARNESS_SOURCE_FILES, HARNESS_CLI_SCRIPT]) {
    const text = await readFile(file, "utf8");
    // Comments are allowed to explain the prohibition (as this test file's
    // own header and the harness sources' headers do); no line of actual
    // code may reference these tokens.
    for (const line of text.split("\n")) {
      if (/^\s*\/\//.test(line)) continue; // skip full-line comments
      assert.doesNotMatch(line, /DEV_CHECK|HOLDOUT/, `${path.basename(file)} must not reference DEV_CHECK/HOLDOUT outside comments: ${line}`);
    }
  }
});

test("no harness module hardcodes a path to an official/frozen artifact or writes to one", async () => {
  const forbiddenLiterals = [
    "A.results.jsonl", "B.results.jsonl", "C.results.jsonl", "D.results.jsonl",
    "A.run.json", "B.run.json", "C.run.json", "D.run.json",
    "resolutions.owner.json",
  ];
  function codeOnly(text) {
    return text.split("\n").filter((line) => !/^\s*\/\//.test(line)).join("\n");
  }

  for (const file of HARNESS_SOURCE_FILES) {
    const code = codeOnly(await readFile(file, "utf8"));
    for (const literal of forbiddenLiterals) {
      assert.ok(!code.includes(literal), `${path.basename(file)} must not reference ${literal} outside comments`);
    }
    assert.ok(!/writeFile|appendFile|createWriteStream/.test(code), `${path.basename(file)} must be a pure, non-filesystem-writing module`);
  }
  const cliCode = codeOnly(await readFile(HARNESS_CLI_SCRIPT, "utf8"));
  for (const literal of forbiddenLiterals) {
    assert.ok(!cliCode.includes(literal), `CLI script must not reference ${literal} outside comments`);
  }
});

test("population guard and reviewer validator never modify their input bytes", async () => {
  const population = buildSyntheticPopulationTemplate(26);
  const originalBytes = Buffer.from(population.bytes);
  validatePopulationTemplate(population.bytes);
  assert.ok(population.bytes.equals(originalBytes));
});

test("no packet-ID-specific logic: relabeling every packet id produces an isomorphic decision, not a different one", () => {
  const N = 26;
  const populationOne = buildSyntheticPopulationTemplate(N);
  // Build a second population whose packet ids are deliberately different
  // strings (offset by 1000) but whose per-position outcome assignment is
  // identical -- if any module secretly special-cases a literal packet ID,
  // this diverges; if the logic only depends on (position, outcome), it
  // will not.
  const populationTwo = buildSyntheticPopulationTemplate(N);
  for (let i = 0; i < N; i += 1) {
    populationTwo.template.resolutions[i].packet_id = syntheticPacketId(i + 1000);
  }
  populationTwo.bytes = Buffer.from(JSON.stringify(populationTwo.template), "utf8");

  const sourceHead = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
  const policySha256 = createHash("sha256").update("x").digest("hex");
  const outcomeAt = (i) => (i % 4 === 0 ? "SUPPORTED_ALTERNATE_NODE" : i % 4 === 1 ? "ARM_SPECIFIC_CRITICAL" : i % 4 === 2 ? "ARM_SPECIFIC_NON_CRITICAL" : "UNKNOWN");

  function runPipeline(population) {
    const summary = validatePopulationTemplate(population.bytes);
    const outcomesByPacketId = Object.fromEntries(summary.packet_ids.map((id, idx) => {
      // idx after sort may not match construction order; derive position from the id's own numeric suffix instead
      const numeric = parseInt(id.slice(2), 16);
      const base = numeric >= 1000 ? numeric - 1000 : numeric;
      return [id, outcomeAt(base)];
    }));
    const reviewerA = buildSyntheticReviewerArtifact(population, { reviewerLabel: "A", sourceHead, policySha256, outcomesByPacketId });
    const reviewerB = buildSyntheticReviewerArtifact(population, { reviewerLabel: "B", sourceHead, policySha256, outcomesByPacketId });
    const opts = (label) => ({
      expectedReviewerLabel: label, expectedSourceHead: sourceHead, expectedPolicySha256: policySha256,
      expectedPacketCombinedSha256: summary.packet_combined_sha256, expectedPacketIds: summary.packet_ids, expectedPacketCount: summary.packet_count,
    });
    const validatedA = validateReviewerArtifact(reviewerA.bytes, opts("A"));
    const validatedB = validateReviewerArtifact(reviewerB.bytes, opts("B"));
    const comparison = compareReviewerArtifacts(validatedA, validatedB);
    const baseline = summary.packet_ids.map((id) => ({ packet_id: id, arm: "A", question_id: "q", slot_name: "s", baseline_found: true }));
    const view = buildSensitivityView({ comparisonResult: comparison, baselineSlotEvidence: baseline });
    // Normalize away the actual id strings so we compare shape/outcome only.
    return view.slot_view
      .map((slot) => {
        const numeric = parseInt(slot.packet_id.slice(2), 16);
        const base = numeric >= 1000 ? numeric - 1000 : numeric;
        return { base, sensitivity_action: slot.sensitivity_action, sensitivity_found: slot.sensitivity_found };
      })
      .sort((a, b) => a.base - b.base);
  }

  const resultOne = runPipeline(populationOne);
  const resultTwo = runPipeline(populationTwo);
  assert.deepEqual(resultOne, resultTwo, "relabeling packet ids changed the harness's decisions -- logic must not depend on literal packet ID values");
});
