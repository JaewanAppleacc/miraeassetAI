#!/usr/bin/env node
// Seed 25 smoke/regression runner for domain/agent-comparison/ (Turn P1;
// updated Turn P1.1 for the new telemetry/manifest contract).
//
// Role: SMOKE_REGRESSION only (matches domain/evaluation/asset-audit.v1.json's
// own labeling of Seed 25 -- "wiring_and_regression_only", not Gold). This
// script proves the common Agent-comparison contract (AgentFlow x
// ModelAdapter x telemetry) actually works end-to-end against the REAL,
// already-approved v0.20-r3 bundle -- it does NOT compare answers against
// any expected text, does NOT read domain/evaluation Gold, and does NOT
// tune any rule based on what it observes here. A question this run marks
// UNANSWERABLE is not a bug in this script: as_of_date is fixed to "today"
// (no per-question Thin Plan is used here, unlike production), so a Fact
// whose valid_to has since passed can legitimately fall out of effectivity.
//
// Uses the FAKE_DETERMINISTIC ModelAdapter only -- no real network call is
// made by this script, ever.
//
// Usage:
//   npm run agent-comparison:seed25-smoke
//   npm run agent-comparison:seed25-smoke -- --out work/agent-comparison/seed25-smoke.jsonl
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createSeedBundleHarness } from "../domain/agent-comparison/seed-bundle-harness.mjs";
import { createBenchmarkRunManifest, runBenchmark } from "../domain/agent-comparison/benchmark-runner.mjs";
import { createDeterministicFakeModelAdapter } from "../domain/agent-comparison/fake-model-adapter.mjs";
import { ANSWER_PROMPT_TEMPLATE_ID, ANSWER_PROMPT_TEMPLATE_SHA256 } from "../domain/agent-comparison/flows/structured-first-agent.mjs";
import "../domain/agent-comparison/register-default-variants.mjs";

const ROOT = process.cwd();
const GOLD_PATH = path.resolve(ROOT, "work/domain-seed/seed-gold-promotion-candidates.v0.17.jsonl");

const FAKE_MODEL_CONFIG = Object.freeze({
  schema_version: "0.1.0",
  model_config_id: "model_fake-deterministic-v1",
  kind: "FAKE_DETERMINISTIC",
  provider: "test-fixture",
  model: "deterministic-fake-v1",
});

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--out") out.outPath = argv[i + 1];
  }
  return out;
}

async function loadSeed25Questions() {
  let text;
  try {
    text = (await readFile(GOLD_PATH, "utf8")).trim();
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new Error(
        `${GOLD_PATH} does not exist. This is the same local, git-untracked ` +
        `work/domain-seed/ scratch data every existing Seed 25 E2E test already ` +
        `depends on (see tests/seed-answer-api-e2e.test.mjs) -- it is not part of ` +
        `this repository's git history and is never copied in from another ` +
        `worktree by this script. Run this smoke script from a workspace where ` +
        `work/domain-seed/ has already been populated (e.g. via the existing ` +
        `npm run domain:seed pipeline against the real corpus).`,
      );
    }
    throw error;
  }
  const records = text.split("\n").map((line) => JSON.parse(line)).filter((record) => record.extensions?.e2e_usage_status === "E2E_READY");
  if (records.length !== 25) throw new Error(`expected exactly 25 E2E_READY Seed questions, found ${records.length}`);
  // question texts/ids come verbatim from the existing Gold fixture --
  // never hardcoded in this script -- and no `hints` are supplied, so the
  // Structured-first Agent's own question analysis (corp_code/metric_code
  // extraction) is what's actually being smoke-tested here.
  return records.map((record) => ({ question: record.question, question_id: record.question_id }));
}

async function main() {
  const { outPath } = parseArgs(process.argv.slice(2));
  const questions = await loadSeed25Questions();
  const harness = await createSeedBundleHarness({ root: ROOT });
  try {
    const manifest = createBenchmarkRunManifest({
      agentVariantId: "STRUCTURED_FIRST",
      agentVariantRevision: "structured-first-agent-v1",
      modelConfig: FAKE_MODEL_CONFIG,
      promptTemplateId: ANSWER_PROMPT_TEMPLATE_ID,
      promptTemplateSha256: ANSWER_PROMPT_TEMPLATE_SHA256,
      executionScope: "OFFICIAL",
      datasetId: "seed-25",
      datasetRole: "SMOKE_REGRESSION",
      questions,
      corpusSnapshotId: harness.context.corpus_snapshot_id,
      factCoverageSnapshotId: harness.context.fact_coverage_snapshot_id,
      temperature: null,
      maxOutputTokens: null,
      determinism: { seed: null, provider_deterministic_mode: "FAKE_DETERMINISTIC_ADAPTER" },
      cachePolicy: "NONE",
      fallbackScoringPolicy: "EXCLUDE_FALLBACK_FROM_MODEL_SCORING",
      budgetLimits: { maxHcxCalls: 0, maxRetrievals: 0, maxToolCalls: 50, timeoutMs: 30000 },
      notes: "Turn P1.1 wiring smoke run -- Seed 25 used under its documented SMOKE_REGRESSION role only, never as Gold.",
    });
    const modelAdapter = createDeterministicFakeModelAdapter();
    const { manifest: completed, events } = await runBenchmark({
      manifest, modelAdapter, questions, context: harness.context, serviceAdapters: harness.serviceAdapters,
    });

    const summary = events.reduce((acc, event) => {
      acc.validation_status[event.validation_status] = (acc.validation_status[event.validation_status] ?? 0) + 1;
      acc.citation_binding_status[event.citation_binding_status] = (acc.citation_binding_status[event.citation_binding_status] ?? 0) + 1;
      acc.model_fallback_used[String(event.model_fallback_used)] = (acc.model_fallback_used[String(event.model_fallback_used)] ?? 0) + 1;
      acc.scoring_eligible[String(event.scoring_eligible)] = (acc.scoring_eligible[String(event.scoring_eligible)] ?? 0) + 1;
      return acc;
    }, { validation_status: {}, citation_binding_status: {}, model_fallback_used: {}, scoring_eligible: {} });
    console.log(JSON.stringify({ manifest: completed, summary }, null, 2));

    if (outPath) {
      const resolvedOut = path.resolve(ROOT, outPath);
      await mkdir(path.dirname(resolvedOut), { recursive: true });
      await writeFile(resolvedOut, events.map((event) => JSON.stringify(event)).join("\n") + "\n", "utf8");
      console.log(`wrote ${events.length} telemetry events to ${resolvedOut}`);
    }

    const crashed = events.some((event) => event.error_code === "INTERNAL_ERROR");
    if (crashed) {
      console.error("smoke run FAILED: at least one question produced INTERNAL_ERROR");
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
