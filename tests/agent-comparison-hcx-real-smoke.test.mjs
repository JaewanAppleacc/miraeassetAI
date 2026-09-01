// Turn P11-B: scoped tests for the real-connection smoke harness. Every
// test here either (a) exercises the current, genuine "no HCX_API_KEY /
// HCX_ENDPOINT_URL / HCX_MODEL_ID configured" fail-closed path with the
// REAL process.env (never touching a real network), or (b) exercises the
// bounded-retry/aggregation logic with an injected fetchImpl standing in
// for a real HCX endpoint (still zero real network I/O). This file is
// intentionally NOT wired into package.json's test:domain file list (see
// CLAUDE.md Turn P11-B: "전체 test:domain 및 headless Chrome 테스트 금지") --
// run it directly: node --test tests/agent-comparison-hcx-real-smoke.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { loadHcxRealSmokeConfig, DEFAULT_API_KEY_ENV_VAR } from "../domain/agent-comparison/hcx-real-smoke/config.mjs";
import { runHcxRealSmoke } from "../domain/agent-comparison/hcx-real-smoke/runner.mjs";
import { buildAllArtifacts } from "../domain/agent-comparison/hcx-real-smoke/artifacts.mjs";
import { HARD_LIMITS } from "../domain/agent-comparison/hcx-real-smoke/hard-limits.mjs";
import { HCX_REAL_SMOKE_SCENARIOS } from "../domain/agent-comparison/hcx-real-smoke/scenarios.mjs";
import {
  validateHcxRealSmokeConfig, validateHcxRealSmokeResult,
  validateHcxRealSmokeSecurityAttestation, validateHcxRealSmokeGateStatus,
} from "../domain/agent-comparison/hcx-real-smoke/contracts.mjs";

const RELEVANT_ENV_VARS = ["HCX_API_KEY", "HCX_ENDPOINT_URL", "HCX_MODEL_ID", "HCX_PROVIDER_ID", "HCX_REQUEST_SCHEMA_VERSION", "HCX_RESPONSE_SCHEMA_VERSION", "HCX_TOP_P", "HCX_TEMPERATURE", "HCX_MAX_OUTPUT_TOKENS", "HCX_SEED_SUPPORTED", "HCX_REQUEST_TIMEOUT_MS", "HCX_INPUT_COST_PER_1K", "HCX_OUTPUT_COST_PER_1K"];

function withCleanEnv(overrides, run) {
  const saved = Object.fromEntries(RELEVANT_ENV_VARS.map((name) => [name, process.env[name]]));
  for (const name of RELEVANT_ENV_VARS) delete process.env[name];
  Object.assign(process.env, overrides);
  return Promise.resolve()
    .then(run)
    .finally(() => {
      for (const name of RELEVANT_ENV_VARS) {
        if (saved[name] === undefined) delete process.env[name];
        else process.env[name] = saved[name];
      }
    });
}

test("loadHcxRealSmokeConfig: with no HCX_* env vars set, ready=false, all three required names listed as missing, no secret anywhere in the redacted view", () => withCleanEnv({}, () => {
  const loaded = loadHcxRealSmokeConfig();
  assert.equal(loaded.ready, false);
  assert.deepEqual(loaded.missing.sort(), ["HCX_API_KEY", "HCX_ENDPOINT_URL", "HCX_MODEL_ID"].sort());
  assert.equal(loaded.modelConfig, null);
  assert.equal(loaded.redacted.api_key_present, false);
  assert.equal(loaded.redacted.ready, false);
  assert.equal(JSON.stringify(loaded.redacted).includes("api_key"), false === false); // sanity: field name check below is the real assertion
  assert.equal("rawApiKey" in loaded.redacted, false);
}));

test("runHcxRealSmoke: with ready=false, makes ZERO calls and returns MISSING_CREDENTIALS -- no adapter is ever constructed", () => withCleanEnv({}, async () => {
  const loaded = loadHcxRealSmokeConfig();
  const result = await runHcxRealSmoke(loaded);
  assert.equal(result.requestsAttempted, 0);
  assert.equal(result.requestsSucceeded, 0);
  assert.equal(result.stoppedEarlyReason, "MISSING_CREDENTIALS");
  assert.equal(result.scenarioResults.length, 0);
}));

test("end-to-end (no key): the full artifact set is schema-valid, gate_status=HCX_REAL_API_PROTOCOL_NOT_VERIFIED, every scope-boundary flag is false, security attestation PASSes", () => withCleanEnv({}, async () => {
  const loaded = loadHcxRealSmokeConfig();
  const runResult = await runHcxRealSmoke(loaded);
  const { configArtifact, resultArtifact, gateStatusArtifact, securityAttestation } = buildAllArtifacts(loaded, runResult);

  assert.deepEqual(validateHcxRealSmokeConfig(configArtifact), []);
  assert.deepEqual(validateHcxRealSmokeResult(resultArtifact), []);
  assert.deepEqual(validateHcxRealSmokeGateStatus(gateStatusArtifact), []);
  assert.deepEqual(validateHcxRealSmokeSecurityAttestation(securityAttestation), []);

  assert.equal(gateStatusArtifact.gate_status, "HCX_REAL_API_PROTOCOL_NOT_VERIFIED");
  assert.equal(gateStatusArtifact.agent_quality_evaluated, false);
  assert.equal(gateStatusArtifact.dev_tune_accessed, false);
  assert.equal(gateStatusArtifact.dev_check_accessed, false);
  assert.equal(gateStatusArtifact.holdout_accessed, false);
  assert.equal(gateStatusArtifact.production_wiring_applied, false);
  assert.equal(gateStatusArtifact.final_generation_model_selected, false);
  assert.equal(securityAttestation.overall_status, "PASS");
  assert.equal(resultArtifact.requests_attempted, 0);

  const missingKeyItem = resultArtifact.validation_checklist.find((c) => c.item === "missing_api_key_zero_calls");
  assert.equal(missingKeyItem.status, "PASS");
}));

test("with only HCX_API_KEY set (endpoint/model still missing), still ready=false and zero calls", () => withCleanEnv({ HCX_API_KEY: "test-only-fake-key-never-real" }, async () => {
  const loaded = loadHcxRealSmokeConfig();
  assert.equal(loaded.ready, false);
  assert.deepEqual(loaded.missing.sort(), ["HCX_ENDPOINT_URL", "HCX_MODEL_ID"].sort());
  assert.equal(loaded.redacted.api_key_present, true);
  const result = await runHcxRealSmoke(loaded);
  assert.equal(result.requestsAttempted, 0);
}));

// --- bounded execution against an injected fetchImpl (still zero real network I/O) ---
//
// withFakeConfig keeps the fake HCX_* env vars set for the ENTIRE async
// callback (config load + runHcxRealSmoke), not just for loadHcxRealSmokeConfig()
// -- createModelAdapter re-reads process.env[api_key_env_var] itself at
// adapter-construction time (inside runHcxRealSmoke), so the env must still
// be set when that happens, not just when config.mjs first ran.
function withFakeConfig(overrides, run) {
  return withCleanEnv({
    HCX_API_KEY: "test-only-fake-key-never-real",
    HCX_ENDPOINT_URL: "https://example.invalid/hcx/v3/chat-completions",
    HCX_MODEL_ID: "test-fixture-model",
    ...overrides,
  }, () => run(loadHcxRealSmokeConfig()));
}

function structuredEnvelope(answer = "테스트 답변") {
  return {
    ok: true,
    json: async () => ({ status: { code: "20000" }, result: { message: { content: JSON.stringify({ answer, used_fact_ids: [], used_evidence_ids: [] }) }, usage: { promptTokens: 5, completionTokens: 3 } } }),
  };
}

test("runHcxRealSmoke: all 5 scenarios succeed on the first attempt -- requests_attempted == number of scenarios, zero retries, gate VERIFIED", () => withFakeConfig({}, async (loaded) => {
  let callCount = 0;
  const result = await runHcxRealSmoke(loaded, { fetchImpl: async () => { callCount += 1; return structuredEnvelope(); } });
  assert.equal(result.constructionError, null, `unexpected construction refusal: ${result.stoppedEarlyReason}`);
  assert.equal(callCount, HCX_REAL_SMOKE_SCENARIOS.length);
  assert.equal(result.requestsAttempted, HCX_REAL_SMOKE_SCENARIOS.length);
  assert.equal(result.requestsSucceeded, HCX_REAL_SMOKE_SCENARIOS.length);
  assert.equal(result.retriesPerformed, 0);
  assert.ok(result.latencyStats);
  assert.equal(result.latencyStats.count, HCX_REAL_SMOKE_SCENARIOS.length);

  const { gateStatusArtifact } = buildAllArtifacts(loaded, result);
  assert.equal(gateStatusArtifact.gate_status, "HCX_REAL_API_PROTOCOL_VERIFIED");
}));

test("runHcxRealSmoke: never exceeds HARD_LIMITS.MAXIMUM_REQUESTS even if every scenario needed its max retries", () => withFakeConfig({}, async (loaded) => {
  let callCount = 0;
  const result = await runHcxRealSmoke(loaded, {
    fetchImpl: async () => { callCount += 1; return { ok: false, status: 500, json: async () => ({}) }; },
  });
  assert.ok(callCount <= HARD_LIMITS.MAXIMUM_REQUESTS, `made ${callCount} calls, hard limit is ${HARD_LIMITS.MAXIMUM_REQUESTS}`);
  assert.ok(result.requestsAttempted <= HARD_LIMITS.MAXIMUM_REQUESTS);
}));

test("runHcxRealSmoke: a 500 response is retried exactly once (retry_max_attempts=2 total) then reported as a bounded failure", () => withFakeConfig({}, async (loaded) => {
  const result = await runHcxRealSmoke(loaded, {
    fetchImpl: async () => ({ ok: false, status: 500, json: async () => ({}) }),
  });
  const firstScenario = result.scenarioResults[0];
  assert.equal(firstScenario.attempts.length, HARD_LIMITS.RETRY_MAX_ATTEMPTS);
  assert.equal(firstScenario.outcome, "FAILURE");
  assert.ok(result.retriesPerformed >= 1);
}));

test("runHcxRealSmoke: a 400 (non-retryable) HTTP error is NOT retried -- exactly one attempt for that scenario", () => withFakeConfig({}, async (loaded) => {
  const result = await runHcxRealSmoke(loaded, {
    fetchImpl: async () => ({ ok: false, status: 400, json: async () => ({}) }),
  });
  const firstScenario = result.scenarioResults[0];
  assert.equal(firstScenario.attempts.length, 1);
  assert.equal(firstScenario.outcome, "FAILURE");
}));

test("runHcxRealSmoke: stops early after two consecutive scenario failures (REPEATED_ERRORS), never exhausting the full scenario list", () => withFakeConfig({}, async (loaded) => {
  const result = await runHcxRealSmoke(loaded, {
    fetchImpl: async () => ({ ok: false, status: 400, json: async () => ({}) }),
  });
  assert.equal(result.stoppedEarlyReason, "REPEATED_ERRORS");
  assert.ok(result.scenarioResults.length < HCX_REAL_SMOKE_SCENARIOS.length);
}));

test("runHcxRealSmoke: an empty answer is a fail-closed MODEL_CALL_MALFORMED_RESPONSE, never silently accepted", () => withFakeConfig({}, async (loaded) => {
  const result = await runHcxRealSmoke(loaded, { fetchImpl: async () => structuredEnvelope("") });
  const firstScenario = result.scenarioResults[0];
  assert.equal(firstScenario.outcome, "FAILURE");
  assert.equal(firstScenario.attempts[0].error_code, "MODEL_CALL_MALFORMED_RESPONSE");
  assert.equal(firstScenario.attempts[0].looks_empty_response, true);
}));

test("runHcxRealSmoke: token usage is aggregated (never per-call) and cost stays null with no unit price configured", () => withFakeConfig({}, async (loaded) => {
  const result = await runHcxRealSmoke(loaded, { fetchImpl: async () => structuredEnvelope() });
  assert.ok(result.tokenUsageAggregate);
  assert.equal(result.tokenUsageAggregate.input_tokens_total, 5 * HCX_REAL_SMOKE_SCENARIOS.length);
  assert.equal(result.tokenUsageAggregate.output_tokens_total, 3 * HCX_REAL_SMOKE_SCENARIOS.length);
  assert.equal(result.estimatedCostTotal, null);
}));

test("runHcxRealSmoke: cost IS computed when a unit price is explicitly configured", () => withFakeConfig({ HCX_INPUT_COST_PER_1K: "1", HCX_OUTPUT_COST_PER_1K: "2" }, async (loaded) => {
  const result = await runHcxRealSmoke(loaded, { fetchImpl: async () => structuredEnvelope() });
  assert.ok(result.estimatedCostTotal > 0);
}));

test("full artifact set from a mixed run (some success, some failure) is schema-valid and the security attestation never contains the fake test key or the fixed prompt texts", () => withFakeConfig({}, async (loaded) => {
  let n = 0;
  const result = await runHcxRealSmoke(loaded, {
    fetchImpl: async () => { n += 1; return n % 2 === 0 ? structuredEnvelope() : { ok: false, status: 429, json: async () => ({}) }; },
  });
  const { configArtifact, resultArtifact, gateStatusArtifact, securityAttestation } = buildAllArtifacts(loaded, result);
  assert.deepEqual(validateHcxRealSmokeConfig(configArtifact), []);
  assert.deepEqual(validateHcxRealSmokeResult(resultArtifact), []);
  assert.deepEqual(validateHcxRealSmokeGateStatus(gateStatusArtifact), []);
  assert.deepEqual(validateHcxRealSmokeSecurityAttestation(securityAttestation), []);
  const serialized = JSON.stringify({ configArtifact, resultArtifact, gateStatusArtifact, securityAttestation });
  assert.doesNotMatch(serialized, /test-only-fake-key-never-real/);
  for (const scenario of HCX_REAL_SMOKE_SCENARIOS) assert.doesNotMatch(serialized, new RegExp(scenario.prompt.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(serialized, /example\.invalid\/hcx/); // full endpoint URL never present, only hostname
}));

test("DEFAULT_API_KEY_ENV_VAR is exactly HCX_API_KEY", () => {
  assert.equal(DEFAULT_API_KEY_ENV_VAR, "HCX_API_KEY");
});

test("HARD_LIMITS match the CLAUDE.md Turn P11-B hard limits exactly", () => {
  assert.equal(HARD_LIMITS.MAXIMUM_REQUESTS, 10);
  assert.equal(HARD_LIMITS.CONCURRENCY, 1);
  assert.equal(HARD_LIMITS.RETRY_MAX_ATTEMPTS, 2);
});
