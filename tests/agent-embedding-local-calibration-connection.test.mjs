// Turn P9.2: Frozen 3-Model Local Calibration Connection tests. Every
// "server" here is tests/lib/mock-loopback-embedding-server.mjs -- a real
// TCP server bound ONLY to 127.0.0.1, returning purely deterministic fake
// vectors. No model is ever downloaded, no real embedding API is ever
// called, and no test here binds to or dials any non-loopback address.
import assert from "node:assert/strict";
import test from "node:test";
import { startMockLoopbackEmbeddingServer } from "./lib/mock-loopback-embedding-server.mjs";
import {
  getFrozenCandidateById, toCalibrationConfig, prepareTextForMode,
} from "../domain/agent-comparison/embedding-calibration/frozen-candidates/registry.mjs";
import { runEmbeddingCalibration } from "../domain/agent-comparison/embedding-calibration/runner.mjs";
import { CalibrationBudgetExceededError } from "../domain/agent-comparison/embedding-calibration/contracts.mjs";
import { createEmbeddingAdapter, EmbeddingAdapterUnavailableError } from "../domain/agent-comparison/retrieval/embedding-adapter.mjs";
import { buildCalibrationRunManifest, computePrefixPolicySha256 } from "../domain/agent-comparison/embedding-calibration/report.mjs";
import { computeFrozenCandidateRegistrySha256 } from "../domain/agent-comparison/embedding-calibration/frozen-candidates/registry.mjs";

function itemsFor(n, { corpCode = "00000001", textPrefix = "text" } = {}) {
  return Array.from({ length: n }, (_, i) => ({
    calibrationItemId: `calitem_${i}`, factId: `fact_${i}`, evidenceId: `evidence_${i}`,
    sourceDocumentId: `doc_${i}`, corpCode, inputTextSha256: `sha_${i}`,
    expectedSelfMatchId: `calitem_${i}`, textContent: `${textPrefix} ${i}`,
  }));
}

async function withServer(candidate, overrides, fn) {
  const server = await startMockLoopbackEmbeddingServer({
    info: {
      repository_id: candidate.repository_id, model_revision: candidate.immutable_revision,
      dimension: candidate.embedding_dimension, max_input_length: candidate.max_input_length, ready: true,
    },
    dimension: candidate.embedding_dimension,
    ...overrides,
  });
  try {
    return await fn(server);
  } finally {
    await server.close();
  }
}

function configFor(candidate, server, overrides = {}) {
  return toCalibrationConfig(candidate, {
    datasetManifestSha256: "a".repeat(64), sampleSalt: "s", codeRevision: "r",
    maximumItemCount: 10, maximumRequestCount: 10, maximumTotalInputUnits: 100000,
    batchSize: 5, endpointOverride: server.embeddingsUrl, authMode: "NONE",
    serverInfoUrlOverride: server.infoUrl, callerRequestsAuthorization: true,
    ...overrides,
  });
}

// =====================================================================
// 1-3: normal handshake for each of the 3 frozen candidates
// =====================================================================

test("1. KURE-v1: normal handshake succeeds, query and document embed the SAME text identically", async () => {
  const kure = getFrozenCandidateById("kure_v1");
  await withServer(kure, {}, async (server) => {
    const config = configFor(kure, server);
    const items = itemsFor(3);
    const result = await runEmbeddingCalibration({
      calibrationConfig: config, datasetItems: items, isMockServer: true,
      prepareText: (text, mode) => prepareTextForMode(kure, text, mode),
    });
    assert.equal(result.run_status, "SUCCESS");
    assert.ok(server.infoCallCount >= 2, "preflight AND post-run handshake must both have run");
    for (const call of server.embedCallsLog) assert.deepEqual(call.input, itemsFor(3).map((i) => i.textContent).filter((t) => call.input.includes(t)));
    assert.deepEqual(server.embedCallsLog[0].input.sort(), server.embedCallsLog[1].input.sort(), "KURE-v1's document-mode and query-mode inputs must be textually identical (no prefix on either side)");
  });
});

test("2. BGE-M3: normal handshake succeeds, query and document embed the SAME text identically", async () => {
  const bge = getFrozenCandidateById("bge_m3");
  await withServer(bge, {}, async (server) => {
    const config = configFor(bge, server);
    const items = itemsFor(3);
    const result = await runEmbeddingCalibration({
      calibrationConfig: config, datasetItems: items, isMockServer: true,
      prepareText: (text, mode) => prepareTextForMode(bge, text, mode),
    });
    assert.equal(result.run_status, "SUCCESS");
    assert.deepEqual(server.embedCallsLog[0].input.sort(), server.embedCallsLog[1].input.sort(), "BGE-M3's document-mode and query-mode inputs must be textually identical (no prefix on either side)");
  });
});

test("3. PIXIE-Rune-v1.5: normal handshake succeeds", async () => {
  const pixie = getFrozenCandidateById("pixie_rune");
  await withServer(pixie, {}, async (server) => {
    const config = configFor(pixie, server);
    const items = itemsFor(2);
    const result = await runEmbeddingCalibration({
      calibrationConfig: config, datasetItems: items, isMockServer: true,
      prepareText: (text, mode) => prepareTextForMode(pixie, text, mode),
    });
    assert.equal(result.run_status, "SUCCESS");
    assert.equal(result.server_identity_attestation_sha256.length, 64);
  });
});

// =====================================================================
// 4-5: PIXIE prefix application exactness
// =====================================================================

test("4. PIXIE-Rune: 'query: ' is applied to the query embedding exactly once per item, never duplicated or omitted", async () => {
  const pixie = getFrozenCandidateById("pixie_rune");
  await withServer(pixie, {}, async (server) => {
    const config = configFor(pixie, server);
    const items = itemsFor(2, { textPrefix: "고유 텍스트" });
    await runEmbeddingCalibration({
      calibrationConfig: config, datasetItems: items, isMockServer: true,
      prepareText: (text, mode) => prepareTextForMode(pixie, text, mode),
    });
    const queryCall = server.embedCallsLog.find((c) => c.input.some((t) => t.startsWith("query: ")));
    assert.ok(queryCall, "at least one call must carry the query-mode prefix");
    for (const text of queryCall.input) {
      assert.equal((text.match(/query: /g) ?? []).length, 1, `"${text}" must contain the prefix exactly once`);
    }
  });
});

test("5. PIXIE-Rune: document-mode input never carries the query prefix", async () => {
  const pixie = getFrozenCandidateById("pixie_rune");
  await withServer(pixie, {}, async (server) => {
    const config = configFor(pixie, server);
    const items = itemsFor(2, { textPrefix: "고유 문서 텍스트" });
    await runEmbeddingCalibration({
      calibrationConfig: config, datasetItems: items, isMockServer: true,
      prepareText: (text, mode) => prepareTextForMode(pixie, text, mode),
    });
    const documentCall = server.embedCallsLog.find((c) => c.input.every((t) => !t.startsWith("query: ")));
    assert.ok(documentCall, "the document-mode call must exist and carry NO prefix at all");
    assert.deepEqual(documentCall.input.sort(), items.map((i) => i.textContent).sort());
  });
});

// =====================================================================
// 6-11: identity mismatch / malformed / unavailable -> POST 0
// =====================================================================

async function assertZeroPostOnHandshakeFailure(candidate, serverOverrides, expectedFailureCode) {
  await withServer(candidate, serverOverrides, async (server) => {
    const config = configFor(candidate, server);
    const items = itemsFor(2);
    const result = await runEmbeddingCalibration({
      calibrationConfig: config, datasetItems: items, isMockServer: true,
      prepareText: (text, mode) => prepareTextForMode(candidate, text, mode),
    });
    assert.equal(result.run_status, "FAILED");
    assert.equal(result.failure_code, expectedFailureCode);
    assert.equal(server.embedCallCount, 0, "zero POSTs to /v1/embeddings must have occurred");
  });
}

test("6. wrong model ID at /info -> zero embedding POSTs", async () => {
  const kure = getFrozenCandidateById("kure_v1");
  await assertZeroPostOnHandshakeFailure(kure, { info: { repository_id: "some-other/model", model_revision: kure.immutable_revision, dimension: kure.embedding_dimension, max_input_length: kure.max_input_length, ready: true } }, "SERVER_IDENTITY_MODEL_ID_MISMATCH");
});

test("7. wrong revision at /info -> zero embedding POSTs", async () => {
  const kure = getFrozenCandidateById("kure_v1");
  await assertZeroPostOnHandshakeFailure(kure, { info: { repository_id: kure.repository_id, model_revision: "f".repeat(40), dimension: kure.embedding_dimension, max_input_length: kure.max_input_length, ready: true } }, "SERVER_IDENTITY_REVISION_MISMATCH");
});

test("8. wrong dimension at /info -> zero embedding POSTs", async () => {
  const kure = getFrozenCandidateById("kure_v1");
  await assertZeroPostOnHandshakeFailure(kure, { info: { repository_id: kure.repository_id, model_revision: kure.immutable_revision, dimension: 42, max_input_length: kure.max_input_length, ready: true } }, "SERVER_IDENTITY_DIMENSION_MISMATCH");
});

test("9. insufficient max_input_length at /info -> zero embedding POSTs", async () => {
  const kure = getFrozenCandidateById("kure_v1");
  await assertZeroPostOnHandshakeFailure(kure, { info: { repository_id: kure.repository_id, model_revision: kure.immutable_revision, dimension: kure.embedding_dimension, max_input_length: 1, ready: true } }, "SERVER_IDENTITY_MAX_LENGTH_INSUFFICIENT");
});

test("10. malformed /info JSON -> zero embedding POSTs", async () => {
  const kure = getFrozenCandidateById("kure_v1");
  await assertZeroPostOnHandshakeFailure(kure, { infoResponseOverride: "malformed" }, "SERVER_INFO_MALFORMED");
});

test("11. unavailable /info (route missing / connection reset) -> zero embedding POSTs", async () => {
  const kure = getFrozenCandidateById("kure_v1");
  await assertZeroPostOnHandshakeFailure(kure, { infoResponseOverride: "missing" }, "SERVER_INFO_UNAVAILABLE");
});

test("server not-ready at /info -> zero embedding POSTs", async () => {
  const kure = getFrozenCandidateById("kure_v1");
  await assertZeroPostOnHandshakeFailure(kure, { info: { repository_id: kure.repository_id, model_revision: kure.immutable_revision, dimension: kure.embedding_dimension, max_input_length: kure.max_input_length, ready: false } }, "SERVER_NOT_READY");
});

// =====================================================================
// 12-14: NONE/BEARER_ENV auth boundary
// =====================================================================

test("12. auth_mode=NONE against a loopback endpoint is allowed", async () => {
  const kure = getFrozenCandidateById("kure_v1");
  await withServer(kure, {}, async (server) => {
    const config = configFor(kure, server, { authMode: "NONE" });
    assert.equal(config.auth_mode, "NONE");
    const result = await runEmbeddingCalibration({
      calibrationConfig: config, datasetItems: itemsFor(1), isMockServer: true,
      prepareText: (text, mode) => prepareTextForMode(kure, text, mode),
    });
    assert.equal(result.run_status, "SUCCESS");
    assert.equal(server.embedCallsLog[0].authorization, null, "auth_mode=NONE must send no Authorization header at all");
  });
});

test("13. auth_mode=NONE against an external (non-loopback) host is refused before any request, at adapter construction time", () => {
  const kure = getFrozenCandidateById("kure_v1");
  const config = toCalibrationConfig(kure, {
    datasetManifestSha256: "a".repeat(64), sampleSalt: "s", codeRevision: "r",
    maximumItemCount: 10, maximumRequestCount: 10, maximumTotalInputUnits: 100000,
    endpointOverride: "https://example.com/v1/embeddings", authMode: "NONE", callerRequestsAuthorization: true,
  });
  let fetchCalled = false;
  assert.throws(
    () => createEmbeddingAdapter(
      { schema_version: "0.1.0", kind: config.adapter_kind, provider: config.provider_id, model: config.model_id, revision: "r", dimension: config.expected_dimension, endpoint_url: config.endpoint, auth_mode: "NONE" },
      { fetchImpl: async () => { fetchCalled = true; throw new Error("must never be called"); } },
    ),
    EmbeddingAdapterUnavailableError,
  );
  assert.equal(fetchCalled, false);
});

test("14. auth_mode=BEARER_ENV (the default) with no API key set fails closed (throws, per the SAME pre-flight-construction convention Turn P9 already established), zero POSTs", async () => {
  const kure = getFrozenCandidateById("kure_v1");
  delete process.env.P92_TEST_UNSET_KEY;
  await withServer(kure, {}, async (server) => {
    const config = configFor(kure, server, { authMode: undefined, apiKeyEnvVar: "P92_TEST_UNSET_KEY" });
    await assert.rejects(
      () => runEmbeddingCalibration({
        calibrationConfig: config, datasetItems: itemsFor(1), isMockServer: true,
        prepareText: (text, mode) => prepareTextForMode(kure, text, mode),
      }),
      EmbeddingAdapterUnavailableError,
    );
    assert.equal(server.embedCallCount, 0);
  });
});

// =====================================================================
// 15: identity drift mid-run
// =====================================================================

test("15. server identity drifting DURING a run (revision changes between preflight and post-run check) invalidates the result", async () => {
  const kure = getFrozenCandidateById("kure_v1");
  await withServer(kure, {}, async (server) => {
    const config = configFor(kure, server);
    const items = itemsFor(2);
    let calledOnce = false;
    const realFetch = fetch;
    const fetchImpl = async (url, opts) => {
      const response = await realFetch(url, opts);
      if (String(url).endsWith("/info") && !calledOnce) {
        calledOnce = true; // let the FIRST (preflight) /info call through untouched
      } else if (String(url).endsWith("/v1/embeddings")) {
        server.setInfo({ model_revision: "d".repeat(40) }); // drift AFTER embeddings are requested, before the post-run check
      }
      return response;
    };
    const result = await runEmbeddingCalibration({
      calibrationConfig: config, datasetItems: items, isMockServer: true, fetchImpl,
      prepareText: (text, mode) => prepareTextForMode(kure, text, mode),
    });
    assert.equal(result.run_status, "INVALID_SERVER_IDENTITY_DRIFT");
    assert.equal(result.quality, null, "a drifted run's embeddings can never be used for scoring/selection");
  });
});

// =====================================================================
// 16-17: vector validation / budget caps still enforced with the mock server
// =====================================================================

test("16. dimension/finite/order checks still apply against a real (mock) server response", async () => {
  const kure = getFrozenCandidateById("kure_v1");
  const server = await startMockLoopbackEmbeddingServer({
    info: { repository_id: kure.repository_id, model_revision: kure.immutable_revision, dimension: kure.embedding_dimension, max_input_length: kure.max_input_length, ready: true },
    dimension: 3, // WRONG on purpose -- server actually returns 3-dim vectors, candidate expects 1024
  });
  try {
    const config = configFor(kure, server);
    const result = await runEmbeddingCalibration({
      calibrationConfig: config, datasetItems: itemsFor(1), isMockServer: true,
      prepareText: (text, mode) => prepareTextForMode(kure, text, mode),
    });
    assert.equal(result.run_status, "FAILED");
  } finally {
    await server.close();
  }
});

test("17. budget caps are still enforced (maximum_item_count) even when a real mock server is reachable and correctly pinned", async () => {
  const kure = getFrozenCandidateById("kure_v1");
  await withServer(kure, {}, async (server) => {
    const config = configFor(kure, server, { maximumItemCount: 1 });
    await assert.rejects(
      () => runEmbeddingCalibration({
        calibrationConfig: config, datasetItems: itemsFor(3), isMockServer: true,
        prepareText: (text, mode) => prepareTextForMode(kure, text, mode),
      }),
      CalibrationBudgetExceededError,
    );
    assert.equal(server.embedCallCount, 0);
  });
});

// =====================================================================
// 18: raw response / API key / vector non-storage
// =====================================================================

test("18. the returned result never stores the raw /info response, the raw embeddings response, an API key, or a full vector array", async () => {
  const kure = getFrozenCandidateById("kure_v1");
  const SECRET = "sk-p92-secret-should-never-leak-99999";
  process.env.P92_TEST_SECRET_KEY = SECRET;
  try {
    await withServer(kure, {}, async (server) => {
      const config = configFor(kure, server, { authMode: "BEARER_ENV", apiKeyEnvVar: "P92_TEST_SECRET_KEY" });
      const result = await runEmbeddingCalibration({
        calibrationConfig: config, datasetItems: itemsFor(2), isMockServer: true,
        prepareText: (text, mode) => prepareTextForMode(kure, text, mode),
      });
      const serialized = JSON.stringify(result);
      assert.ok(!serialized.includes(SECRET));
      assert.ok(!/-?0\.\d+,-?0\.\d+,-?0\.\d+,-?0\.\d+/.test(serialized), "no vector-shaped array");
      assert.equal(typeof result.server_identity_attestation_sha256, "string");
      assert.match(result.server_identity_attestation_sha256, /^[0-9a-f]{64}$/, "only a SHA, never the raw /info body, is retained");
    });
  } finally {
    delete process.env.P92_TEST_SECRET_KEY;
  }
});

// =====================================================================
// Telemetry semantics (Section G)
// =====================================================================

test("telemetry: a mock loopback run reports loopback_protocol_test_performed=true, mock_embedding_call_performed=true, actual_model_embedding_call_performed=false, actual_external_embedding_call_performed=false", async () => {
  const kure = getFrozenCandidateById("kure_v1");
  await withServer(kure, {}, async (server) => {
    const config = configFor(kure, server);
    const result = await runEmbeddingCalibration({
      calibrationConfig: config, datasetItems: itemsFor(1), isMockServer: true,
      prepareText: (text, mode) => prepareTextForMode(kure, text, mode),
    });
    assert.equal(result.loopback_protocol_test_performed, true);
    assert.equal(result.mock_embedding_call_performed, true);
    assert.equal(result.actual_model_embedding_call_performed, false);
    assert.equal(result.actual_external_embedding_call_performed, false);
    assert.equal(result.dev_gold_accessed, false);
    assert.equal(result.holdout_accessed, false);
    assert.equal(result.final_model_selected, false);
  });
});

test("telemetry: an EXTERNAL-hostname HTTP call (fake fetchImpl, no real network) still reports actual_external_embedding_call_performed=true and loopback flags false -- proving the two are mutually exclusive, not both defaulted true", async () => {
  const kure = getFrozenCandidateById("kure_v1");
  process.env.P92_EXTERNAL_TEST_KEY = "fake-key";
  try {
    const config = toCalibrationConfig(kure, {
      datasetManifestSha256: "a".repeat(64), sampleSalt: "s", codeRevision: "r",
      maximumItemCount: 10, maximumRequestCount: 10, maximumTotalInputUnits: 100000,
      endpointOverride: "https://example.invalid/v1/embeddings", apiKeyEnvVar: "P92_EXTERNAL_TEST_KEY",
      callerRequestsAuthorization: true,
    });
    const result = await runEmbeddingCalibration({
      calibrationConfig: config, datasetItems: itemsFor(1),
      fetchImpl: async (url, { body }) => {
        const { input } = JSON.parse(body);
        return { ok: true, json: async () => ({ data: input.map(() => ({ embedding: new Array(1024).fill(0.01) })) }) };
      },
    });
    assert.equal(result.run_status, "SUCCESS");
    assert.equal(result.actual_external_embedding_call_performed, true);
    assert.equal(result.loopback_protocol_test_performed, false);
    assert.equal(result.mock_embedding_call_performed, false);
  } finally {
    delete process.env.P92_EXTERNAL_TEST_KEY;
  }
});

// =====================================================================
// Zero network / model download guarantee for this whole file
// =====================================================================

test("no test in this file ever binds to or is reachable from a non-loopback address (sanity: every mock server URL used above is 127.0.0.1)", async () => {
  const kure = getFrozenCandidateById("kure_v1");
  await withServer(kure, {}, async (server) => {
    assert.match(server.baseUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
  });
});

// =====================================================================
// Section H: run manifest pin fields
// =====================================================================

test("run manifest for a frozen-candidate run includes frozen_candidate_id/repository_id/immutable_revision/registry_sha256/prefix_policy_sha256/server_identity_attestation_sha256", async () => {
  const kure = getFrozenCandidateById("kure_v1");
  await withServer(kure, {}, async (server) => {
    const config = configFor(kure, server);
    const result = await runEmbeddingCalibration({
      calibrationConfig: config, datasetItems: itemsFor(1), isMockServer: true,
      prepareText: (text, mode) => prepareTextForMode(kure, text, mode),
    });
    const registrySha256 = computeFrozenCandidateRegistrySha256();
    const manifest = buildCalibrationRunManifest({
      calibrationConfig: config, datasetManifest: { item_count: 1, distinct_evidence_count: 1 },
      codeRevision: "r", frozenCandidate: kure, registrySha256, runResult: result,
    });
    assert.equal(manifest.frozen_candidate_id, "kure_v1");
    assert.equal(manifest.repository_id, "nlpai-lab/KURE-v1");
    assert.equal(manifest.immutable_revision, "4ed4540949c70b7da2c74004a915e1f2d5e46e4f");
    assert.equal(manifest.registry_sha256, registrySha256);
    assert.equal(manifest.server_identity_attestation_sha256, result.server_identity_attestation_sha256);
    assert.match(manifest.prefix_policy_sha256, /^[0-9a-f]{64}$/);
    assert.deepEqual(manifest.query_document_modes, ["SYMMETRIC"]);
  });
});

test("run manifest never repeats raw dataset text or an API key -- only IDs and SHAs", async () => {
  const kure = getFrozenCandidateById("kure_v1");
  await withServer(kure, {}, async (server) => {
    const config = configFor(kure, server);
    const secretLookingText = "XYZZY-DO-NOT-LEAK-IN-MANIFEST";
    const items = itemsFor(1, { textPrefix: secretLookingText });
    const result = await runEmbeddingCalibration({
      calibrationConfig: config, datasetItems: items, isMockServer: true,
      prepareText: (text, mode) => prepareTextForMode(kure, text, mode),
    });
    const manifest = buildCalibrationRunManifest({
      calibrationConfig: config, datasetManifest: { item_count: 1, distinct_evidence_count: 1 },
      codeRevision: "r", frozenCandidate: kure, registrySha256: computeFrozenCandidateRegistrySha256(), runResult: result,
    });
    assert.ok(!JSON.stringify(manifest).includes(secretLookingText));
  });
});

test("two runs of the SAME model NAME but DIFFERENT revision produce different manifest model_id/immutable_revision (treated as different runs)", async () => {
  const kure = getFrozenCandidateById("kure_v1");
  const otherRevisionCandidate = { ...kure, immutable_revision: "b".repeat(40) };
  const configA = toCalibrationConfig(kure, { datasetManifestSha256: "a".repeat(64), sampleSalt: "s", codeRevision: "r", maximumItemCount: 1, maximumRequestCount: 1, maximumTotalInputUnits: 1000 });
  const configB = toCalibrationConfig(otherRevisionCandidate, { datasetManifestSha256: "a".repeat(64), sampleSalt: "s", codeRevision: "r", maximumItemCount: 1, maximumRequestCount: 1, maximumTotalInputUnits: 1000 });
  assert.notEqual(configA.model_id, configB.model_id, "model_id must encode the revision, so a revision change is never mistaken for the same run identity");
});

test("computePrefixPolicySha256 is identical for two different candidates sharing the SAME (query_prefix, document_prefix) pair, and differs when either changes", () => {
  const kureSha = computePrefixPolicySha256({ queryPrefix: "", documentPrefix: "" });
  const bgeSha = computePrefixPolicySha256({ queryPrefix: "", documentPrefix: "" });
  const pixieSha = computePrefixPolicySha256({ queryPrefix: "query: ", documentPrefix: "" });
  assert.equal(kureSha, bgeSha, "the SAME prefix policy (both symmetric/empty) must hash identically across different candidates");
  assert.notEqual(kureSha, pixieSha);
});
