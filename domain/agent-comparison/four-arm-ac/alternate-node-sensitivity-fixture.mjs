// FOURARM-ALTERNATE-NODE-SENSITIVITY-HARNESS-V1: SYNTHETIC fixture builders
// for testing the sensitivity harness (population guard, reviewer artifact
// validator, reviewer comparison, adjudication adapter, report). None of
// these functions read, embed, or derive from any real reviewer output or
// real packet ID -- every packet ID here is generated from a loop counter,
// never a literal copied from real data (see
// results/ALTERNATE_NODE_SENSITIVITY_V1_AMENDMENT.md's non-leak/no-
// packet-ID-hardcoding requirement). This module must never be wired to a
// real DEV_TUNE/DEV_CHECK/HOLDOUT run or a real reviewer artifact.
import { createHash } from "node:crypto";
import {
  POPULATION_TEMPLATE_SCHEMA_VERSION,
  EXPECTED_POPULATION_REASON,
  EXPECTED_POPULATION_SCOPE,
} from "./alternate-node-sensitivity-population-guard.mjs";
import { SCHEMA_VERSION as REVIEWER_ARTIFACT_SCHEMA_VERSION, ACCEPTANCE_CONDITIONS } from "./alternate-node-sensitivity-reviewer-artifact-validator.mjs";

function sha256Hex(input) {
  return createHash("sha256").update(input).digest("hex");
}

// index -> a syntactically valid, non-real packet id (u-<12 lowercase hex>).
export function syntheticPacketId(index) {
  return `u-${index.toString(16).padStart(12, "0")}`;
}

export function buildSyntheticPopulationTemplate(packetCount, { scope = EXPECTED_POPULATION_SCOPE, reason = EXPECTED_POPULATION_REASON } = {}) {
  const resolutions = [];
  const combined = createHash("sha256");
  for (let i = 0; i < packetCount; i += 1) {
    const packetId = syntheticPacketId(i);
    const packetSha256 = sha256Hex(`synthetic-packet-body-${packetId}`);
    combined.update(Buffer.from(packetSha256, "utf8"));
    resolutions.push({
      packet_id: packetId,
      packet_sha256: packetSha256,
      classification: "UNKNOWN",
      sensitivity_outcome: "PENDING_REVIEW",
      critical: false,
      owner_confirmed: false,
      note: "",
    });
  }
  const template = {
    schema_version: POPULATION_TEMPLATE_SCHEMA_VERSION,
    reason,
    population_scope: scope,
    packet_count: resolutions.length,
    packet_combined_sha256: combined.digest("hex"),
    owner_confirmed: false,
    resolutions,
  };
  return { template, bytes: Buffer.from(JSON.stringify(template), "utf8") };
}

// outcomesByPacketId: Map/object packet_id -> one of the 4 sensitivity
// outcomes. Any packet_id present in `population.template.resolutions` but
// absent from outcomesByPacketId defaults to "UNKNOWN" with all acceptance
// checks false (a legitimately unresolved packet), unless the caller opts
// into `omitPacketIds` to deliberately build an incomplete artifact for
// negative tests.
export function buildSyntheticReviewerArtifact(population, {
  reviewerLabel,
  sourceHead,
  policySha256,
  outcomesByPacketId = {},
  omitPacketIds = [],
  extraPacketIds = [],
  overridePacketCombinedSha256 = null,
  overridePacketCount = null,
  overrideOwnerConfirmed = false,
} = {}) {
  const omit = new Set(omitPacketIds);
  const resolutions = population.template.resolutions
    .filter((entry) => !omit.has(entry.packet_id))
    .map((entry) => {
      const outcome = outcomesByPacketId[entry.packet_id] ?? "UNKNOWN";
      const allTrue = outcome === "SUPPORTED_ALTERNATE_NODE";
      const acceptance_checks = Object.fromEntries(ACCEPTANCE_CONDITIONS.map((key) => [key, allTrue]));
      return {
        packet_id: entry.packet_id,
        sensitivity_outcome: outcome,
        acceptance_checks,
        owner_confirmed: false,
        note: "",
      };
    });
  for (const extraId of extraPacketIds) {
    const outcome = outcomesByPacketId[extraId] ?? "UNKNOWN";
    const allTrue = outcome === "SUPPORTED_ALTERNATE_NODE";
    resolutions.push({
      packet_id: extraId,
      sensitivity_outcome: outcome,
      acceptance_checks: Object.fromEntries(ACCEPTANCE_CONDITIONS.map((key) => [key, allTrue])),
      owner_confirmed: false,
      note: "",
    });
  }

  const artifact = {
    schema_version: REVIEWER_ARTIFACT_SCHEMA_VERSION,
    reviewer_label: reviewerLabel,
    source_head: sourceHead,
    policy_sha256: policySha256,
    packet_combined_sha256: overridePacketCombinedSha256 ?? population.template.packet_combined_sha256,
    packet_count: overridePacketCount ?? resolutions.length,
    owner_confirmed: overrideOwnerConfirmed,
    resolutions,
  };
  return { artifact, bytes: Buffer.from(JSON.stringify(artifact), "utf8") };
}
