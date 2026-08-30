// Deterministic fake ModelAdapter for tests and smoke runs (Turn P1;
// response shape hardened Turn P1.1). Never makes a network call, never
// depends on wall-clock time or randomness, so the same input always
// produces the exact same output -- required for synthetic contract tests
// and for the Seed 25 smoke runner to stay reproducible across
// machines/CI without any provider account.
//
// Response shape matches model-adapter.mjs's RESPONSE CONTRACT exactly:
// { text, used_fact_ids, used_evidence_ids, input_tokens, output_tokens,
//   estimated_cost, finish_reason }. A test that wants to simulate a
// FAILED model call passes a `responder` that throws (ideally a
// ModelCallError from model-adapter.mjs, so the failure carries a real
// MODEL_CALL_* code) -- this module does not catch or reinterpret that;
// it propagates exactly like a real failing adapter would.
import { createHash } from "node:crypto";

function wordCount(text) {
  const trimmed = typeof text === "string" ? text.trim() : "";
  return trimmed === "" ? 0 : trimmed.split(/\s+/).length;
}

// Deterministic, content-addressed default: no responder/fixture is
// required for the adapter to be usable, and the output text depends only
// on the request's own content (never on time, randomness, or any global
// counter). The default never claims to have used any fact/evidence id
// (used_fact_ids/used_evidence_ids are both empty) -- a caller that wants
// to exercise the grounded/citation-binding path must supply its own
// responder.
function defaultResponder(request) {
  const digest = createHash("sha256").update(request?.prompt ?? "").digest("hex").slice(0, 12);
  return { text: `[FAKE_DETERMINISTIC:${digest}] ${request?.prompt ?? ""}`.trim(), used_fact_ids: [], used_evidence_ids: [] };
}

export function createDeterministicFakeModelAdapter({
  modelConfigId = "model_fake-deterministic-v1",
  provider = "test-fixture",
  model = "deterministic-fake-v1",
  responder = defaultResponder,
} = {}) {
  return Object.freeze({
    modelConfigId,
    provider,
    model,
    async generate(request) {
      if (!request || typeof request.prompt !== "string" || request.prompt === "") {
        throw new TypeError("ModelAdapter.generate requires request.prompt (non-empty string)");
      }
      // Not wrapped in try/catch: a responder that throws (e.g. a test
      // simulating a model failure) propagates as-is, exactly like a real
      // failing HTTP_CHAT_COMPLETIONS adapter would -- this module never
      // swallows or reinterprets that failure.
      const result = responder(request);
      const text = typeof result === "string" ? result : result.text;
      if (typeof text !== "string") throw new TypeError("fake responder must return a string or {text}");
      const usedFactIds = Array.isArray(result?.used_fact_ids) ? result.used_fact_ids : [];
      const usedEvidenceIds = Array.isArray(result?.used_evidence_ids) ? result.used_evidence_ids : [];
      return {
        text,
        used_fact_ids: usedFactIds,
        used_evidence_ids: usedEvidenceIds,
        input_tokens: typeof result?.input_tokens === "number" ? result.input_tokens : wordCount(request.prompt),
        output_tokens: typeof result?.output_tokens === "number" ? result.output_tokens : wordCount(text),
        estimated_cost: 0,
        latency_ms: 0,
        finish_reason: "stop",
      };
    },
  });
}
