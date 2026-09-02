// Turn P11-D, candidate B: HCX-005 via CLOVA Studio's OpenAI-compatible
// endpoint, response_format.type=json_schema. Mirrors
// candidate-a-function-calling.mjs's own never-throws, never-store-raw-
// content contract exactly -- see that file's header for the shared
// rationale. This module's endpoint and model are FIXED per CLAUDE.md Turn
// P11-D section D ("endpoint fallback 및 모델 변경 금지"): no caller of this
// module may pass a different endpoint/model in as a "fallback".
import {
  buildResponseFormatRequestBody,
  classifyOpenAiCompatibleEnvelope,
  classifyOpenAiCompatibleContent,
} from "./envelope-openai-compatible.mjs";
import { validateCommonStructuredAnswer } from "./common-schema.mjs";

export const CANDIDATE_B_ID = "OPENAI_COMPATIBLE_RESPONSE_FORMAT";
export const CANDIDATE_B_ENDPOINT_URL = "https://clovastudio.stream.ntruss.com/v1/openai/chat/completions";

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

// Turn P11-D section D: "4xx unsupported는 기록 후 재시도 금지" -- only
// 429/5xx are ever retryable for this candidate, exactly like candidate A
// and hcx-real-smoke's own existing retry rule.
function isRetryableHttpStatus(httpStatus) {
  return httpStatus === 429 || (httpStatus >= 500 && httpStatus < 600);
}

// options: { prompt, model, apiKey, maxOutputTokens, commonSchema,
//            fetchImpl, timeoutMs }
export async function callCandidateB(options) {
  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  let response;
  try {
    try {
      response = await options.fetchImpl(CANDIDATE_B_ENDPOINT_URL, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${options.apiKey}` },
        body: JSON.stringify(buildResponseFormatRequestBody({
          prompt: options.prompt,
          model: options.model,
          maxOutputTokens: options.maxOutputTokens,
          commonSchema: options.commonSchema,
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
        outcome_class: httpStatus !== null && httpStatus >= 400 && httpStatus < 500 ? "HTTP_4XX_UNSUPPORTED_OR_REJECTED" : "HTTP_ERROR",
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

    const envelopeClass = classifyOpenAiCompatibleEnvelope(body);
    if (envelopeClass !== "VALID") {
      return { ok: false, outcome_class: `ENVELOPE_${envelopeClass}`, http_status: httpStatus, retryable: false, auth_error: false, latency_ms: latencyMs, input_tokens: null, output_tokens: null };
    }

    const rawContent = body.choices[0].message.content;
    const usage = body.usage ?? null;
    const inputTokens = Number.isFinite(usage?.prompt_tokens) ? usage.prompt_tokens : null;
    const outputTokens = Number.isFinite(usage?.completion_tokens) ? usage.completion_tokens : null;

    const { content_class: contentClass, extractedJsonText } = classifyOpenAiCompatibleContent(rawContent);
    if (extractedJsonText === null) {
      return { ok: false, outcome_class: `CONTENT_${contentClass}`, http_status: httpStatus, retryable: false, auth_error: false, latency_ms: latencyMs, input_tokens: inputTokens, output_tokens: outputTokens };
    }

    let parsedJson;
    try {
      parsedJson = JSON.parse(extractedJsonText);
    } catch {
      return { ok: false, outcome_class: "CONTENT_JSON_PARSE_FAILED", http_status: httpStatus, retryable: false, auth_error: false, latency_ms: latencyMs, input_tokens: inputTokens, output_tokens: outputTokens };
    }

    const validated = validateCommonStructuredAnswer(parsedJson);
    if (!validated.ok) {
      return { ok: false, outcome_class: "CONTENT_SCHEMA_INVALID", http_status: httpStatus, retryable: false, auth_error: false, latency_ms: latencyMs, input_tokens: inputTokens, output_tokens: outputTokens };
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
