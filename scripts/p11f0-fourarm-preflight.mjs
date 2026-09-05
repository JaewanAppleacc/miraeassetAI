#!/usr/bin/env node
// Turn AC-OFFICIAL-INTEGRATION-V1 / FOURARM-INTEGRATION-OWNER-DECISION-AND-
// EXECUTION-GATE: real preflight run for all four arms. Gathers live A/C
// readiness, imported B/D reference identity, the Owner's ratified
// resolutions artifact, and the shared conditions/universe/cutoff pins
// into one manifest via the pure domain/agent-comparison/four-arm-ac/
// four-arm-preflight.mjs assembler. Does NOT execute any evaluation (no
// HCX/retrieval/scoring calls), does NOT touch DEV_CHECK/HOLDOUT, and does
// NOT perform production wiring.
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import pg from "pg";
import { createArmRetrieverAdapter } from "../domain/agent-comparison/four-arm-ac/arm-retriever-adapter.mjs";
import { validateOfficialConditionsV2Artifact, validateOfficialUniverseArtifact } from "../domain/agent-comparison/four-arm-ac/official-conditions-v2-importer.mjs";
import { validateOwnerResolutionsArtifact } from "../domain/agent-comparison/four-arm-ac/four-arm-owner-resolutions-importer.mjs";
import { assembleFourArmPreflightManifest } from "../domain/agent-comparison/four-arm-ac/four-arm-preflight.mjs";
import { computeBatchId } from "../domain/agent-comparison/four-arm-ac/four-arm-run-ledger.mjs";
import { RETRIEVAL_OUTPUT_K, PRIMARY_EVALUATION_K, REPORTED_CUTOFFS } from "../domain/agent-comparison/four-arm-ac/four-arm-cutoff-contract.mjs";

const { Client } = pg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const OFFICIAL_DIR = path.join(REPO_ROOT, "domain/agent-comparison/four-arm-ac/official");

const EXPECTED_CONDITIONS_SHA256 = "83d5b8a02de2e3e79e388ec417ed104c81b08eb0a8dc8a8366b020df36b5e527";
const EXPECTED_UNIVERSE_SHA256 = "96560165c836b10e315cb253ab96a99b369478c3f71a0415d16b7b6fadbfa1dc";
const EXPECTED_OWNER_RESOLUTIONS_FILE_SHA256 = "90940c7d514220169c2873d14a3aecd1dda328b8782b808697f65036b6cceeba";
const EXPECTED_OWNER_RESOLUTIONS_PACKET_COMBINED_SHA256 = "e65cf7f5372cb007f4e94ef70542a0492ee147d980dea5d56f22c7ffc0c3b2a4";
const EXPECTED_OWNER_RESOLUTIONS_DISTRIBUTION = { critical: 2, ARM_SPECIFIC: 2, COMMON_SOURCE: 0, UNKNOWN: 15 };
const EXPECTED_OWNER_RESOLUTIONS_CRITICAL_IDS = ["u-1b6cd184a87f", "u-8564414f6080"];
const LOAD_SESSION_ID = "fixed_kure_attempt_23b88aea167c04400bf77a1a58839f2e";
const PROVENANCE_LOAD_SESSION_ID = "fixed_kure_attempt_c7ee3363a0af161c7a0572d024dfbf36";
const RETRIEVAL_INDEX_ID = "fixed_kure_index_8fe191342205848d1d6a6123f38a54e7";
const BM25_DOCUMENT_COUNT = 442549; // cross-checked against the persisted BM25 cache header + config.A.json's own bm25.document_count pin
const BD_RESULTS_SHA256 = {
  B: "de661a1cbd20d8de268e24b84ccac8ab41feeace0af2502891d401a2c0898985",
  D: "0f1112219d28442115f0bc07924d580320c40303b365ef1f2325fc5afa29cf6b",
};

function sha256File(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

async function readArmConfig(name) {
  const p = path.join(REPO_ROOT, "domain/agent-comparison/four-arm-ac", name);
  const raw = await readFile(p);
  return { raw, json: JSON.parse(raw.toString("utf8")), sha256: sha256File(raw) };
}

function gitHeadSha() {
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" }).trim();
}

async function buildArmReadiness({ client, arm }) {
  const bm25Index = Object.freeze({ documentCount: BM25_DOCUMENT_COUNT });
  const adapter = arm === "A"
    ? createArmRetrieverAdapter({
      arm: "A", client, bm25Index, retrievalIndexId: RETRIEVAL_INDEX_ID, loadSessionId: LOAD_SESSION_ID,
      provenanceLoadSessionId: PROVENANCE_LOAD_SESSION_ID,
      vectorRepository: { searchDocumentChunksByVector: async () => { throw new Error("not used by readiness()"); } },
      embeddingAdapter: { embedQuery: async () => { throw new Error("not used by readiness()"); } },
      expectedPins: { repository: "nlpai-lab/KURE-v1", revision: "4ed4540949c70b7da2c74004a915e1f2d5e46e4f", dimension: 1024 },
    })
    : createArmRetrieverAdapter({
      arm: "C", client, bm25Index, retrievalIndexId: RETRIEVAL_INDEX_ID, loadSessionId: LOAD_SESSION_ID,
      provenanceLoadSessionId: PROVENANCE_LOAD_SESSION_ID,
    });
  return adapter.readiness();
}

async function main() {
  const [conditionsRaw, universeRaw, ownerResolutionsRaw, configA, configC, bRunJsonRaw, dRunJsonRaw] = await Promise.all([
    readFile(path.join(OFFICIAL_DIR, "devtune101_conditions.v2.jsonl")),
    readFile(path.join(OFFICIAL_DIR, "universe.csv")),
    readFile(path.join(OFFICIAL_DIR, "resolutions.owner.json")),
    readArmConfig("config.A.json"),
    readArmConfig("config.C.json"),
    readFile(path.join(OFFICIAL_DIR, "B.run.json")),
    readFile(path.join(OFFICIAL_DIR, "D.run.json")),
  ]);

  const conditionsValidation = validateOfficialConditionsV2Artifact(conditionsRaw, { expectedSha256: EXPECTED_CONDITIONS_SHA256, expectedRowCount: 101 });
  const universeValidation = validateOfficialUniverseArtifact(universeRaw, { expectedSha256: EXPECTED_UNIVERSE_SHA256 });
  const ownerResolutionsValidation = validateOwnerResolutionsArtifact(ownerResolutionsRaw, {
    expectedFileSha256: EXPECTED_OWNER_RESOLUTIONS_FILE_SHA256,
    expectedPacketCombinedSha256: EXPECTED_OWNER_RESOLUTIONS_PACKET_COMBINED_SHA256,
    expectedDistribution: EXPECTED_OWNER_RESOLUTIONS_DISTRIBUTION,
    expectedCriticalPacketIds: EXPECTED_OWNER_RESOLUTIONS_CRITICAL_IDS,
  });

  const codeHeadSha256 = gitHeadSha();

  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  let armAReadiness;
  let armCReadiness;
  try {
    [armAReadiness, armCReadiness] = await Promise.all([
      buildArmReadiness({ client, arm: "A" }),
      buildArmReadiness({ client, arm: "C" }),
    ]);
  } finally {
    await client.end();
  }

  const batchId = computeBatchId({
    conditionsSha256: conditionsValidation.file_sha256,
    universeSha256: universeValidation.file_sha256,
    evaluationCutoffId: `${RETRIEVAL_OUTPUT_K}-${PRIMARY_EVALUATION_K}-${REPORTED_CUTOFFS.join(",")}`,
  });

  const manifest = assembleFourArmPreflightManifest({
    batchId,
    conditionsValidation, universeValidation, ownerResolutionsValidation,
    armA: {
      readiness: armAReadiness, codeHeadSha256, configSha256: configA.sha256,
      corpusManifestSha256: configA.json.corpus_manifest_sha256, indexSha256: configA.json.embedding_index_config_sha256,
      // executionState/resultsSha256/qualityMetrics intentionally omitted:
      // no real DEV_TUNE-101 run for arm A exists yet this Turn.
    },
    armC: {
      readiness: armCReadiness, codeHeadSha256, configSha256: configC.sha256,
      corpusManifestSha256: configC.json.corpus_manifest_sha256, indexSha256: configC.json.embedding_index_config_sha256,
    },
    armBRunJson: JSON.parse(bRunJsonRaw.toString("utf8")),
    armDRunJson: JSON.parse(dRunJsonRaw.toString("utf8")),
    armBResultsSha256: BD_RESULTS_SHA256.B,
    armDResultsSha256: BD_RESULTS_SHA256.D,
  });

  console.log(JSON.stringify(manifest, null, 2));
  return manifest;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`[fourarm-preflight] FAILED: ${error.stack ?? error.message}`);
    process.exitCode = 1;
  });
}

export { main };
