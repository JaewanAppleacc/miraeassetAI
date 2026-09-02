// Model adapter interface for cross-LLM comparison (Turn P1's "기반 LLM
// 차이" axis; hardened Turn P1.1). This is DELIBERATELY separate from
// domain/runtime/agent-runtime.mjs's hcxClient: hcxClient.explain() is a
// proof-bound, non-text-generating stub reserved for the frozen
// SharedServices contract (CLAUDE.md section 5) and is never touched here.
// A ModelAdapter is a plain, additional collaborator an AgentFlow may hold
// via closure -- it is not part of SharedServices and is never wrapped by
// runAgentFlow's own ExecutionTrace instrumentation. Callers that want
// model-call telemetry use instrumentModelAdapter (telemetry.mjs) instead.
//
// PROTOCOL SCOPE (Turn P1.1 correction): kind:"HTTP_CHAT_COMPLETIONS" is
// ONE generic Chat-Completions-compatible protocol adapter -- it is NOT a
// universal "supports every model provider" claim. It only works for a
// provider whose HTTP endpoint accepts {model, messages, max_tokens,
// temperature} and replies with {choices:[{message:{content}, finish_reason}],
// usage:{prompt_tokens, completion_tokens}}. A provider with a materially
// different request/response shape (a different tool-call format, a
// streaming-only API, a non-JSON response envelope, etc.) needs its OWN
// adapter kind added to MODEL_ADAPTER_KINDS (contracts.mjs) and its own
// construction branch here -- provider differences are meant to be
// expressed as a distinct adapter *capability*, never papered over inside
// this one generic branch. Before comparing models across providers, the
// caller is responsible for verifying the target provider actually speaks
// this protocol shape (or that its own adapter kind exists) -- this module
// does not probe or negotiate that. No specific provider or model name is
// ever hardcoded anywhere in this file. No real network call is made by
// anything in this Turn's tests or scripts -- every HTTP_CHAT_COMPLETIONS
// test injects its own fetchImpl.
//
// Turn P11-A: kind:"HCX_CHAT_COMPLETIONS" is exactly such a distinct
// adapter kind -- HyperCLOVA X's Chat Completions envelope is NOT the same
// shape as the generic one above (messages/topP/topK/maxTokens field names,
// a status+result response envelope). Its construction branch and all
// HCX-specific request/response/security logic live in
// hcx-model-adapter.mjs, not inline here, so the two protocol shapes never
// bleed into each other. See that file's own header comment for the full
// contract (fail-closed schema-version pinning, loopback-only mock
// authorization, endpoint HTTPS/hostname checks).
//
// Turn P11-E: kind:"HCX_NATIVE_V3_FUNCTION_CALLING" is the officially
// registered adapter for HCX-005's Native v3 Function Calling protocol --
// the candidate P11-D's bounded real-API comparison selected (15/15, zero
// violations; response_format=json_schema went 0/15 HTTP 400 on the same
// run). Its request builder and structural parsers are reused UNCHANGED
// from hcx-structured-protocol/envelope-native-v3.mjs; see
// hcx-native-function-calling-adapter.mjs's own header for the full
// contract (forced single submit_grounded_answer tool call, fixed
// clovastudio.stream.ntruss.com hostname with no loopback-mock exception,
// bounded 429/5xx-only retry).
//
// RESPONSE CONTRACT (Turn P1.1): generate() resolves to
// { text, used_fact_ids: string[], used_evidence_ids: string[],
//   input_tokens, output_tokens, estimated_cost, finish_reason }.
// used_fact_ids/used_evidence_ids are the model's OWN claim about which
// already-grounded ids its answer drew on -- a Flow must still verify that
// claim against the ids it actually authorized/validated this request
// (see flows/hard-claim-grounding.mjs) before trusting the answer text.
//
// FAILURE CONTRACT (Turn P1.1): a failed generate() call ALWAYS throws
// (never returns a synthetic "ok:false" value) with a stable `.code` drawn
// from contracts.mjs's MODEL_CALL_ERROR_CODES -- MODEL_CALL_TIMEOUT,
// MODEL_CALL_HTTP_ERROR, MODEL_CALL_MALFORMED_RESPONSE, or
// MODEL_CALL_UNKNOWN_ERROR (construction-time key-missing failures use
// MODEL_ADAPTER_UNAVAILABLE instead -- see below). The thrown Error's
// `.message` NEVER contains the raw provider response body, a raw
// exception message from the underlying fetch, or the API key value --
// only a fixed, generic description plus the safe `.code`. The caller
// (instrumentModelAdapter in telemetry.mjs, then the AgentFlow) decides
// what to do about a failure; this module never silently substitutes a
// fallback answer of its own.
import { validateModelConfig } from "./contracts.mjs";
import { createDeterministicFakeModelAdapter } from "./fake-model-adapter.mjs";
import { createHcxChatCompletionsModelAdapter } from "./hcx-model-adapter.mjs";
import { createHcxNativeFunctionCallingModelAdapter } from "./hcx-native-function-calling-adapter.mjs";
import { ModelAdapterUnavailableError } from "./model-adapter-unavailable-error.mjs";
import { ModelCallError } from "./model-call-error.mjs";
import { parseStructuredAnswer } from "./structured-answer-parsing.mjs";

// Re-exported (see ModelCallError's own re-export comment below): the class
// itself now lives in model-adapter-unavailable-error.mjs so
// hcx-model-adapter.mjs can throw it without importing this module.
export { ModelAdapterUnavailableError };

export class InvalidModelConfigError extends Error {
  constructor(errors) {
    super(`invalid ModelConfig: ${errors.join("; ")}`);
    this.name = "InvalidModelConfigError";
    this.errors = errors;
  }
}

// Re-exported so existing `import { ModelCallError } from "./model-adapter.mjs"`
// call sites (tests included) keep working unchanged -- the class itself now
// lives in model-call-error.mjs (Turn P11-A) so hcx-model-adapter.mjs can
// throw/catch the exact same class without importing this module (which
// would create a circular import, since this module also imports FROM
// hcx-model-adapter.mjs to construct an HCX_CHAT_COMPLETIONS adapter).
export { ModelCallError };

function costFor(tokens, costPer1k) {
  if (typeof costPer1k !== "number" || !Number.isFinite(costPer1k)) return 0;
  return (tokens / 1000) * costPer1k;
}

// Minimal generic "chat completions" request/response shape (see the
// PROTOCOL SCOPE header comment above) -- this is intentionally the ONLY
// HTTP shape this module knows about, and no provider name ever appears in
// this function.
function createHttpChatCompletionsModelAdapter(config, { fetchImpl = fetch } = {}) {
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
    async generate(request) {
      if (!request || typeof request.prompt !== "string" || request.prompt === "") {
        throw new TypeError("ModelAdapter.generate requires request.prompt (non-empty string)");
      }
      const startedAt = Date.now();
      const controller = new AbortController();
      const timeoutMs = config.timeout_ms ?? 30000;
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const messages = [];
        if (typeof request.system === "string" && request.system !== "") messages.push({ role: "system", content: request.system });
        messages.push({ role: "user", content: request.prompt });
        let response;
        try {
          response = await fetchImpl(config.endpoint_url, {
            method: "POST",
            headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
            body: JSON.stringify({
              model: config.model,
              messages,
              max_tokens: request.max_output_tokens ?? config.max_output_tokens,
              temperature: request.temperature ?? config.temperature,
            }),
            signal: controller.signal,
          });
        } catch (error) {
          if (error?.name === "AbortError") {
            throw new ModelCallError("MODEL_CALL_TIMEOUT", "model call timed out", { cause: error });
          }
          // A raw network/transport failure is never re-thrown with its own
          // message (it may embed the endpoint URL, DNS detail, etc.) --
          // only the safe, fixed description plus the stable code.
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
        const rawContent = body?.choices?.[0]?.message?.content;
        if (typeof rawContent !== "string") {
          throw new ModelCallError("MODEL_CALL_MALFORMED_RESPONSE", "model response did not contain choices[0].message.content");
        }
        const structured = parseStructuredAnswer(rawContent);
        const inputTokens = Number.isFinite(body?.usage?.prompt_tokens) ? body.usage.prompt_tokens : 0;
        const outputTokens = Number.isFinite(body?.usage?.completion_tokens) ? body.usage.completion_tokens : 0;
        return {
          ...structured,
          input_tokens: inputTokens,
          output_tokens: outputTokens,
          estimated_cost: costFor(inputTokens, config.input_cost_per_1k_tokens) + costFor(outputTokens, config.output_cost_per_1k_tokens),
          latency_ms: Date.now() - startedAt,
          finish_reason: body?.choices?.[0]?.finish_reason ?? null,
        };
      } finally {
        clearTimeout(timer);
      }
    },
  });
}

// Single construction point: a caller never picks a provider-specific
// implementation directly, only a ModelConfig. kind decides which generic
// implementation backs it; provider/model themselves never do.
export function createModelAdapter(config, options = {}) {
  const errors = validateModelConfig(config);
  if (errors.length > 0) throw new InvalidModelConfigError(errors);
  if (config.kind === "FAKE_DETERMINISTIC") {
    return createDeterministicFakeModelAdapter({ modelConfigId: config.model_config_id, provider: config.provider, model: config.model, ...options.fake });
  }
  if (config.kind === "HTTP_CHAT_COMPLETIONS") {
    return createHttpChatCompletionsModelAdapter(config, options);
  }
  if (config.kind === "HCX_CHAT_COMPLETIONS") {
    return createHcxChatCompletionsModelAdapter(config, options);
  }
  if (config.kind === "HCX_NATIVE_V3_FUNCTION_CALLING") {
    return createHcxNativeFunctionCallingModelAdapter(config, options);
  }
  throw new InvalidModelConfigError([`unsupported kind: ${config.kind}`]);
}
