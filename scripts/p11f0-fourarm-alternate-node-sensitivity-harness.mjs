#!/usr/bin/env node
// FOURARM-ALTERNATE-NODE-SENSITIVITY-HARNESS-V1: CLI wiring for a FUTURE
// real run. This turn does not execute this script against real reviewer
// output, real baseline evidence, or the frozen scorer -- it only wires the
// already-tested pure modules together so a later turn can run it once the
// real 26-packet reviewer artifacts exist and are ready to be adjudicated.
//
// This script never hardcodes a path to any official/frozen artifact
// (A/B/C/D results.jsonl or run.json, resolutions.owner.json, or the frozen
// scorer) -- every input path is a CLI argument the caller supplies, and
// the output path is validated to guarantee it can never overwrite one of
// those files. It also never reads a DEV_CHECK/HOLDOUT path: none of its
// CLI arguments name a Gold, DEV_CHECK, or HOLDOUT location at all.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";

import { validatePopulationTemplate } from "../domain/agent-comparison/four-arm-ac/alternate-node-sensitivity-population-guard.mjs";
import { validateReviewerArtifact } from "../domain/agent-comparison/four-arm-ac/alternate-node-sensitivity-reviewer-artifact-validator.mjs";
import { compareReviewerArtifacts } from "../domain/agent-comparison/four-arm-ac/alternate-node-sensitivity-reviewer-comparison.mjs";
import { buildSensitivityView } from "../domain/agent-comparison/four-arm-ac/alternate-node-sensitivity-adjudication-adapter.v1.mjs";
import { buildSideBySideReport } from "../domain/agent-comparison/four-arm-ac/alternate-node-sensitivity-report.mjs";

// Fail-closed guard on the output destination: the sensitivity report may
// never land on a path that looks like it could be (or live alongside) an
// official/frozen artifact.
const FORBIDDEN_OUTPUT_SUBSTRINGS = [
  "results.jsonl", "run.json", "resolutions.owner",
  "/official/", "scorer-patch-multinode",
];

function assertSafeOutputPath(outPath) {
  const normalized = outPath.replace(/\\/g, "/");
  for (const needle of FORBIDDEN_OUTPUT_SUBSTRINGS) {
    if (normalized.includes(needle)) {
      throw new Error(`SENSITIVITY_HARNESS_UNSAFE_OUTPUT_PATH: refusing to write sensitivity output to a path containing ${JSON.stringify(needle)}: ${outPath}`);
    }
  }
  if (!normalized.includes("/sensitivity/") && !normalized.includes("sensitivity-")) {
    throw new Error(`SENSITIVITY_HARNESS_UNSAFE_OUTPUT_PATH: sensitivity output path must live in a dedicated sensitivity-only location (expected a "sensitivity" segment), got: ${outPath}`);
  }
}

async function sha256OfFile(filePath) {
  const bytes = await readFile(filePath);
  return createHash("sha256").update(bytes).digest("hex");
}

// Pure orchestration over already-read inputs -- kept separate from main()
// so tests can call it directly with in-memory buffers/objects without
// touching the filesystem.
export function runSensitivityHarness({
  populationBytes,
  policyBytes,
  reviewerASourceHead,
  reviewerABytes,
  reviewerBSourceHead,
  reviewerBBytes,
  baselineSlotEvidence,
  officialMetricsByArm,
  sensitivityMetricsByArm,
  officialResult,
}) {
  const population = validatePopulationTemplate(populationBytes, {});
  const policySha256 = createHash("sha256").update(policyBytes).digest("hex");

  const reviewerA = validateReviewerArtifact(reviewerABytes, {
    expectedReviewerLabel: "A",
    expectedSourceHead: reviewerASourceHead,
    expectedPolicySha256: policySha256,
    expectedPacketCombinedSha256: population.packet_combined_sha256,
    expectedPacketIds: population.packet_ids,
    expectedPacketCount: population.packet_count,
  });
  const reviewerB = validateReviewerArtifact(reviewerBBytes, {
    expectedReviewerLabel: "B",
    expectedSourceHead: reviewerBSourceHead,
    expectedPolicySha256: policySha256,
    expectedPacketCombinedSha256: population.packet_combined_sha256,
    expectedPacketIds: population.packet_ids,
    expectedPacketCount: population.packet_count,
  });

  const comparison = compareReviewerArtifacts(reviewerA, reviewerB);
  const sensitivityView = buildSensitivityView({ comparisonResult: comparison, baselineSlotEvidence });

  const sensitivityResult = {
    status: sensitivityResultStatus(sensitivityView),
    winner: null, // this harness never selects a sensitivity winner itself -- selection is a separate, existing module (four-arm-winner-selection.mjs) fed by this view's slot_view/per_arm_hard_gate
  };

  const report = buildSideBySideReport({
    officialMetricsByArm,
    sensitivityMetricsByArm,
    perArmHardGate: sensitivityView.per_arm_hard_gate,
    officialResult,
    sensitivityResult,
  });

  return {
    population_packet_count: population.packet_count,
    reviewer_comparison: comparison,
    sensitivity_view: sensitivityView,
    report,
  };
}

function sensitivityResultStatus(sensitivityView) {
  const anyFailed = Object.values(sensitivityView.per_arm_hard_gate).some((g) => g.hard_gate_state === "HARD_GATE_FAILED");
  return anyFailed ? "NO_SELECTION_BLOCKED" : "EXECUTION_PENDING";
}

async function main() {
  const args = new Map();
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    if (!key.startsWith("--")) throw new Error(`unexpected argument ${key}`);
    args.set(key.slice(2), argv[i + 1]);
  }
  const required = [
    "population", "policy", "reviewer-a", "reviewer-a-source-head",
    "reviewer-b", "reviewer-b-source-head", "baseline-evidence",
    "official-metrics", "sensitivity-metrics", "official-result", "out",
  ];
  for (const key of required) {
    if (!args.has(key)) throw new Error(`USAGE: missing --${key}`);
  }

  assertSafeOutputPath(args.get("out"));

  const [populationBytes, policyBytes, reviewerABytes, reviewerBBytes, baselineSlotEvidence, officialMetricsByArm, sensitivityMetricsByArm, officialResult] = await Promise.all([
    readFile(path.resolve(args.get("population"))),
    readFile(path.resolve(args.get("policy"))),
    readFile(path.resolve(args.get("reviewer-a"))),
    readFile(path.resolve(args.get("reviewer-b"))),
    readFile(path.resolve(args.get("baseline-evidence")), "utf8").then(JSON.parse),
    readFile(path.resolve(args.get("official-metrics")), "utf8").then(JSON.parse),
    readFile(path.resolve(args.get("sensitivity-metrics")), "utf8").then(JSON.parse),
    readFile(path.resolve(args.get("official-result")), "utf8").then(JSON.parse),
  ]);

  const result = runSensitivityHarness({
    populationBytes,
    policyBytes,
    reviewerASourceHead: args.get("reviewer-a-source-head"),
    reviewerABytes,
    reviewerBSourceHead: args.get("reviewer-b-source-head"),
    reviewerBBytes,
    baselineSlotEvidence,
    officialMetricsByArm,
    sensitivityMetricsByArm,
    officialResult,
  });

  const outPath = path.resolve(args.get("out"));
  await mkdir(path.dirname(outPath), { recursive: true });
  await writeFile(outPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({ output_path: outPath, robustness: result.report.robustness.classification })}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main().catch((error) => {
    process.stderr.write(`[alternate-node-sensitivity-harness] FAILED: ${error.message}\n`);
    process.exitCode = 1;
  });
}

export { sha256OfFile };
