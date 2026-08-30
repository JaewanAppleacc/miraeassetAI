// Turn P3 clean-worktree requirement: runs all FOUR Agent variants,
// through the shared integration harness, against the REAL, already-
// approved v0.20-r3 bundle -- materialized read-only via
// domain/agent-comparison/seed-bundle-harness.mjs (unmodified, Turn P1)
// the same way tests/agent-comparison-real-bundle-smoke.test.mjs already
// does for STRUCTURED_FIRST alone. Queries broadly (no fixed question
// list) so this runs in a clean worktree with no git-untracked
// work/domain-seed/ dependency. Uses FAKE_DETERMINISTIC only -- no real
// network call, no API key.
import assert from "node:assert/strict";
import test from "node:test";
import { createSeedBundleHarness } from "../domain/agent-comparison/seed-bundle-harness.mjs";
import { runFourVariantComparison, REQUIRED_VARIANT_IDS } from "../domain/agent-comparison/integration/four-variant-comparison.mjs";
import { validateComparisonRecord } from "../domain/agent-comparison/integration/contracts.mjs";
import { computeAllAgentVariantRevisions } from "../domain/agent-comparison/integration/variant-revisions.mjs";
import { computeReleaseManifestSha256, EXPECTED_RELEASE_ID } from "../domain/agent-comparison/integration/release-pin.mjs";
import { createDeterministicFakeModelAdapter } from "../domain/agent-comparison/fake-model-adapter.mjs";
import "../domain/agent-comparison/integration/register-all-variants.mjs";

const BUDGET_LIMITS = Object.freeze({ maxHcxCalls: 0, maxRetrievals: 0, maxToolCalls: 50, timeoutMs: 30000 });
const MODEL_CONFIG = Object.freeze({
  schema_version: "0.1.0", model_config_id: "model_fake-deterministic-v1", kind: "FAKE_DETERMINISTIC",
  provider: "test-fixture", model: "deterministic-fake-v1",
});

let harness;
let sample;
let releaseManifestSha256;
const agentVariantRevisions = computeAllAgentVariantRevisions();

test.before(async () => {
  harness = await createSeedBundleHarness({ root: process.cwd() });
  releaseManifestSha256 = await computeReleaseManifestSha256({ root: process.cwd() });

  const probeQuery = {
    schema_version: "0.2.0", query_id: "query_integration_real_bundle_smoke_probe", execution_scope: "OFFICIAL",
    corpus_snapshot_id: harness.context.corpus_snapshot_id, fact_coverage_snapshot_id: harness.context.fact_coverage_snapshot_id,
    targets: ["FACT"], corp_codes: [],
    predicates: { metric_codes: [], event_types: [], relation_types: [], document_ids: [], fact_ids: [], event_ids: [], relation_ids: [], evidence_ids: [] },
    period_filter: { start: null, end: null, period_types: [] }, scope_filter: [],
    verification_statuses: ["VERIFIED"], as_of_date: "2030-01-01", limit: 1,
  };
  const probeResult = await harness.serviceAdapters.structuredStoreAdapter.query(probeQuery);
  assert.equal(probeResult.status, "OK", "the real v0.20-r3 bundle must expose at least one VERIFIED Fact");
  sample = probeResult.records[0].payload;
});

test.after(async () => {
  if (harness) await harness.dispose();
});

function runAgainstRealBundle(overrides = {}) {
  return runFourVariantComparison({
    variantIds: REQUIRED_VARIANT_IDS,
    modelAdapterFactory: () => createDeterministicFakeModelAdapter({
      responder: () => ({ text: `값은 ${sample.normalized_value}입니다.`, used_fact_ids: [sample.fact_id], used_evidence_ids: sample.evidence_ids }),
    }),
    agentVariantRevisions,
    modelConfig: MODEL_CONFIG,
    releaseId: EXPECTED_RELEASE_ID,
    releaseManifestSha256,
    input: { question: "real bundle four-variant smoke question", question_id: "q_integration_real_bundle_01", hints: { corp_codes: [sample.corp_code], metric_codes: [sample.metric_code] } },
    context: { ...harness.context, as_of_date: "2030-01-01" },
    budgetLimits: BUDGET_LIMITS,
    serviceAdapters: harness.serviceAdapters,
    benchmarkRunId: "benchmark_run_integration_real_bundle_smoke",
    ...overrides,
  });
}

test("real bundle: all four variants run over the same real VERIFIED Fact, every record schema-valid, same release pin", async () => {
  const records = await runAgainstRealBundle();
  assert.equal(records.length, 4);
  for (const record of records) {
    assert.deepEqual(validateComparisonRecord(record), [], record.agent_variant_id);
    assert.equal(record.release_id, "seed-release-v0.20");
    assert.match(record.release_manifest_sha256, /^[0-9a-f]{64}$/);
  }
  assert.equal(new Set(records.map((r) => r.release_manifest_sha256)).size, 1);
  assert.equal(new Set(records.map((r) => r.model_config_sha256)).size, 1);
});

test("real bundle: STRUCTURED_FIRST and HYBRID_RETRIEVAL both PASS citation binding on the same real, fully-evidenced Fact (HYBRID_RETRIEVAL finds no grounding gap, so it never calls the Retriever either)", async () => {
  const records = await runAgainstRealBundle({ variantIds: ["STRUCTURED_FIRST", "HYBRID_RETRIEVAL"] });
  const byId = Object.fromEntries(records.map((r) => [r.agent_variant_id, r]));
  assert.equal(byId.STRUCTURED_FIRST.citation_binding_status, "PASS");
  assert.equal(byId.HYBRID_RETRIEVAL.citation_binding_status, "PASS");
  assert.equal(byId.HYBRID_RETRIEVAL.document_retrieval_count, 0);
  assert.equal(byId.STRUCTURED_FIRST.answer_sha256, byId.HYBRID_RETRIEVAL.answer_sha256, "no grounding gap exists for this Fact, so both variants should produce the identical grounded answer");
});

test("real bundle: a hallucinated number never present in the real VERIFIED Fact/Evidence is rejected fail-closed for every variant that reaches a model call", async () => {
  const records = await runAgainstRealBundle({
    modelAdapterFactory: () => createDeterministicFakeModelAdapter({
      responder: () => ({ text: "값은 999,999,999,999,999입니다.", used_fact_ids: [sample.fact_id], used_evidence_ids: sample.evidence_ids }),
    }),
  });
  for (const record of records) {
    if (record.model_call_attempt_count > 0) {
      assert.equal(record.citation_binding_status, "FAIL", `${record.agent_variant_id} should have rejected the hallucinated number`);
      assert.equal(record.scoring_eligible, false);
    }
  }
});

test("real bundle: running the four variants in two different orders produces identical per-variant answer_sha256/execution_trace_sha256", async () => {
  const forward = await runAgainstRealBundle({ variantIds: REQUIRED_VARIANT_IDS });
  const reversed = await runAgainstRealBundle({ variantIds: [...REQUIRED_VARIANT_IDS].reverse() });
  const byIdForward = Object.fromEntries(forward.map((r) => [r.agent_variant_id, r]));
  const byIdReversed = Object.fromEntries(reversed.map((r) => [r.agent_variant_id, r]));
  for (const variantId of REQUIRED_VARIANT_IDS) {
    assert.equal(byIdForward[variantId].answer_sha256, byIdReversed[variantId].answer_sha256, variantId);
    assert.equal(byIdForward[variantId].execution_trace_sha256, byIdReversed[variantId].execution_trace_sha256, variantId);
  }
});
