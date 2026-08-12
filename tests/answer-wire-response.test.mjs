import assert from "node:assert/strict";
import test from "node:test";
import {
  fromAnswerWireResponse,
  fromAnswerWireResponseSafe,
  isValidAnswerWireResponse,
  toAnswerWireResponse,
  validateAnswerWireResponse,
} from "../domain/runtime/answer-wire-response.mjs";

function internalFinalResponse(overrides = {}) {
  return {
    question: "질문",
    retrieved_context: [{ document_id: "major_20241115000375" }],
    think_trace: { execution_mode: "STRUCTURED", operations: ["op"], calculation: { a: 1 }, validation: { ok: true } },
    answer: "답변",
    ...overrides,
  };
}

// --- schema validation ------------------------------------------------------

test("a well-formed 5-string wire body is valid", () => {
  const wire = { question_id: "Q-1", question: "q", retrieved_context: "[]", think_trace: "{}", answer: "a" };
  assert.equal(isValidAnswerWireResponse(wire), true);
  assert.deepEqual(validateAnswerWireResponse(wire), []);
});

test("rejects a wire body missing any of the 5 required fields", () => {
  const full = { question_id: "Q-1", question: "q", retrieved_context: "[]", think_trace: "{}", answer: "a" };
  for (const key of Object.keys(full)) {
    const { [key]: _omit, ...withoutField } = full;
    assert.equal(isValidAnswerWireResponse(withoutField), false, `expected missing "${key}" to be invalid`);
  }
});

test("rejects additional properties beyond the 5 required fields", () => {
  const wire = { question_id: "Q-1", question: "q", retrieved_context: "[]", think_trace: "{}", answer: "a", extra: "not allowed" };
  assert.equal(isValidAnswerWireResponse(wire), false);
});

test("rejects a wire body where retrieved_context/think_trace are NOT strings (e.g. still arrays/objects)", () => {
  const wire = { question_id: "Q-1", question: "q", retrieved_context: [], think_trace: {}, answer: "a" };
  assert.equal(isValidAnswerWireResponse(wire), false);
});

test("rejects non-string question_id/question/answer", () => {
  const base = { question_id: "Q-1", question: "q", retrieved_context: "[]", think_trace: "{}", answer: "a" };
  assert.equal(isValidAnswerWireResponse({ ...base, question_id: 123 }), false);
  assert.equal(isValidAnswerWireResponse({ ...base, question: null }), false);
  assert.equal(isValidAnswerWireResponse({ ...base, answer: {} }), false);
});

test("never throws for adversarial candidates (circular reference, throwing getter)", () => {
  const circular = { question_id: "Q-1" };
  circular.self = circular;
  assert.doesNotThrow(() => validateAnswerWireResponse(circular));
  assert.equal(isValidAnswerWireResponse(circular), false);

  const throwing = {
    get question_id() {
      throw new Error("boom");
    },
  };
  assert.doesNotThrow(() => validateAnswerWireResponse(throwing));
  assert.equal(isValidAnswerWireResponse(throwing), false);
});

test("an empty string is a valid value for every one of the 5 fields (schema requires string, not non-empty)", () => {
  const wire = { question_id: "", question: "", retrieved_context: "[]", think_trace: "{}", answer: "" };
  assert.equal(isValidAnswerWireResponse(wire), true);
});

// --- internal -> external conversion ---------------------------------------

test("toAnswerWireResponse produces exactly the 5 required string fields", () => {
  const wire = toAnswerWireResponse("Q-001", internalFinalResponse());
  assert.deepEqual(Object.keys(wire).sort(), ["answer", "question", "question_id", "retrieved_context", "think_trace"]);
  for (const key of Object.keys(wire)) assert.equal(typeof wire[key], "string", `${key} must be a string`);
});

test("toAnswerWireResponse uses the given questionId, never anything from finalResponse", () => {
  const wire = toAnswerWireResponse("Q-CALLER-SUPPLIED", internalFinalResponse());
  assert.equal(wire.question_id, "Q-CALLER-SUPPLIED");
});

test("toAnswerWireResponse copies question and answer through unchanged", () => {
  const internal = internalFinalResponse({ question: "질문 원문", answer: "답변 원문" });
  const wire = toAnswerWireResponse("Q-1", internal);
  assert.equal(wire.question, "질문 원문");
  assert.equal(wire.answer, "답변 원문");
});

test("toAnswerWireResponse JSON-encodes retrieved_context and think_trace exactly (JSON.stringify)", () => {
  const internal = internalFinalResponse();
  const wire = toAnswerWireResponse("Q-1", internal);
  assert.equal(wire.retrieved_context, JSON.stringify(internal.retrieved_context));
  assert.equal(wire.think_trace, JSON.stringify(internal.think_trace));
});

test("toAnswerWireResponse output always satisfies the wire schema", () => {
  const wire = toAnswerWireResponse("Q-1", internalFinalResponse());
  assert.equal(isValidAnswerWireResponse(wire), true);
});

test("toAnswerWireResponse never leaks a sibling execution_trace field even if present on the caller's object", () => {
  const internal = internalFinalResponse();
  internal.execution_trace = { flow_id: "secret" };
  const wire = toAnswerWireResponse("Q-1", internal);
  assert.equal(wire.execution_trace, undefined);
  assert.ok(!JSON.stringify(wire).includes("secret"));
});

// --- external -> internal conversion (round trip) --------------------------

test("fromAnswerWireResponse recovers the exact original retrieved_context array and think_trace object", () => {
  const internal = internalFinalResponse();
  const wire = toAnswerWireResponse("Q-1", internal);
  const restored = fromAnswerWireResponse(wire);
  assert.deepEqual(restored.retrieved_context, internal.retrieved_context);
  assert.deepEqual(restored.think_trace, internal.think_trace);
  assert.equal(restored.question, internal.question);
  assert.equal(restored.answer, internal.answer);
});

test("round trip: toAnswerWireResponse then fromAnswerWireResponse reproduces the original FinalResponse fields exactly", () => {
  const internal = internalFinalResponse({
    retrieved_context: [{ nested: { deep: [1, 2, 3] } }, "string item", 42, null],
    think_trace: { execution_mode: "BOTH", operations: [{ op: "lookup" }], calculation: { result: 100 }, validation: { evidence_supported: true } },
  });
  const wire = toAnswerWireResponse("Q-ROUNDTRIP", internal);
  const restored = fromAnswerWireResponse(wire);
  assert.deepEqual(restored, { question: internal.question, retrieved_context: internal.retrieved_context, think_trace: internal.think_trace, answer: internal.answer });
});

test("fromAnswerWireResponse throws when retrieved_context is not valid JSON", () => {
  const wire = { question_id: "Q-1", question: "q", retrieved_context: "not json", think_trace: "{}", answer: "a" };
  assert.throws(() => fromAnswerWireResponse(wire));
});

test("fromAnswerWireResponse throws when think_trace is not valid JSON", () => {
  const wire = { question_id: "Q-1", question: "q", retrieved_context: "[]", think_trace: "not json", answer: "a" };
  assert.throws(() => fromAnswerWireResponse(wire));
});

// --- safe (non-throwing) external -> internal conversion --------------------

test("fromAnswerWireResponseSafe returns ok:true with the restored value for a valid wire body", () => {
  const internal = internalFinalResponse();
  const wire = toAnswerWireResponse("Q-1", internal);
  const result = fromAnswerWireResponseSafe(wire);
  assert.equal(result.ok, true);
  assert.deepEqual(result.value.retrieved_context, internal.retrieved_context);
});

test("fromAnswerWireResponseSafe returns ok:false, never throws, when retrieved_context is malformed JSON", () => {
  const wire = { question_id: "Q-1", question: "q", retrieved_context: "{not valid", think_trace: "{}", answer: "a" };
  assert.doesNotThrow(() => fromAnswerWireResponseSafe(wire));
  const result = fromAnswerWireResponseSafe(wire);
  assert.equal(result.ok, false);
  assert.equal(typeof result.error, "string");
});

test("fromAnswerWireResponseSafe returns ok:false, never throws, when think_trace is malformed JSON", () => {
  const wire = { question_id: "Q-1", question: "q", retrieved_context: "[]", think_trace: "{not valid", answer: "a" };
  const result = fromAnswerWireResponseSafe(wire);
  assert.equal(result.ok, false);
});
