// Turn P11-A: tests for buildHcxGenerationManifest -- schema validity, the
// mock-vs-real distinction (mock_generation_call_performed vs
// actual_external_generation_call_performed), and non-exposure of any raw
// secret/prompt/response in the assembled record.
import assert from "node:assert/strict";
import test from "node:test";
import { createModelAdapter } from "../domain/agent-comparison/model-adapter.mjs";
import { createHcxMockServer } from "../domain/agent-comparison/hcx-mock-server.mjs";
import { instrumentModelAdapter } from "../domain/agent-comparison/telemetry.mjs";
import { computeModelConfigSha256 } from "../domain/agent-comparison/reproducibility.mjs";
import { buildHcxGenerationManifest, computeEndpointSha256 } from "../domain/agent-comparison/hcx-generation-manifest.mjs";
import { validateHcxGenerationManifest } from "../domain/agent-comparison/contracts.mjs";
import hcxManifestExample from "../domain/agent-comparison/interfaces/examples/hcx-generation-manifest.example.json" with { type: "json" };

const API_KEY_ENV_VAR = "AGENT_COMPARISON_HCX_MANIFEST_TEST_KEY";

test("the example fixture is schema-valid", () => {
  assert.deepEqual(validateHcxGenerationManifest(hcxManifestExample), []);
});

test("buildHcxGenerationManifest produces a schema-valid record for a successful mock call, with mock_generation_call_performed=true and actual_external_generation_call_performed=false", async () => {
  process.env[API_KEY_ENV_VAR] = "fake-key-for-manifest-test";
  const server = createHcxMockServer();
  const baseUrl = await server.listen();
  try {
    const config = {
      schema_version: "0.1.0", model_config_id: "model_hcx-manifest-test-v1", kind: "HCX_CHAT_COMPLETIONS",
      provider: "hcx", model: "test-fixture-model", endpoint_url: server.urlFor(baseUrl, "normal"),
      api_key_env_var: API_KEY_ENV_VAR, max_output_tokens: 256, temperature: 0.3, top_p: 0.8,
      seed_supported: false, timeout_ms: 2000, request_schema_version: "hcx-chat-completions-v3",
      response_schema_version: "hcx-chat-completions-v3", actual_external_call_authorized: false,
    };
    const baseAdapter = createModelAdapter(config, { allowLoopbackMockCalls: true });
    const { adapter, usage } = instrumentModelAdapter(baseAdapter);
    await adapter.generate({ prompt: "매출액이 얼마인가요?" });

    const manifest = buildHcxGenerationManifest({
      config,
      adapter: baseAdapter,
      modelConfigSha256: computeModelConfigSha256(config),
      codeRevision: "test-revision",
      usage: usage(),
      promptTemplateId: "structured-first-answer-prompt-v1",
      promptTemplateSha256: "3".repeat(64),
    });

    assert.deepEqual(validateHcxGenerationManifest(manifest), []);
    assert.equal(manifest.endpoint_is_loopback, true);
    assert.equal(manifest.mock_generation_call_performed, true);
    assert.equal(manifest.actual_external_generation_call_performed, false);
    assert.equal(manifest.actual_external_call_authorized, false);
    assert.equal(manifest.model_call_attempt_count, 1);
    assert.equal(manifest.model_call_success_count, 1);
    assert.equal(manifest.model_call_failure_count, 0);
    assert.equal(manifest.model_failure_code, null);
    assert.equal(manifest.endpoint_sha256, computeEndpointSha256(config.endpoint_url));
    assert.equal(manifest.provider_id, "hcx");
    assert.equal(manifest.model_id, "test-fixture-model");
  } finally {
    delete process.env[API_KEY_ENV_VAR];
    await server.close();
  }
});

test("buildHcxGenerationManifest never contains the raw API key, endpoint URL, prompt text, or response text -- only ids/hashes/hostname", async () => {
  process.env[API_KEY_ENV_VAR] = "super-secret-manifest-key-must-not-leak";
  const server = createHcxMockServer();
  const baseUrl = await server.listen();
  try {
    const endpointUrl = server.urlFor(baseUrl, "normal");
    const config = {
      schema_version: "0.1.0", model_config_id: "model_hcx-manifest-secrecy-v1", kind: "HCX_CHAT_COMPLETIONS",
      provider: "hcx", model: "test-fixture-model", endpoint_url: endpointUrl,
      api_key_env_var: API_KEY_ENV_VAR, max_output_tokens: 256, temperature: 0.3, top_p: 0.8,
      seed_supported: false, timeout_ms: 2000, request_schema_version: "hcx-chat-completions-v3",
      response_schema_version: "hcx-chat-completions-v3", actual_external_call_authorized: false,
    };
    const baseAdapter = createModelAdapter(config, { allowLoopbackMockCalls: true });
    const { adapter, usage } = instrumentModelAdapter(baseAdapter);
    await adapter.generate({ prompt: "이 프롬프트 내용은 절대 노출되면 안 됩니다" });

    const manifest = buildHcxGenerationManifest({
      config, adapter: baseAdapter, modelConfigSha256: computeModelConfigSha256(config),
      codeRevision: "test-revision", usage: usage(),
    });

    const serialized = JSON.stringify(manifest);
    assert.doesNotMatch(serialized, /super-secret-manifest-key-must-not-leak/);
    assert.doesNotMatch(serialized, new RegExp(endpointUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.doesNotMatch(serialized, /이 프롬프트 내용은/);
    assert.doesNotMatch(serialized, /매출액은/);
  } finally {
    delete process.env[API_KEY_ENV_VAR];
    await server.close();
  }
});

test("buildHcxGenerationManifest records a genuine model-call failure honestly (NOT_CHECKED-equivalent state at the telemetry layer, model_failure_code set, model_fallback_used caller-supplied)", async () => {
  process.env[API_KEY_ENV_VAR] = "fake-key-for-manifest-failure-test";
  const server = createHcxMockServer();
  const baseUrl = await server.listen();
  try {
    const config = {
      schema_version: "0.1.0", model_config_id: "model_hcx-manifest-failure-v1", kind: "HCX_CHAT_COMPLETIONS",
      provider: "hcx", model: "test-fixture-model", endpoint_url: server.urlFor(baseUrl, "http-500"),
      api_key_env_var: API_KEY_ENV_VAR, max_output_tokens: 256, temperature: 0.3, top_p: 0.8,
      seed_supported: false, timeout_ms: 2000, request_schema_version: "hcx-chat-completions-v3",
      response_schema_version: "hcx-chat-completions-v3", actual_external_call_authorized: false,
    };
    const baseAdapter = createModelAdapter(config, { allowLoopbackMockCalls: true });
    const { adapter, usage } = instrumentModelAdapter(baseAdapter);
    await assert.rejects(() => adapter.generate({ prompt: "x" }));

    const manifest = buildHcxGenerationManifest({
      config, adapter: baseAdapter, modelConfigSha256: computeModelConfigSha256(config),
      codeRevision: "test-revision", usage: usage(), modelFallbackUsed: true, scoringEligible: false,
    });

    assert.deepEqual(validateHcxGenerationManifest(manifest), []);
    assert.equal(manifest.model_call_attempt_count, 1);
    assert.equal(manifest.model_call_success_count, 0);
    assert.equal(manifest.model_call_failure_count, 1);
    assert.equal(manifest.model_failure_code, "MODEL_CALL_HTTP_ERROR");
    assert.equal(manifest.model_fallback_used, true);
    assert.equal(manifest.scoring_eligible, false);
  } finally {
    delete process.env[API_KEY_ENV_VAR];
    await server.close();
  }
});
