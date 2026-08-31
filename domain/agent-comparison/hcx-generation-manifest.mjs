// Builds and schema-validates ONE HcxGenerationManifest record (Turn P11-A,
// see interfaces/hcx-generation-manifest.schema.json for the full field
// contract and why this is a separate artifact from TelemetryEvent /
// BenchmarkRunManifest). Throws (never silently coerces) if the assembled
// record is not schema-valid, matching telemetry.mjs's buildTelemetryEvent
// precedent -- a bug here must fail loudly at manifest-build time, not
// produce a record downstream tooling silently mis-parses.
//
// Never accepts or derives a raw API key, raw prompt text, or raw provider
// response body -- only ids/hashes of them, plus the honest
// actual_external_call_authorized / actual_external_generation_call_performed /
// mock_generation_call_performed flags that distinguish a real HCX call
// from a local loopback mock call.
import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { validateHcxGenerationManifest } from "./contracts.mjs";

function sha256Hex(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function computeEndpointSha256(endpointUrl) {
  return sha256Hex(endpointUrl);
}

// `adapter` is the object returned by createModelAdapter/createHcxChatCompletionsModelAdapter
// (its own endpointHostname/endpointIsLoopback fields, set at construction
// time from the SAME security check that would have refused construction
// otherwise -- never re-derived from a raw endpoint_url string here).
// `usage` is instrumentModelAdapter's own usage() snapshot (telemetry.mjs)
// -- reused, not re-counted, so this manifest's call counts can never drift
// from what telemetry.mjs already recorded for the same adapter instance.
export function buildHcxGenerationManifest({
  config,
  adapter,
  modelConfigSha256,
  codeRevision,
  usage,
  modelFallbackUsed = false,
  scoringEligible = !modelFallbackUsed,
  mockGenerationCallPerformed,
  promptTemplateId = null,
  promptTemplateSha256 = null,
  createdAt = new Date().toISOString(),
  manifestId = `hcx_manifest_${randomUUID().replaceAll("-", "")}`,
}) {
  const endpointIsLoopback = adapter?.endpointIsLoopback === true;
  const mockPerformed = typeof mockGenerationCallPerformed === "boolean" ? mockGenerationCallPerformed : endpointIsLoopback && (usage?.model_call_attempt_count ?? 0) > 0;
  const manifest = {
    schema_version: "0.1.0",
    manifest_id: manifestId,
    created_at: createdAt,
    provider_id: config.provider,
    model_id: config.model,
    model_config_id: config.model_config_id,
    model_config_sha256: modelConfigSha256,
    endpoint_sha256: computeEndpointSha256(config.endpoint_url),
    endpoint_hostname: adapter?.endpointHostname ?? new URL(config.endpoint_url).hostname,
    endpoint_is_loopback: endpointIsLoopback,
    prompt_template_id: promptTemplateId,
    prompt_template_sha256: promptTemplateSha256,
    request_schema_version: config.request_schema_version,
    response_schema_version: config.response_schema_version,
    timeout_ms: config.timeout_ms,
    max_output_tokens: config.max_output_tokens,
    temperature: config.temperature,
    top_p: config.top_p,
    seed_supported: config.seed_supported,
    code_revision: codeRevision,
    // Always mirrors config, never the fact that a loopback mock call was
    // made -- a mock call never flips this to true (see this module's own
    // header comment and hcx-model-adapter.mjs's AUTHORIZATION MODEL).
    actual_external_call_authorized: config.actual_external_call_authorized === true,
    // Real-call-performed can only ever be true when a real (non-loopback)
    // call actually succeeded or was attempted against a non-loopback
    // endpoint -- never derived from a mock call, however many were made.
    actual_external_generation_call_performed: !endpointIsLoopback && (usage?.model_call_attempt_count ?? 0) > 0,
    mock_generation_call_performed: mockPerformed,
    model_call_attempt_count: usage?.model_call_attempt_count ?? 0,
    model_call_success_count: usage?.model_call_success_count ?? 0,
    model_call_failure_count: usage?.model_call_failure_count ?? 0,
    model_failure_code: usage?.model_failure_code ?? null,
    model_fallback_used: modelFallbackUsed,
    scoring_eligible: scoringEligible,
  };
  const errors = validateHcxGenerationManifest(manifest);
  if (errors.length > 0) throw new Error(`buildHcxGenerationManifest produced an invalid HcxGenerationManifest: ${errors.join("; ")}`);
  return Object.freeze(manifest);
}
