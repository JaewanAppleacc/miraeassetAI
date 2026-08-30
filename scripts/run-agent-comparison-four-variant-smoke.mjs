#!/usr/bin/env node
// Turn P3: runs all FOUR Agent variants (STRUCTURED_FIRST, HYBRID_RETRIEVAL,
// PLANNER, DOCUMENT_FIRST_RAG) over the SAME broadly-sampled real,
// approved v0.20-r3 Fact, prints one schema-valid ComparisonRecord per
// variant, and exits nonzero if any record fails schema validation or if
// any variant's own run_status is FAILED for an unexpected reason.
//
// Uses ONLY the FAKE_DETERMINISTIC ModelAdapter -- no real network call,
// no API key, ever. Does not decide a winner and does not compute a
// quality score; scoring_eligible=false rows are reported, never
// excluded/hidden, but never scored either.
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createSeedBundleHarness } from "../domain/agent-comparison/seed-bundle-harness.mjs";
import { runFourVariantComparison, REQUIRED_VARIANT_IDS } from "../domain/agent-comparison/integration/four-variant-comparison.mjs";
import { validateComparisonRecord } from "../domain/agent-comparison/integration/contracts.mjs";
import { computeAllAgentVariantRevisions } from "../domain/agent-comparison/integration/variant-revisions.mjs";
import { computeReleaseManifestSha256, EXPECTED_RELEASE_ID } from "../domain/agent-comparison/integration/release-pin.mjs";
import { createDeterministicFakeModelAdapter } from "../domain/agent-comparison/fake-model-adapter.mjs";
import "../domain/agent-comparison/integration/register-all-variants.mjs";

const ROOT = process.cwd();

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--out") out.outPath = argv[i + 1];
  }
  return out;
}

async function main() {
  const { outPath } = parseArgs(process.argv.slice(2));
  const harness = await createSeedBundleHarness({ root: ROOT });
  try {
    const releaseManifestSha256 = await computeReleaseManifestSha256({ root: ROOT });
    const probeQuery = {
      schema_version: "0.2.0", query_id: "query_four_variant_smoke_probe", execution_scope: "OFFICIAL",
      corpus_snapshot_id: harness.context.corpus_snapshot_id, fact_coverage_snapshot_id: harness.context.fact_coverage_snapshot_id,
      targets: ["FACT"], corp_codes: [],
      predicates: { metric_codes: [], event_types: [], relation_types: [], document_ids: [], fact_ids: [], event_ids: [], relation_ids: [], evidence_ids: [] },
      period_filter: { start: null, end: null, period_types: [] }, scope_filter: [],
      verification_statuses: ["VERIFIED"], as_of_date: "2030-01-01", limit: 1,
    };
    const probeResult = await harness.serviceAdapters.structuredStoreAdapter.query(probeQuery);
    if (probeResult.status !== "OK") throw new Error("the real v0.20-r3 bundle exposed no VERIFIED Fact to sample");
    const sample = probeResult.records[0].payload;

    const modelConfig = { schema_version: "0.1.0", model_config_id: "model_fake-deterministic-v1", kind: "FAKE_DETERMINISTIC", provider: "test-fixture", model: "deterministic-fake-v1" };
    const records = await runFourVariantComparison({
      variantIds: REQUIRED_VARIANT_IDS,
      modelAdapterFactory: () => createDeterministicFakeModelAdapter({
        responder: () => ({ text: `값은 ${sample.normalized_value}입니다.`, used_fact_ids: [sample.fact_id], used_evidence_ids: sample.evidence_ids }),
      }),
      agentVariantRevisions: computeAllAgentVariantRevisions({ cwd: ROOT }),
      modelConfig,
      releaseId: EXPECTED_RELEASE_ID,
      releaseManifestSha256,
      input: { question: "four-variant smoke question", question_id: "q_four_variant_smoke_01", hints: { corp_codes: [sample.corp_code], metric_codes: [sample.metric_code] } },
      context: { ...harness.context, as_of_date: "2030-01-01" },
      budgetLimits: { maxHcxCalls: 0, maxRetrievals: 0, maxToolCalls: 50, timeoutMs: 30000 },
      serviceAdapters: harness.serviceAdapters,
      benchmarkRunId: `benchmark_run_four_variant_smoke_${Date.now()}`,
    });

    const schemaErrors = records.flatMap((record) => validateComparisonRecord(record).map((e) => `${record.agent_variant_id}: ${e}`));
    console.log(JSON.stringify({ records, schema_errors: schemaErrors }, null, 2));

    if (outPath) {
      const resolvedOut = path.resolve(ROOT, outPath);
      await mkdir(path.dirname(resolvedOut), { recursive: true });
      await writeFile(resolvedOut, records.map((record) => JSON.stringify(record)).join("\n") + "\n", "utf8");
      console.log(`wrote ${records.length} comparison records to ${resolvedOut}`);
    }

    if (schemaErrors.length > 0) {
      console.error("smoke run FAILED: one or more ComparisonRecords are not schema-valid");
      process.exitCode = 1;
      return;
    }
    const unexpectedFailures = records.filter((record) => record.run_status === "FAILED");
    if (unexpectedFailures.length > 0) {
      console.error(`smoke run FAILED: ${unexpectedFailures.map((r) => r.agent_variant_id).join(", ")} did not run (run_status=FAILED)`);
      process.exitCode = 1;
    }
  } finally {
    await harness.dispose();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
