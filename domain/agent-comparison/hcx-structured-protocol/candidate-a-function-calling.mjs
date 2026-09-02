// Turn P11-D, candidate A: HCX-005 Native Chat Completions v3 Function
// Calling client. NEVER throws -- every outcome (success, HTTP error,
// malformed tool call, timeout, network failure) is returned as a plain,
// non-sensitive outcome object so the runner (runner.mjs) can apply the
// exact same retry/hard-cap/aggregation logic to both candidates without a
// try/catch per call site. Never stores or returns the raw request body,
// the raw response body, the raw assistant content, or the raw tool-call
// arguments object -- only structural classification, counts, and (for a
// successful call only) the parsed used_fact_ids/used_evidence_ids arrays,
// which the caller needs for the evidence-id-authorization check and which
// are themselves just short synthetic ids, never free text.
import {
  buildFunctionCallingRequestBody,
  classifyNativeV3Envelope,
  classifyNativeV3ToolCallShape,
} from "./envelope-native-v3.mjs";
import { validateCommonStructuredAnswer } from "./common-schema.mjs";

export const CANDIDATE_A_ID = "NATIVE_V3_FUNCTION_CALLING";

function extractContentTypeMime(response) {
  try {
    const raw = typeof response?.headers?.get === "function" ? response.headers.get("content-type") : null;
    return typeof raw === "string" && raw !== "" ? raw.split(";")[0].trim().toLowerCase() : null;
  } catch {
    return null;
  }
}

function isAuthError(httpStatus) {
  return httpStatus === 401 || httpStatus === 403;
}

function isRetryableHttpStatus(httpStatus) {
  return httpStatus === 429 || (httpStatus >= 500 && httpStatus < 600);
}

// options: { prompt, endpointUrl, apiKey, maxOutputTokens, parametersSchema,
//            fetchImpl, timeoutMs }
export async function callCandidateA(options) {
  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  let response;
  try {
    try {
      response = await options.fetchImpl(options.endpointUrl, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${options.apiKey}` },
        body: JSON.stringify(buildFunctionCallingRequestBody({
          prompt: options.prompt,
          maxOutputTokens: options.maxOutputTokens,
          parametersSchema: options.parametersSchema,
        })),
        signal: controller.signal,
      });
    } catch (error) {
      const latencyMs = Date.now() - startedAt;
      if (error?.name === "AbortError") {
        return { ok: false, outcome_class: "TIMEOUT", http_status: null, retryable: false, auth_error: false, latency_ms: latencyMs, input_tokens: null, output_tokens: null };
      }
      return { ok: false, outcome_class: "NETWORK_ERROR", http_status: null, retryable: false, auth_error: false, latency_ms: latencyMs, input_tokens: null, output_tokens: null };
    }

    const latencyMs = Date.now() - startedAt;
    const httpStatus = Number.isFinite(response.status) ? response.status : null;
    const contentTypeMime = extractContentTypeMime(response);

    if (!response.ok) {
      return {
        ok: false,
        outcome_class: "HTTP_ERROR",
        http_status: httpStatus,
        content_type_mime: contentTypeMime,
        retryable: isRetryableHttpStatus(httpStatus),
        auth_error: isAuthError(httpStatus),
        latency_ms: latencyMs,
        input_tokens: null,
        output_tokens: null,
      };
    }

    let body;
    try {
      body = await response.json();
    } catch {
      return { ok: false, outcome_class: "OUTER_ENVELOPE_NOT_JSON", http_status: httpStatus, retryable: false, auth_error: false, latency_ms: latencyMs, input_tokens: null, output_tokens: null };
    }

    const envelopeClass = classifyNativeV3Envelope(body);
    if (envelopeClass !== "VALID") {
      return { ok: false, outcome_class: `ENVELOPE_${envelopeClass}`, http_status: httpStatus, retryable: false, auth_error: false, latency_ms: latencyMs, input_tokens: null, output_tokens: null };
    }

    const { shape_class: shapeClass, toolCallArguments } = classifyNativeV3ToolCallShape(body.result.message);
    const usage = body.result.usage ?? null;
    const inputTokens = Number.isFinite(usage?.promptTokens) ? usage.promptTokens : null;
    const outputTokens = Number.isFinite(usage?.completionTokens) ? usage.completionTokens : null;

    if (shapeClass !== "EXACTLY_ONE_MATCHING_TOOL_CALL") {
      return { ok: false, outcome_class: shapeClass, http_status: httpStatus, retryable: false, auth_error: false, latency_ms: latencyMs, input_tokens: inputTokens, output_tokens: outputTokens };
    }

    const validated = validateCommonStructuredAnswer(toolCallArguments);
    if (!validated.ok) {
      return { ok: false, outcome_class: "TOOL_CALL_ARGUMENTS_SCHEMA_INVALID", http_status: httpStatus, retryable: false, auth_error: false, latency_ms: latencyMs, input_tokens: inputTokens, output_tokens: outputTokens };
    }

    return {
      ok: true,
      outcome_class: "SUCCESS",
      http_status: httpStatus,
      retryable: false,
      auth_error: false,
      latency_ms: latencyMs,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      used_fact_ids: validated.value.used_fact_ids,
      used_evidence_ids: validated.value.used_evidence_ids,
      answer_length: validated.value.answer.length,
    };
  } finally {
    clearTimeout(timer);
  }
}
