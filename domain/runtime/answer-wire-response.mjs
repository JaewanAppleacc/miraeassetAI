// The official EXTERNAL GET /answer wire contract (CLAUDE.md section 0/2,
// updated per organizer API notice: the outer wire body is now exactly five
// string fields -- question_id, question, retrieved_context, think_trace,
// answer). This module is the SINGLE place that:
//
//   1. Validates a candidate against domain/interfaces/
//      answer-wire-response.schema.json (validateAnswerWireResponse /
//      isValidAnswerWireResponse) -- same Ajv2020 + safe round-trip pattern
//      as final-response-validator.mjs, since a wire body is exactly the
//      kind of externally-observable, must-be-JSON-safe value that
//      trust-boundary hardening exists for.
//   2. Converts an internal FinalResponse (question/retrieved_context array/
//      think_trace object/answer, see final-response.schema.json) into this
//      wire shape (toAnswerWireResponse) -- used by domain/runtime/
//      answer-handler.mjs when building every GET /answer response body.
//   3. Converts a wire body BACK into the internal shape
//      (fromAnswerWireResponse) -- used by the Evaluation Harness after a
//      real HTTP call, so its existing metric scorers (which expect
//      retrieved_context as an array and think_trace as an object) keep
//      working unchanged.
//
// This is NOT final-response.schema.json (internal: retrieved_context is an
// array, think_trace is an object) -- see that schema's own header comment
// and domain/interfaces/README.md's "Agent -> External Caller" section for
// why the two are deliberately different shapes at different boundaries.
// domain/runtime/final-response-validator.mjs must never be applied
// directly to a wire body (it would always fail: a wire body's
// retrieved_context/think_trace are strings, not an array/object), and this
// module's validator must never be applied to an internal FinalResponse for
// the same reason in reverse.
//
// retrieved_context and think_trace are ALWAYS JSON-encoded (JSON.stringify)
// -- this encoding is fixed, not configurable, and documented in
// domain/interfaces/README.md. Only the internal FinalResponse's own
// structured think_trace (execution_mode/operations/calculation/validation)
// is ever serialized here -- never a raw execution_trace, hidden
// chain-of-thought, system prompt, or secret; answer-handler.mjs already
// never reads execution_trace at all (see its own header comment), so
// there is nothing of that shape for this module to accidentally encode.

import { validateAnswerWireResponseSchema } from "../generated/runtime-schema-validators.mjs";

// Mirrors final-response-validator.mjs's safeSchemaCheck: the compiled
// validator can itself throw (a circular object, a throwing getter), so
// this is never allowed to propagate an exception to the caller.
function safeSchemaCheck(candidate) {
  try {
    const ok = validateAnswerWireResponseSchema(candidate);
    return ok ? { ok: true } : { ok: false, errors: validateAnswerWireResponseSchema.errors ?? [] };
  } catch (error) {
    return { ok: false, thrown: error };
  }
}

// Mirrors final-response-validator.mjs's safeStringifyThenParse: passing
// the raw-candidate schema check is necessary but not sufficient -- a
// toJSON() (even a non-enumerable one) can make JSON.stringify() ship a
// completely different value than the one just checked, so the actual
// parsed wire value has to be schema-checked too.
function safeStringifyThenParse(candidate) {
  let serialized;
  try {
    serialized = JSON.stringify(candidate);
  } catch (error) {
    return { ok: false, thrown: error };
  }
  if (typeof serialized !== "string") {
    return { ok: false, message: "JSON.stringify did not return a string (a toJSON() may have returned undefined)" };
  }
  try {
    return { ok: true, parsed: JSON.parse(serialized) };
  } catch (error) {
    return { ok: false, thrown: error };
  }
}

function describeThrown(error) {
  if (error instanceof Error) return error.message;
  try {
    return String(error);
  } catch {
    return "(unprintable thrown value)";
  }
}

// Returns [] when valid, otherwise a list of human-readable error strings.
// Never throws, regardless of what `candidate` is. Valid requires ALL of:
// the raw candidate satisfies answer-wire-response.schema.json,
// JSON.stringify(candidate) succeeds and returns a string, JSON.parse of
// that string succeeds, and the resulting parsed wire value ALSO satisfies
// the same schema.
export function validateAnswerWireResponse(candidate) {
  const rawSchemaResult = safeSchemaCheck(candidate);
  if (!rawSchemaResult.ok) {
    if (rawSchemaResult.thrown) return [`schema validation threw: ${describeThrown(rawSchemaResult.thrown)}`];
    return rawSchemaResult.errors.map((error) => `${error.instancePath || "(root)"} ${error.message}`);
  }

  const wireResult = safeStringifyThenParse(candidate);
  if (!wireResult.ok) {
    if (wireResult.thrown) return [`JSON.stringify/JSON.parse failed: ${describeThrown(wireResult.thrown)}`];
    return [wireResult.message];
  }

  const wireSchemaResult = safeSchemaCheck(wireResult.parsed);
  if (!wireSchemaResult.ok) {
    if (wireSchemaResult.thrown) return [`parsed wire value schema validation threw: ${describeThrown(wireSchemaResult.thrown)}`];
    return wireSchemaResult.errors.map((error) => `(wire) ${error.instancePath || "(root)"} ${error.message}`);
  }

  return [];
}

export function isValidAnswerWireResponse(candidate) {
  return validateAnswerWireResponse(candidate).length === 0;
}

// Internal FinalResponse -> external wire body. `questionId` is always the
// REQUEST's own question_id (the correlation identifier) -- this function
// never reads a question_id off `finalResponse` (which has no such field at
// all; a runner/Flow cannot self-declare one). `finalResponse` is assumed
// already schema-valid (callers gate on isValidFinalResponse first, per
// answer-handler.mjs's trust boundary) -- this function does not itself
// re-validate it, only reshapes it.
export function toAnswerWireResponse(questionId, finalResponse) {
  return {
    question_id: questionId,
    question: finalResponse.question,
    retrieved_context: JSON.stringify(finalResponse.retrieved_context),
    think_trace: JSON.stringify(finalResponse.think_trace),
    answer: finalResponse.answer,
  };
}

// External wire body -> internal FinalResponse shape, for consumers (the
// Evaluation Harness's metric scorers) that expect retrieved_context as an
// array and think_trace as an object. Throws if either JSON string fails to
// parse -- callers over an untrusted wire (a real HTTP response) must wrap
// this (see fromAnswerWireResponseSafe) rather than let a malformed
// upstream response crash the caller; this raw, throwing version stays
// available for callers that have already validated the wire shape and
// want a plain, unwrapped result.
export function fromAnswerWireResponse(wire) {
  return {
    question: wire.question,
    retrieved_context: JSON.parse(wire.retrieved_context),
    think_trace: JSON.parse(wire.think_trace),
    answer: wire.answer,
  };
}

// Never-throwing variant: returns { ok: true, value } on success or
// { ok: false, error } if either retrieved_context or think_trace is not
// valid JSON. This is what an untrusted wire response (a real HTTP call
// result) must go through -- a malformed upstream JSON string must become
// a diagnosable, non-fatal `response_usable=false`, never an uncaught
// exception that aborts the whole Harness run.
export function fromAnswerWireResponseSafe(wire) {
  try {
    return { ok: true, value: fromAnswerWireResponse(wire) };
  } catch (error) {
    return { ok: false, error: describeThrown(error) };
  }
}
