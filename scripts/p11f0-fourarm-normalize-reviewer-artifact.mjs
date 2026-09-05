#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  ACCEPTANCE_CONDITIONS,
  SCHEMA_VERSION,
  validateReviewerArtifact,
} from "../domain/agent-comparison/four-arm-ac/alternate-node-sensitivity-reviewer-artifact-validator.mjs";

const LEGACY_CHECK_KEYS = Object.freeze({
  same_document_and_real_nodes: "SAME_DOCUMENT_AND_REAL_NODES",
  declared_node_text_integrity_verified: "DECLARED_NODE_TEXT_INTEGRITY_VERIFIED",
  all_required_slot_evidence_present: "ALL_REQUIRED_SLOT_EVIDENCE_PRESENT",
  semantic_dimensions_compatible: "ENTITY_METRIC_SUBTYPE_SCOPE_PERIOD_UNIT_SIGN_CALCULATION_COMPATIBLE",
  no_contradiction: "NO_CONTRADICTORY_VALUE_OR_QUALIFIER",
  arm_blind_reproducible: "ARM_BLIND_REPRODUCIBLE_DECISION",
});

function normalizeChecks(checks) {
  const normalized = {};
  for (const [key, value] of Object.entries(checks || {})) {
    normalized[LEGACY_CHECK_KEYS[key] || key] = value;
  }
  if (Object.keys(normalized).length !== ACCEPTANCE_CONDITIONS.length
      || !ACCEPTANCE_CONDITIONS.every((key) => Object.hasOwn(normalized, key))) {
    throw new Error("NORMALIZE_REVIEWER_ACCEPTANCE_CHECKS_MISMATCH");
  }
  return Object.fromEntries(ACCEPTANCE_CONDITIONS.map((key) => [key, normalized[key]]));
}

export function normalizeReviewerArtifactShape(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("NORMALIZE_REVIEWER_INPUT_NOT_OBJECT");
  }
  const reviewerLabel = input.reviewer_label || input.reviewer;
  const source = input.resolutions;
  const entries = Array.isArray(source)
    ? source
    : Object.entries(source || {}).map(([packetId, body]) => ({ packet_id: packetId, ...body }));

  const resolutions = entries.map((entry) => ({
    packet_id: entry.packet_id,
    sensitivity_outcome: entry.sensitivity_outcome,
    acceptance_checks: normalizeChecks(entry.acceptance_checks),
    owner_confirmed: false,
    note: typeof entry.note === "string" ? entry.note : (entry.rationale || ""),
  }));

  const normalized = {
    schema_version: SCHEMA_VERSION,
    reviewer_label: reviewerLabel,
    source_head: input.source_head,
    policy_sha256: input.policy_sha256,
    packet_count: input.packet_count,
    packet_combined_sha256: input.packet_combined_sha256,
    owner_confirmed: false,
    resolutions,
  };

  const before = Object.fromEntries(entries.map((entry) => [entry.packet_id, entry.sensitivity_outcome]));
  const after = Object.fromEntries(resolutions.map((entry) => [entry.packet_id, entry.sensitivity_outcome]));
  if (JSON.stringify(before) !== JSON.stringify(after)) {
    throw new Error("NORMALIZE_REVIEWER_OUTCOME_DRIFT");
  }
  return normalized;
}

async function main() {
  const [inputPath, outputPath, populationPath, policyPath] = process.argv.slice(2);
  if (!inputPath || !outputPath || !populationPath || !policyPath) {
    throw new Error("USAGE: normalize-reviewer <input> <output> <population> <policy>");
  }
  const [inputRaw, populationRaw, policyRaw] = await Promise.all([
    readFile(path.resolve(inputPath), "utf8"),
    readFile(path.resolve(populationPath)),
    readFile(path.resolve(policyPath)),
  ]);
  const input = JSON.parse(inputRaw);
  const normalized = normalizeReviewerArtifactShape(input);
  const population = JSON.parse(populationRaw.toString("utf8"));
  const { createHash } = await import("node:crypto");
  const bytes = Buffer.from(`${JSON.stringify(normalized, null, 2)}\n`);
  validateReviewerArtifact(bytes, {
    expectedReviewerLabel: normalized.reviewer_label,
    expectedSourceHead: normalized.source_head,
    expectedPolicySha256: createHash("sha256").update(policyRaw).digest("hex"),
    expectedPacketCombinedSha256: population.packet_combined_sha256,
    expectedPacketIds: population.resolutions.map((entry) => entry.packet_id),
    expectedPacketCount: population.packet_count,
  });
  await writeFile(path.resolve(outputPath), bytes);
  process.stdout.write(`${JSON.stringify({
    reviewer_label: normalized.reviewer_label,
    packet_count: normalized.packet_count,
    outcome_drift_count: 0,
    output_path: path.resolve(outputPath),
  })}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main().catch((error) => {
    process.stderr.write(`[normalize-reviewer] FAILED: ${error.message}\n`);
    process.exitCode = 1;
  });
}
