// Turn P11-D, candidate B: request/response envelope for HCX-005 via
// CLOVA Studio's OpenAI-compatible endpoint
// (https://clovastudio.stream.ntruss.com/v1/openai/chat/completions),
// response_format.type=json_schema. Deliberately a SEPARATE module from
// envelope-native-v3.mjs -- see that file's header and CLAUDE.md Turn P11-D
// section D ("Native v3와 OpenAI-compatible envelope parser 분리").
//
// Shape sourced from https://api.ncloud-docs.com/docs/en/clovastudio-openaicompatibility
// and https://api.ncloud-docs.com/docs/en/clovastudio-chatcompletionsv3-so
// (2026-09, fetched this Turn): an OpenAI-shaped {choices[].message.content}
// response where content is a JSON STRING (not a native object) -- the
// Structured Outputs doc's own example shows an escaped-string content
// field even when response_format constrains it to a schema. Docs also
// state native v3's own `responseFormat` is HCX-007-only; whether this
// SEPARATE OpenAI-compatible endpoint's response_format works for HCX-005
// is exactly the empirical question this Turn's real comparison answers --
// a 4xx here is recorded, never retried, and never silently swapped for a
// different endpoint or model (CLAUDE.md Turn P11-D section D).
export const JSON_SCHEMA_NAME = "grounded_answer";

// Same JSON Schema COMMON_STRUCTURED_ANSWER_SCHEMA validates against, minus
// the $schema/$id/title meta-keywords the OpenAI-compatible
// response_format.json_schema.schema field has no room for.
function bareSchema(commonSchema) {
  const { $schema, $id, title, ...rest } = commonSchema;
  return rest;
}

export function buildResponseFormatRequestBody({ prompt, model, maxOutputTokens, commonSchema }) {
  return {
    model,
    messages: [{ role: "user", content: prompt }],
    temperature: 0,
    max_tokens: maxOutputTokens,
    response_format: {
      type: "json_schema",
      json_schema: { name: JSON_SCHEMA_NAME, schema: bareSchema(commonSchema) },
    },
  };
}

// Structural classification of the OUTER (OpenAI-shaped) envelope only --
// never returns or logs a field value from `body`.
export function classifyOpenAiCompatibleEnvelope(body) {
  if (!Array.isArray(body?.choices) || body.choices.length === 0) return "MISSING_CHOICES";
  if (body.choices.length > 1) return "MULTIPLE_CHOICES";
  const message = body.choices[0]?.message;
  if (typeof message?.content !== "string") return "MISSING_MESSAGE_CONTENT";
  return "VALID";
}

function isSyntacticJson(candidate) {
  try {
    JSON.parse(candidate);
    return true;
  } catch {
    return false;
  }
}

// Turn P11-D section D: "content 전체가 단일 JSON. code fence/앞뒤 설명/다중
// JSON/빈 content 거부" -- STRICTER than hcx-model-adapter.mjs's own
// classifyHcxAssistantContent (which tolerates a single ```json fence for
// the prompt-only P11-A/B/C path). Only the whole trimmed string being
// exactly one JSON value is ever accepted; a fence, explanatory text,
// multiple concatenated JSON values, or truncated JSON are all rejected
// without ever trying to extract a substring from them.
export function classifyOpenAiCompatibleContent(rawContent) {
  const trimmed = rawContent.trim();
  if (trimmed === "") return { content_class: "EMPTY", extractedJsonText: null };
  if (isSyntacticJson(trimmed)) return { content_class: "PLAIN_JSON", extractedJsonText: trimmed };
  if (trimmed.includes("```")) return { content_class: "FENCED_OR_MIXED_REJECTED", extractedJsonText: null };
  if (/[{[]/.test(trimmed)) return { content_class: "TEXT_WITH_EMBEDDED_OR_TRUNCATED_JSON", extractedJsonText: null };
  return { content_class: "NOT_JSON_AT_ALL", extractedJsonText: null };
}
