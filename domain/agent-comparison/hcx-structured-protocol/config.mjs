// Turn P11-D: config loader for the structured-output PROTOCOL comparison.
// Reads ONLY environment variables -- never a hardcoded secret (same
// fail-closed discipline as hcx-real-smoke/config.mjs). Candidate A reuses
// the SAME HCX_API_KEY/HCX_MODEL_ID/HCX_ENDPOINT_URL env vars the P11-A/B/C
// native-v3 smoke already uses (this Turn does not introduce a second way
// to configure the native v3 endpoint). Candidate B's endpoint is a fixed
// constant (candidate-b-response-format.mjs's CANDIDATE_B_ENDPOINT_URL) --
// deliberately NOT environment-configurable, so no caller can ever point
// candidate B at a different host (CLAUDE.md Turn P11-D section D).
//
// NEVER throws. `ready` is true only when API key + model id + a native v3
// endpoint URL are all present; the runner makes ZERO calls for either
// candidate when `ready` is false. `rawApiKey` is the only field here that
// ever holds the secret value; `redacted` is the only object this module
// produces that is safe to serialize into a report artifact.
import { randomUUID } from "node:crypto";
import { CANDIDATE_B_ENDPOINT_URL } from "./candidate-b-response-format.mjs";

const DEFAULT_MAX_OUTPUT_TOKENS = 1024; // candidate A's function-calling floor (envelope-native-v3.mjs); candidate B uses the same value for a fair comparison.

function envString(name) {
  const value = process.env[name];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function hostnameOf(urlString) {
  try {
    return new URL(urlString).hostname;
  } catch {
    return null;
  }
}

export function loadStructuredProtocolConfig({ env = process.env, runId = `hcx_structured_protocol_${randomUUID().replaceAll("-", "")}`, createdAt = new Date().toISOString() } = {}) {
  const rawApiKey = envString("HCX_API_KEY");
  const model = envString("HCX_MODEL_ID");
  const candidateAEndpointUrl = envString("HCX_ENDPOINT_URL");

  const missing = [];
  if (rawApiKey === undefined) missing.push("HCX_API_KEY");
  if (model === undefined) missing.push("HCX_MODEL_ID");
  if (candidateAEndpointUrl === undefined) missing.push("HCX_ENDPOINT_URL");

  const ready = missing.length === 0;
  const candidateAHostname = candidateAEndpointUrl ? hostnameOf(candidateAEndpointUrl) : null;
  const candidateAHttps = candidateAEndpointUrl ? (() => { try { return new URL(candidateAEndpointUrl).protocol === "https:"; } catch { return false; } })() : null;
  const candidateBHostname = hostnameOf(CANDIDATE_B_ENDPOINT_URL);

  const redacted = {
    run_id: runId,
    created_at: createdAt,
    model,
    candidate_a_endpoint_hostname: candidateAHostname,
    candidate_a_endpoint_https: candidateAHttps,
    candidate_b_endpoint_hostname: candidateBHostname,
    candidate_b_endpoint_https: true, // CANDIDATE_B_ENDPOINT_URL is a fixed https:// literal
    api_key_present: rawApiKey !== undefined,
    max_output_tokens: DEFAULT_MAX_OUTPUT_TOKENS,
    ready,
    missing_config: missing,
  };

  return {
    ready,
    missing,
    rawApiKey,
    model: model ?? null,
    candidateAEndpointUrl: candidateAEndpointUrl ?? null,
    maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
    redacted,
  };
}
