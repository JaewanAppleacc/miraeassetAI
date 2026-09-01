// Turn P11-B: config loader for the real HyperCLOVA X protocol smoke.
// Reads ONLY environment variables -- never a JSON/CLI-argument-carried
// secret, never a hardcoded real model_id/endpoint (CLAUDE.md Turn P11-A
// section B, still binding here since this module connects that same
// frozen adapter to a real endpoint for the first time).
//
// FAIL-CLOSED CONTRACT: loadHcxRealSmokeConfig() NEVER throws. It always
// returns { ready, missing, modelConfig, redacted, rawApiKey }.
// `ready` is true only when every one of api key / endpoint / model id is
// present; a caller (the runner) uses `ready`/`missing` to decide whether
// to attempt ANY real call at all -- 0 calls whenever `ready` is false.
// `rawApiKey` is the only field in the returned object that ever holds the
// secret value itself, and it is used ONLY to construct the ModelAdapter's
// api_key_env_var-backed lookup (which re-reads process.env itself -- see
// model-adapter.mjs's own construction-time API key check); nothing in
// this module ever copies rawApiKey into `redacted`, into a log line, or
// into any artifact. `redacted` is the ONLY object this module produces
// that is safe to serialize into hcx-real-smoke-config.redacted.v0.1.json.
import { randomUUID } from "node:crypto";
import { HARD_LIMITS, clampRequestTimeoutMs } from "./hard-limits.mjs";

export const DEFAULT_API_KEY_ENV_VAR = "HCX_API_KEY";
const DEFAULT_REQUEST_SCHEMA_VERSION = "hcx-chat-completions-v3";
const DEFAULT_RESPONSE_SCHEMA_VERSION = "hcx-chat-completions-v3";
const DEFAULT_PROVIDER_ID = "hcx";
const DEFAULT_TOP_P = 0.8;
const DEFAULT_TEMPERATURE = 0.3;
const DEFAULT_MAX_OUTPUT_TOKENS = 256;

function envString(name) {
  const value = process.env[name];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function envNumber(name, fallback) {
  const raw = envString(name);
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function envBoolean(name, fallback) {
  const raw = envString(name);
  if (raw === undefined) return fallback;
  return raw === "true" || raw === "1";
}

// Non-secret hostname parsed from a URL string -- never the full URL (which
// could in principle carry a query-string detail some future provider
// config sets). Returns null if the URL string is invalid.
function hostnameOf(urlString) {
  try {
    return new URL(urlString).hostname;
  } catch {
    return null;
  }
}

export function loadHcxRealSmokeConfig({ env = process.env, runId = `hcx_real_smoke_${randomUUID().replaceAll("-", "")}`, createdAt = new Date().toISOString() } = {}) {
  const apiKeyEnvVar = DEFAULT_API_KEY_ENV_VAR;
  const rawApiKey = typeof env[apiKeyEnvVar] === "string" && env[apiKeyEnvVar].trim() !== "" ? env[apiKeyEnvVar] : undefined;
  const endpointUrl = envString("HCX_ENDPOINT_URL");
  const modelId = envString("HCX_MODEL_ID");
  const providerId = envString("HCX_PROVIDER_ID") ?? DEFAULT_PROVIDER_ID;

  const missing = [];
  if (rawApiKey === undefined) missing.push(apiKeyEnvVar);
  if (endpointUrl === undefined) missing.push("HCX_ENDPOINT_URL");
  if (modelId === undefined) missing.push("HCX_MODEL_ID");

  const requestSchemaVersion = envString("HCX_REQUEST_SCHEMA_VERSION") ?? DEFAULT_REQUEST_SCHEMA_VERSION;
  const responseSchemaVersion = envString("HCX_RESPONSE_SCHEMA_VERSION") ?? DEFAULT_RESPONSE_SCHEMA_VERSION;
  const topP = envNumber("HCX_TOP_P", DEFAULT_TOP_P);
  const temperature = envNumber("HCX_TEMPERATURE", DEFAULT_TEMPERATURE);
  const maxOutputTokens = Math.trunc(envNumber("HCX_MAX_OUTPUT_TOKENS", DEFAULT_MAX_OUTPUT_TOKENS));
  const seedSupported = envBoolean("HCX_SEED_SUPPORTED", false);
  const requestTimeoutMs = clampRequestTimeoutMs(envNumber("HCX_REQUEST_TIMEOUT_MS", HARD_LIMITS.DEFAULT_REQUEST_TIMEOUT_MS));
  const inputCostPer1k = envString("HCX_INPUT_COST_PER_1K") !== undefined ? envNumber("HCX_INPUT_COST_PER_1K", undefined) : undefined;
  const outputCostPer1k = envString("HCX_OUTPUT_COST_PER_1K") !== undefined ? envNumber("HCX_OUTPUT_COST_PER_1K", undefined) : undefined;

  const ready = missing.length === 0;
  const endpointHostname = endpointUrl ? hostnameOf(endpointUrl) : null;
  const endpointHttps = endpointUrl ? (() => { try { return new URL(endpointUrl).protocol === "https:"; } catch { return false; } })() : null;

  // modelConfig: the exact ModelConfig object handed to createModelAdapter
  // when ready. Never constructed (left null) when not ready -- the runner
  // must never attempt to build an adapter, let alone call generate(), off
  // a partial config.
  const modelConfig = ready
    ? {
        schema_version: "0.1.0",
        model_config_id: `model_hcx-real-smoke-${runId.replace(/^hcx_real_smoke_/, "")}`,
        kind: "HCX_CHAT_COMPLETIONS",
        provider: providerId,
        model: modelId,
        endpoint_url: endpointUrl,
        api_key_env_var: apiKeyEnvVar,
        max_output_tokens: maxOutputTokens,
        temperature,
        top_p: topP,
        seed_supported: seedSupported,
        timeout_ms: requestTimeoutMs,
        request_schema_version: requestSchemaVersion,
        response_schema_version: responseSchemaVersion,
        actual_external_call_authorized: true,
        ...(inputCostPer1k !== undefined ? { input_cost_per_1k_tokens: inputCostPer1k } : {}),
        ...(outputCostPer1k !== undefined ? { output_cost_per_1k_tokens: outputCostPer1k } : {}),
      }
    : null;

  const redacted = {
    schema_version: "0.1.0",
    run_id: runId,
    created_at: createdAt,
    provider_id: providerId,
    model_id: modelId ?? null,
    endpoint_hostname: endpointHostname,
    endpoint_https: endpointHttps,
    api_key_env_var_name: apiKeyEnvVar,
    api_key_present: rawApiKey !== undefined,
    request_schema_version: requestSchemaVersion,
    response_schema_version: responseSchemaVersion,
    max_output_tokens: maxOutputTokens,
    temperature,
    top_p: topP,
    seed_supported: seedSupported,
    request_timeout_ms: requestTimeoutMs,
    retry_max_attempts: HARD_LIMITS.RETRY_MAX_ATTEMPTS,
    maximum_requests: HARD_LIMITS.MAXIMUM_REQUESTS,
    concurrency: HARD_LIMITS.CONCURRENCY,
    overall_time_budget_ms: HARD_LIMITS.OVERALL_TIME_BUDGET_MS,
    cost_configured: inputCostPer1k !== undefined || outputCostPer1k !== undefined,
    actual_external_call_authorized: ready,
    ready,
    missing_config: missing,
  };

  return { ready, missing, apiKeyEnvVar, modelConfig, redacted, rawApiKey };
}
