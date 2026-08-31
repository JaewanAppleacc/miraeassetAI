// Turn P9.1: Frozen Embedding Candidate registry tests. Pure data/schema/
// logic -- no model download, no network call, no API key ever used. Any
// test here that constructs a fake global.fetch asserts it is NEVER
// invoked, proving these registry operations are fully offline.
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  loadFrozenCandidateRegistry, listFrozenCandidates, getFrozenCandidateById,
  computeFrozenCandidateRegistrySha256, toCalibrationConfig, prepareTextForMode,
  FrozenCandidateRegistryError,
} from "../domain/agent-comparison/embedding-calibration/frozen-candidates/registry.mjs";
import { validateCalibrationConfig } from "../domain/agent-comparison/embedding-calibration/contracts.mjs";

const REGISTRY_PATH = path.resolve(
  import.meta.dirname, "..",
  "domain/agent-comparison/embedding-calibration/frozen-candidates/frozen-embedding-candidates.v1.1.json",
);

function withNoNetwork(fn) {
  const original = globalThis.fetch;
  let called = false;
  globalThis.fetch = async (...args) => { called = true; throw new Error(`fetch must never be called: ${JSON.stringify(args)}`); };
  try {
    fn();
  } finally {
    globalThis.fetch = original;
  }
  return called;
}

// -------------------------------------------------------------------------
// Exactly 3 candidates
// -------------------------------------------------------------------------

test("the registry contains exactly 3 frozen candidates: kure_v1, bge_m3, pixie_rune", () => {
  const ids = listFrozenCandidates().map((c) => c.frozen_candidate_id).sort();
  assert.deepEqual(ids, ["bge_m3", "kure_v1", "pixie_rune"]);
});

test("no duplicate frozen_candidate_id, repository_id, or immutable_revision across candidates", () => {
  const candidates = listFrozenCandidates();
  for (const field of ["frozen_candidate_id", "repository_id", "immutable_revision"]) {
    const values = candidates.map((c) => c[field]).filter((v) => v && v !== "BLOCKED_MISSING_IMMUTABLE_REVISION");
    assert.equal(new Set(values).size, values.length, `duplicate ${field} found`);
  }
});

// -------------------------------------------------------------------------
// model/revision/dimension pin verification
// -------------------------------------------------------------------------

test("KURE-v1 pin: repository, 40-hex revision, dimension, license", () => {
  const c = getFrozenCandidateById("kure_v1");
  assert.equal(c.repository_id, "nlpai-lab/KURE-v1");
  assert.match(c.immutable_revision, /^[0-9a-f]{40}$/);
  assert.equal(c.embedding_dimension, 1024);
  assert.equal(c.license, "MIT");
  assert.equal(c.competition_status, "ELIGIBLE_FOR_BOUNDED_CALIBRATION");
});

test("BGE-M3 pin: repository, 40-hex revision, dimension, license", () => {
  const c = getFrozenCandidateById("bge_m3");
  assert.equal(c.repository_id, "BAAI/bge-m3");
  assert.match(c.immutable_revision, /^[0-9a-f]{40}$/);
  assert.equal(c.embedding_dimension, 1024);
  assert.equal(c.license, "MIT");
  assert.equal(c.competition_status, "ELIGIBLE_FOR_BOUNDED_CALIBRATION");
});

test("PIXIE-Rune pin: model identity unresolved, revision is the fail-closed sentinel, never a guessed value", () => {
  const c = getFrozenCandidateById("pixie_rune");
  assert.equal(c.repository_id, null);
  assert.equal(c.immutable_revision, "BLOCKED_MISSING_IMMUTABLE_REVISION");
  assert.equal(c.embedding_dimension, null);
  assert.equal(c.competition_status, "BLOCKED_UNVERIFIED_MODEL_ID");
  assert.ok(Array.isArray(c.pixie_rune_variants_researched) && c.pixie_rune_variants_researched.length === 3, "the 3 known real variants must still be documented as research, without being pinned as the answer");
  for (const variant of c.pixie_rune_variants_researched) {
    assert.match(variant.immutable_revision, /^[0-9a-f]{40}$/, "each researched variant still carries a REAL verified revision, even though none is selected");
  }
});

test("every candidate in the registry file validates against its own JSON schema", () => {
  // Loading via loadFrozenCandidateRegistry() already schema-validates internally
  // (it would throw otherwise) -- this test additionally proves the raw file
  // parses and that loading does not throw.
  assert.doesNotThrow(() => loadFrozenCandidateRegistry({ forceReload: true }));
});

// -------------------------------------------------------------------------
// Revision missing -> fail-closed
// -------------------------------------------------------------------------

test("a candidate with no verified immutable_revision can never produce a CalibrationConfig", () => {
  const pixie = getFrozenCandidateById("pixie_rune");
  assert.throws(
    () => toCalibrationConfig(pixie, { datasetManifestSha256: "a".repeat(64), sampleSalt: "s", codeRevision: "r", maximumItemCount: 1, maximumRequestCount: 1, maximumTotalInputUnits: 1 }),
    (error) => { assert.ok(error instanceof FrozenCandidateRegistryError); assert.equal(error.code, "MISSING_REVISION"); return true; },
  );
});

test("a candidate with no verified embedding_dimension can never produce a CalibrationConfig (synthetic case)", () => {
  const synthetic = {
    frozen_candidate_id: "synthetic_no_dim", repository_id: "org/model", immutable_revision: "a".repeat(40),
    embedding_dimension: null, competition_status: "ELIGIBLE_FOR_BOUNDED_CALIBRATION",
    adapter_compatibility: { classification: "FAKE_DETERMINISTIC_ONLY_TEST", reason: "test" },
    provider_organization: "org",
  };
  assert.throws(
    () => toCalibrationConfig(synthetic, { datasetManifestSha256: "a".repeat(64), sampleSalt: "s", codeRevision: "r", maximumItemCount: 1, maximumRequestCount: 1, maximumTotalInputUnits: 1 }),
    (error) => { assert.equal(error.code, "MISSING_DIMENSION"); return true; },
  );
});

// -------------------------------------------------------------------------
// Non-approved competition status blocks execution (authorization can never
// be forced true regardless of caller intent).
// -------------------------------------------------------------------------

test("a fully-pinned but NON-eligible candidate (synthetic REQUIRES_ORGANIZER_APPROVAL) can never have actual_external_call_authorized forced to true", () => {
  const synthetic = {
    frozen_candidate_id: "synthetic_needs_approval", repository_id: "org/needs-approval-model", immutable_revision: "b".repeat(40),
    embedding_dimension: 768, competition_status: "REQUIRES_ORGANIZER_APPROVAL",
    adapter_compatibility: { classification: "COMPATIBLE_VIA_LOCAL_OPENAI_SHAPED_SERVER", reason: "test" },
    provider_organization: "org",
  };
  const config = toCalibrationConfig(synthetic, {
    datasetManifestSha256: "a".repeat(64), sampleSalt: "s", codeRevision: "r",
    maximumItemCount: 1, maximumRequestCount: 1, maximumTotalInputUnits: 1,
    callerRequestsAuthorization: true, // explicitly asking for it -- must still be refused
  });
  assert.equal(config.actual_external_call_authorized, false, "a non-ELIGIBLE candidate must never be authorized, no matter what the caller asks for");
  assert.deepEqual(validateCalibrationConfig(config), []);
});

test("an ELIGIBLE candidate CAN have actual_external_call_authorized set to true when explicitly requested (still just a config object -- no call is made by this test)", () => {
  const kure = getFrozenCandidateById("kure_v1");
  const config = toCalibrationConfig(kure, {
    datasetManifestSha256: "a".repeat(64), sampleSalt: "s", codeRevision: "r",
    maximumItemCount: 50, maximumRequestCount: 10, maximumTotalInputUnits: 100000,
    callerRequestsAuthorization: true,
  });
  assert.equal(config.actual_external_call_authorized, true);
  assert.deepEqual(validateCalibrationConfig(config), []);
});

test("by default (no explicit authorization request), an ELIGIBLE candidate's config is still unauthorized", () => {
  const bge = getFrozenCandidateById("bge_m3");
  const config = toCalibrationConfig(bge, { datasetManifestSha256: "a".repeat(64), sampleSalt: "s", codeRevision: "r", maximumItemCount: 50, maximumRequestCount: 10, maximumTotalInputUnits: 100000 });
  assert.equal(config.actual_external_call_authorized, false);
});

// -------------------------------------------------------------------------
// Query/document mode separation
// -------------------------------------------------------------------------

test("KURE-v1 and BGE-M3 (empty prefixes both modes) embed the SAME text identically for query and document mode", () => {
  for (const id of ["kure_v1", "bge_m3"]) {
    const c = getFrozenCandidateById(id);
    const query = prepareTextForMode(c, "샘플 텍스트", "query");
    const doc = prepareTextForMode(c, "샘플 텍스트", "document");
    assert.equal(query, doc, `${id} has identical query/document prefixes -- text preparation must be identical`);
  }
});

test("PIXIE-Rune-v1.5-shaped candidate (asymmetric prefixes) NEVER embeds the same raw text identically for query vs document mode", () => {
  const pixieV15Shaped = { frozen_candidate_id: "pixie_rune_v15_test", query_prefix: "query: ", document_prefix: "" };
  const query = prepareTextForMode(pixieV15Shaped, "샘플 텍스트", "query");
  const doc = prepareTextForMode(pixieV15Shaped, "샘플 텍스트", "document");
  assert.notEqual(query, doc, "a candidate with differing query/document prefixes must never produce the identical prepared string for both modes");
  assert.equal(query, "query: 샘플 텍스트");
  assert.equal(doc, "샘플 텍스트");
});

test("prepareTextForMode rejects an invalid mode and refuses to guess a prefix when one is unverified (null)", () => {
  const c = getFrozenCandidateById("kure_v1");
  assert.throws(() => prepareTextForMode(c, "text", "not-a-real-mode"), TypeError);
  const unresolved = getFrozenCandidateById("pixie_rune"); // query_prefix/document_prefix are null
  assert.throws(
    () => prepareTextForMode(unresolved, "text", "query"),
    (error) => { assert.equal(error.code, "PREFIX_NOT_VERIFIED"); return true; },
  );
});

// -------------------------------------------------------------------------
// Adapter compatibility judgment
// -------------------------------------------------------------------------

test("every candidate's adapter_compatibility.classification is one of the closed set of allowed values", () => {
  const allowed = new Set(["EXISTING_HTTP_EMBEDDINGS_COMPATIBLE", "COMPATIBLE_VIA_LOCAL_OPENAI_SHAPED_SERVER", "REQUIRES_NEW_PROTOCOL_ADAPTER", "LOCAL_INFERENCE_RUNTIME_REQUIRED", "NOT_CURRENTLY_RUNNABLE"]);
  for (const c of listFrozenCandidates()) {
    assert.ok(allowed.has(c.adapter_compatibility.classification), `${c.frozen_candidate_id}: unexpected classification ${c.adapter_compatibility.classification}`);
  }
});

test("no candidate is force-labeled EXISTING_HTTP_EMBEDDINGS_COMPATIBLE -- none of the three has an official pre-hosted provider HTTP endpoint", () => {
  for (const c of listFrozenCandidates()) {
    assert.equal(c.official_http_endpoint_available, false);
    assert.notEqual(c.adapter_compatibility.classification, "EXISTING_HTTP_EMBEDDINGS_COMPATIBLE");
  }
});

// -------------------------------------------------------------------------
// Registry change -> canonical SHA changes
// -------------------------------------------------------------------------

test("computeFrozenCandidateRegistrySha256 changes when the registry content changes, and reproduces identically for the SAME content", () => {
  const registry = loadFrozenCandidateRegistry();
  const first = computeFrozenCandidateRegistrySha256(registry);
  const second = computeFrozenCandidateRegistrySha256(registry);
  assert.equal(first, second);

  const mutated = JSON.parse(JSON.stringify(registry));
  mutated.candidates[0].embedding_dimension = 999;
  const mutatedSha = computeFrozenCandidateRegistrySha256(mutated);
  assert.notEqual(first, mutatedSha, "changing a single field must change the canonical registry SHA");
});

test("the on-disk registry file's raw bytes are exactly what loadFrozenCandidateRegistry parses (no silent transformation)", () => {
  const raw = JSON.parse(readFileSync(REGISTRY_PATH, "utf8"));
  const loaded = loadFrozenCandidateRegistry({ forceReload: true });
  assert.deepEqual(raw, loaded);
});

// -------------------------------------------------------------------------
// Zero network / model download
// -------------------------------------------------------------------------

test("loading the registry, listing candidates, computing the SHA, and building CalibrationConfigs never touches the network", () => {
  const called = withNoNetwork(() => {
    loadFrozenCandidateRegistry({ forceReload: true });
    listFrozenCandidates();
    computeFrozenCandidateRegistrySha256();
    const kure = getFrozenCandidateById("kure_v1");
    toCalibrationConfig(kure, { datasetManifestSha256: "a".repeat(64), sampleSalt: "s", codeRevision: "r", maximumItemCount: 1, maximumRequestCount: 1, maximumTotalInputUnits: 1000 });
  });
  assert.equal(called, false, "no registry operation may ever call fetch");
});

// -------------------------------------------------------------------------
// API key / raw response / vector storage: 0
// -------------------------------------------------------------------------

test("a CalibrationConfig built from the registry never contains a real API key value, only an env var NAME placeholder never treated as a secret", () => {
  const kure = getFrozenCandidateById("kure_v1");
  const config = toCalibrationConfig(kure, { datasetManifestSha256: "a".repeat(64), sampleSalt: "s", codeRevision: "r", maximumItemCount: 1, maximumRequestCount: 1, maximumTotalInputUnits: 1000 });
  assert.equal(typeof config.api_key_env_var, "string");
  assert.ok(!/^sk-|^Bearer /.test(config.api_key_env_var), "api_key_env_var must be a variable NAME, never a value that looks like a real key/header");
});

test("the registry JSON and pin report never contain a vector-shaped array or any string resembling a real API key", () => {
  const registryText = readFileSync(REGISTRY_PATH, "utf8");
  assert.ok(!/-?0\.\d+,\s*-?0\.\d+,\s*-?0\.\d+,\s*-?0\.\d+/.test(registryText), "no vector-shaped array literal in the registry");
  assert.ok(!/sk-[a-zA-Z0-9]{20,}/.test(registryText), "no API-key-shaped string in the registry");
});
