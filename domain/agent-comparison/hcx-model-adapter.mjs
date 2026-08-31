// HyperCLOVA X (HCX) protocol ModelAdapter -- Turn P11-A. Constructed only
// via createModelAdapter({kind: "HCX_CHAT_COMPLETIONS", ...}) in
// model-adapter.mjs, which validates the ModelConfig shape first
// (model-config.schema.json's HCX_CHAT_COMPLETIONS conditional block); this
// module additionally enforces everything that is a RUNTIME refusal, not a
// static schema shape: an unrecognized request/response schema version, a
// missing API key, and an endpoint that is neither https:// nor an
// explicitly test-authorized loopback mock target.
//
// This module NEVER hardcodes a real HCX model_id or endpoint -- both are
// entirely config-driven (CLAUDE.md Turn P11-A section B). The concrete
// request/response envelope shape below (messages/topP/topK/maxTokens
// request fields; a status+result response envelope) is this Turn's own
// best-documented understanding of HyperCLOVA X's Chat Completions v3
// shape, named explicitly as SUPPORTED_HCX_REQUEST_SCHEMA_VERSION/
// SUPPORTED_HCX_RESPONSE_SCHEMA_VERSION so that if the real API differs
// once Owner-authorized small-scale testing begins, ONLY those two version
// constants (and the two builder/parser functions below) need to change --
// no caller of createModelAdapter needs to change, and an unrecognized
// version fails closed (MODEL_ADAPTER_UNAVAILABLE) rather than silently
// guessing a shape.
//
// AUTHORIZATION MODEL (Turn P11-A, CLAUDE.md section C):
//   - config.actual_external_call_authorized === true is the ONLY way a
//     non-loopback (real) endpoint may ever be called. It is never set to
//     true anywhere in this Turn's own code/tests/scripts.
//   - A loopback endpoint (127.0.0.1/localhost/::1) may ALSO be called,
//     but only when the caller passes an explicit, test-only constructor
//     option `allowLoopbackMockCalls: true` -- config alone can never grant
//     this; a config with actual_external_call_authorized=false pointed at
//     a real hostname is refused unconditionally, with zero fetch calls.
//     A mock call made this way is still honestly reported everywhere
//     (hcx-generation-manifest.mjs) with actual_external_call_authorized
//     mirroring the config value (false) and
//     actual_external_generation_call_performed=false --
//     mock_generation_call_performed=true is the only flag that turns on.
//   - Neither authorization path is checked per-call: if construction did
//     not throw, EVERY generate() call on that adapter instance is already
//     known-authorized. This mirrors the existing HTTP_CHAT_COMPLETIONS
//     adapter's own construction-time-only API-key check.
import { ModelAdapterUnavailableError } from "./model-adapter-unavailable-error.mjs";
import { ModelCallError } from "./model-call-error.mjs";
import { parseStructuredAnswer } from "./structured-answer-parsing.mjs";

export const SUPPORTED_HCX_REQUEST_SCHEMA_VERSIONS = Object.freeze(["hcx-chat-completions-v3"]);
export const SUPPORTED_HCX_RESPONSE_SCHEMA_VERSIONS = Object.freeze(["hcx-chat-completions-v3"]);

const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

function costFor(tokens, costPer1k) {
  if (typeof costPer1k !== "number" || !Number.isFinite(costPer1k)) return 0;
  return (tokens / 1000) * costPer1k;
}

// Static (construction-time) checks only -- never re-run per generate()
// call, matching the existing HTTP_CHAT_COMPLETIONS adapter's own
// construction-time-only API-key check.
function assertSchemaVersionsSupported(config) {
  if (!SUPPORTED_HCX_REQUEST_SCHEMA_VERSIONS.includes(config.request_schema_version)) {
    throw new ModelAdapterUnavailableError(
      `request_schema_version ${JSON.stringify(config.request_schema_version)} is not a recognized HCX request schema version; refusing to guess a request shape`,
    );
  }
  if (!SUPPORTED_HCX_RESPONSE_SCHEMA_VERSIONS.includes(config.response_schema_version)) {
    throw new ModelAdapterUnavailableError(
      `response_schema_version ${JSON.stringify(config.response_schema_version)} is not a recognized HCX response schema version; refusing to guess a response shape`,
    );
  }
}

// Returns { hostname, isLoopback } or throws ModelAdapterUnavailableError.
// Never includes the endpoint_url itself in a thrown message (hostname
// alone is not sensitive; the full URL could in principle carry a
// provider-specific query-string detail some future config sets).
function resolveEndpointSecurity(config, { allowLoopbackMockCalls = false } = {}) {
  let parsed;
  try {
    parsed = new URL(config.endpoint_url);
  } catch {
    throw new ModelAdapterUnavailableError("endpoint_url is not a valid URL");
  }
  const hostname = parsed.hostname;
  const isLoopback = LOOPBACK_HOSTNAMES.has(hostname);

  if (isLoopback && allowLoopbackMockCalls === true) {
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new ModelAdapterUnavailableError("loopback mock endpoint_url must use http or https");
    }
    return { hostname, isLoopback: true };
  }

  if (config.actual_external_call_authorized !== true) {
    throw new ModelAdapterUnavailableError(
      "actual_external_call_authorized is not true and endpoint_url is not an explicitly test-authorized loopback mock target; refusing to construct an HCX adapter that could ever perform a network call",
    );
  }
  if (parsed.protocol !== "https:") {
    throw new ModelAdapterUnavailableError("a real (non-loopback) HCX endpoint_url must use https");
  }
  return { hostname, isLoopback: false };
}

// HCX Chat Completions v3-shaped request body. seed is included only when
// config.seed_supported is true AND the caller's request explicitly asked
// for one -- a provider config that declares seed unsupported never sends
// the field, even if a caller happens to pass request.seed.
function buildHcxRequestBody(request, config) {
  const messages = [];
  if (typeof request.system === "string" && request.system !== "") messages.push({ role: "system", content: request.system });
  messages.push({ role: "user", content: request.prompt });
  const body = {
    messages,
    topP: request.top_p ?? config.top_p,
    topK: 0,
    maxTokens: request.max_output_tokens ?? config.max_output_tokens,
    temperature: request.temperature ?? config.temperature,
    repetitionPenalty: 1.1,
    stop: [],
    includeAiFilters: true,
  };
  if (config.seed_supported === true && typeof request.seed === "number") body.seed = request.seed;
  return body;
}

// Parses the HCX v3-shaped response envelope down to the same
// {text, used_fact_ids, used_evidence_ids, input_tokens, output_tokens}
// shape parseStructuredAnswer already produces for the generic adapter,
// plus this adapter's own two additional structural checks the shared
// generic parser does not perform (see the two comments below for why each
// is scoped here rather than in the shared parser).
function parseHcxResponseBody(body) {
  if (body?.status?.code !== "20000") {
    throw new ModelCallError("MODEL_CALL_MALFORMED_RESPONSE", "model response status.code did not indicate success");
  }
  const rawContent = body?.result?.message?.content;
  if (typeof rawContent !== "string") {
    throw new ModelCallError("MODEL_CALL_MALFORMED_RESPONSE", "model response did not contain result.message.content");
  }
  const structured = parseStructuredAnswer(rawContent);

  // HCX-specific: an empty answer is structurally a valid JSON string but
  // never a usable generated answer (CLAUDE.md Turn P11-A section D:
  // "text가 비어 있지 않음"). Scoped to this adapter only -- the shared
  // parseStructuredAnswer used by the generic HTTP_CHAT_COMPLETIONS adapter
  // is left exactly as-is to avoid changing that adapter's already-tested
  // behavior for an unrelated Turn's scope.
  if (structured.text.trim() === "") {
    throw new ModelCallError("MODEL_CALL_MALFORMED_RESPONSE", "model response text was empty");
  }
  // HCX-specific: reject a response that claims the same fact/evidence id
  // more than once -- a purely structural property of the response itself,
  // checkable without any authorized-id context (unlike "is this id
  // actually authorized for this request", which only
  // flows/hard-claim-grounding.mjs's verifyCitationBinding can check, since
  // only the calling AgentFlow knows this request's authorized set -- see
  // this file's own header comment and CLAUDE.md Turn P11-A section E).
  for (const [label, ids] of [["used_fact_ids", structured.used_fact_ids], ["used_evidence_ids", structured.used_evidence_ids]]) {
    if (new Set(ids).size !== ids.length) {
      throw new ModelCallError("MODEL_CALL_MALFORMED_RESPONSE", `model response ${label} contained a duplicate id`);
    }
  }

  const inputTokens = Number.isFinite(body?.result?.usage?.promptTokens) ? body.result.usage.promptTokens : 0;
  const outputTokens = Number.isFinite(body?.result?.usage?.completionTokens) ? body.result.usage.completionTokens : 0;
  return {
    ...structured,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    finish_reason: typeof body?.result?.stopReason === "string" ? body.result.stopReason : null,
  };
}

export function createHcxChatCompletionsModelAdapter(config, { fetchImpl = fetch, allowLoopbackMockCalls = false } = {}) {
  assertSchemaVersionsSupported(config);
  const endpointSecurity = resolveEndpointSecurity(config, { allowLoopbackMockCalls });

  const apiKey = process.env[config.api_key_env_var];
  if (typeof apiKey !== "string" || apiKey === "") {
    throw new ModelAdapterUnavailableError(
      `environment variable ${config.api_key_env_var} is not set; refusing to call ${config.provider}/${config.model} without an API key`,
    );
  }

  return Object.freeze({
    modelConfigId: config.model_config_id,
    provider: config.provider,
    model: config.model,
    // Non-enumerable-by-contract metadata a caller (hcx-generation-manifest.mjs,
    // tests) may read to build a manifest without re-deriving endpoint
    // security from config -- never used by generate() itself beyond what
    // was already validated at construction.
    endpointHostname: endpointSecurity.hostname,
    endpointIsLoopback: endpointSecurity.isLoopback,
    async generate(request) {
      if (!request || typeof request.prompt !== "string" || request.prompt === "") {
        throw new TypeError("ModelAdapter.generate requires request.prompt (non-empty string)");
      }
      const startedAt = Date.now();
      const controller = new AbortController();
      const timeoutMs = config.timeout_ms ?? 30000;
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      // An external caller-supplied AbortSignal (request.signal) is
      // combined with our own internal timeout controller -- either firing
      // aborts the fetch. Both produce the SAME ModelCallError code
      // (MODEL_CALL_TIMEOUT) below: contracts.mjs's MODEL_CALL_ERROR_CODES
      // is a closed 5-code set with no separate "caller aborted" code, and
      // the existing generic HTTP_CHAT_COMPLETIONS adapter already made
      // this exact same collapsing choice for its own internal-timeout
      // AbortError case -- this adapter stays consistent with that
      // precedent rather than inventing a new code.
      const externalAbort = () => controller.abort();
      if (request.signal instanceof AbortSignal) {
        if (request.signal.aborted) controller.abort();
        else request.signal.addEventListener("abort", externalAbort, { once: true });
      }
      try {
        let response;
        try {
          response = await fetchImpl(config.endpoint_url, {
            method: "POST",
            headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
            body: JSON.stringify(buildHcxRequestBody(request, config)),
            signal: controller.signal,
          });
        } catch (error) {
          if (error?.name === "AbortError") {
            throw new ModelCallError("MODEL_CALL_TIMEOUT", "model call timed out or was aborted", { cause: error });
          }
          // A raw network/transport failure (connection refused, DNS
          // failure, etc.) is never re-thrown with its own message -- only
          // the safe, fixed description plus the stable code.
          throw new ModelCallError("MODEL_CALL_UNKNOWN_ERROR", "model call failed before a response was received", { cause: error });
        }
        if (!response.ok) {
          throw new ModelCallError("MODEL_CALL_HTTP_ERROR", `model endpoint returned a non-OK HTTP status (${response.status})`);
        }
        let body;
        try {
          body = await response.json();
        } catch (error) {
          throw new ModelCallError("MODEL_CALL_MALFORMED_RESPONSE", "model response body was not valid JSON", { cause: error });
        }
        const parsed = parseHcxResponseBody(body);
        return {
          ...parsed,
          estimated_cost: costFor(parsed.input_tokens, config.input_cost_per_1k_tokens) + costFor(parsed.output_tokens, config.output_cost_per_1k_tokens),
          latency_ms: Date.now() - startedAt,
        };
      } finally {
        clearTimeout(timer);
        if (request.signal instanceof AbortSignal) request.signal.removeEventListener("abort", externalAbort);
      }
    },
  });
}
