import assert from "node:assert/strict";
import test from "node:test";
import {
  AGENT_VARIANT_IDS,
  CITATION_BINDING_STATUSES,
  MODEL_CALL_ERROR_CODES,
  assertKnownAgentVariantId,
  InvalidAgentVariantIdError,
  isValidModelConfig,
  isValidTelemetryEvent,
  isValidBenchmarkRunManifest,
  validateModelConfig,
} from "../domain/agent-comparison/contracts.mjs";
import modelConfigExample from "../domain/agent-comparison/interfaces/examples/model-config.example.json" with { type: "json" };
import telemetryEventExample from "../domain/agent-comparison/interfaces/examples/telemetry-event.example.json" with { type: "json" };
import benchmarkRunManifestExample from "../domain/agent-comparison/interfaces/examples/benchmark-run-manifest.example.json" with { type: "json" };

test("AGENT_VARIANT_IDS lists exactly the four Turn P1-planned variants", () => {
  assert.deepEqual(AGENT_VARIANT_IDS, ["STRUCTURED_FIRST", "HYBRID_RETRIEVAL", "PLANNER", "DOCUMENT_FIRST_RAG"]);
});

test("CITATION_BINDING_STATUSES / MODEL_CALL_ERROR_CODES are the closed sets the schema/telemetry code actually uses", () => {
  assert.deepEqual(CITATION_BINDING_STATUSES, ["PASS", "FAIL", "NOT_CHECKED"]);
  assert.deepEqual(MODEL_CALL_ERROR_CODES, ["MODEL_ADAPTER_UNAVAILABLE", "MODEL_CALL_TIMEOUT", "MODEL_CALL_HTTP_ERROR", "MODEL_CALL_MALFORMED_RESPONSE", "MODEL_CALL_UNKNOWN_ERROR"]);
});

test("assertKnownAgentVariantId accepts every listed id and rejects an unknown one", () => {
  for (const id of AGENT_VARIANT_IDS) assert.equal(assertKnownAgentVariantId(id), id);
  assert.throws(() => assertKnownAgentVariantId("NOT_A_VARIANT"), InvalidAgentVariantIdError);
});

test("the three example fixtures are schema-valid", () => {
  assert.equal(isValidModelConfig(modelConfigExample), true);
  assert.equal(isValidTelemetryEvent(telemetryEventExample), true);
  assert.equal(isValidBenchmarkRunManifest(benchmarkRunManifestExample), true);
});

test("the telemetry-event example has no citation_accuracy field (Turn P1.1 removed it)", () => {
  assert.equal("citation_accuracy" in telemetryEventExample, false);
  assert.equal("evidence_validation_success_rate" in telemetryEventExample, true);
});

test("ModelConfig requires endpoint_url/api_key_env_var only for HTTP_CHAT_COMPLETIONS", () => {
  assert.equal(validateModelConfig({ ...modelConfigExample, kind: "HTTP_CHAT_COMPLETIONS", provider: "x", model: "y" }).length > 0, true);
  assert.deepEqual(
    validateModelConfig({
      ...modelConfigExample,
      kind: "HTTP_CHAT_COMPLETIONS",
      model_config_id: "model_x",
      provider: "x",
      model: "y",
      endpoint_url: "https://example.invalid/v1/chat/completions",
      api_key_env_var: "X_API_KEY",
    }),
    [],
  );
});

test("ModelConfig rejects an unknown additional field (additionalProperties:false)", () => {
  assert.equal(validateModelConfig({ ...modelConfigExample, unexpected_field: true }).length > 0, true);
});
