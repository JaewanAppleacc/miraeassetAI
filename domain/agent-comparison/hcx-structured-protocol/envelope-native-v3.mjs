// Turn P11-D, candidate A: request/response envelope for HCX-005 Native
// Chat Completions v3 Function Calling. Deliberately a SEPARATE module from
// envelope-openai-compatible.mjs (CLAUDE.md Turn P11-D section D: "Native
// v3와 OpenAI-compatible envelope parser 분리") -- the two providers' outer
// envelopes are structurally different (status/result vs choices) and this
// Turn's own selection criteria (tool-call structural checks vs
// response_format content checks) never share a code path.
//
// Shape sourced from https://api.ncloud-docs.com/docs/en/clovastudio-chatcompletionsv3-fc
// (2026-09, fetched this Turn): tools[].function.{name,description,parameters},
// toolChoice as an object forces exactly one named tool; a successful tool
// call appears at result.message.toolCalls[] with function.arguments as a
// JSON OBJECT (not a string, unlike the plain-text content path used by
// P11-A/B/C's existing hcx-model-adapter.mjs). Docs also require
// maxTokens/maxCompletionTokens >= 1024 whenever tools are sent.
export const FUNCTION_CALLING_TOOL_NAME = "submit_grounded_answer";
export const FUNCTION_CALLING_MIN_MAX_TOKENS = 1024;

// Same JSON Schema COMMON_STRUCTURED_ANSWER_SCHEMA validates against, minus
// the $schema/$id/title meta-keywords a `parameters` field has no room for.
export function toolParametersSchema(commonSchema) {
  const { $schema, $id, title, ...rest } = commonSchema;
  return rest;
}

export function buildFunctionCallingRequestBody({ prompt, maxOutputTokens, parametersSchema }) {
  return {
    messages: [{ role: "user", content: prompt }],
    topP: 0.8,
    topK: 0,
    maxTokens: Math.max(maxOutputTokens, FUNCTION_CALLING_MIN_MAX_TOKENS),
    temperature: 0,
    repetitionPenalty: 1.1,
    stop: [],
    includeAiFilters: true,
    tools: [
      {
        type: "function",
        function: {
          name: FUNCTION_CALLING_TOOL_NAME,
          description: "Submit the final grounded answer. Call this tool exactly once with the answer and the fact/evidence ids actually used; never respond in plain text.",
          parameters: parametersSchema,
        },
      },
    ],
    toolChoice: { type: "function", function: { name: FUNCTION_CALLING_TOOL_NAME } },
  };
}

// Structural classification of the OUTER envelope only -- never returns or
// logs a field value from `body`, only which shape class it falls into.
// Mirrors hcx-model-adapter.mjs's classifyHcxOuterEnvelope but does NOT
// require result.message.content (a tool-call-only response legitimately
// has an empty/absent content string).
export function classifyNativeV3Envelope(body) {
  if (typeof body?.status?.code !== "string") return "MISSING_STATUS_CODE";
  if (body.status.code !== "20000") return "STATUS_NOT_SUCCESS";
  if (typeof body?.result?.message !== "object" || body.result.message === null) return "MISSING_MESSAGE";
  return "VALID";
}

// Structural classification of the assistant message's tool-call shape.
// Never returns or logs a field value -- only the classification and (for
// EXACTLY_ONE_MATCHING_TOOL_CALL) the single tool call's arguments object,
// which the caller must still schema-validate before trusting it.
export function classifyNativeV3ToolCallShape(message) {
  const content = typeof message?.content === "string" ? message.content : "";
  const contentIsBlank = content.trim() === "";
  const toolCalls = Array.isArray(message?.toolCalls) ? message.toolCalls : null;

  if (!contentIsBlank) return { shape_class: "NATURAL_LANGUAGE_CONTENT_PRESENT", toolCallArguments: null };
  if (toolCalls === null || toolCalls.length === 0) return { shape_class: "TOOL_CALL_MISSING", toolCallArguments: null };
  if (toolCalls.length > 1) return { shape_class: "TOOL_CALL_DUPLICATE", toolCallArguments: null };

  const [call] = toolCalls;
  if (call?.type !== "function" || typeof call?.function?.name !== "string") {
    return { shape_class: "TOOL_CALL_MALFORMED", toolCallArguments: null };
  }
  if (call.function.name !== FUNCTION_CALLING_TOOL_NAME) {
    return { shape_class: "TOOL_CALL_NAME_MISMATCH", toolCallArguments: null };
  }
  const args = call.function.arguments;
  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    return { shape_class: "TOOL_CALL_ARGUMENTS_NOT_OBJECT", toolCallArguments: null };
  }
  return { shape_class: "EXACTLY_ONE_MATCHING_TOOL_CALL", toolCallArguments: args };
}
