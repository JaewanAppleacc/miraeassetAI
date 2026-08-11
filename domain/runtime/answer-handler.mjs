// GET /answer request handling (CLAUDE.md section 2's frozen API boundary),
// kept framework-independent of Next.js/vinext so it runs under plain
// `node --test` without a Request/Response/Workers runtime. app/answer/
// route.ts is the only piece that touches the framework: it turns a Request
// into URLSearchParams and this handler's {status, body} result into a
// Response with the required headers.
//
// `runner` is dependency-injected (see domain/runtime/
// no-flow-connected-runner.mjs for the only runner wired today) so this
// module never imports or knows about any specific AgentFlow, in particular
// never Flow A — swapping in a real Flow later only changes what gets
// passed to createAnswerHandler, not this file. `questionParameter`
// (default "question") is likewise configurable so a future change to the
// competition's query-parameter name never requires rewriting this module,
// only its configuration.
//
// TRUST BOUNDARY: a runner's outcome.final_response is adversarial input,
// not data this module already trusts — a Flow bug, a malicious adapter, or
// a bitflip could hand back something that merely LOOKS plausible (a
// forged retrieved_context, a fabricated STRUCTURED execution_mode, a
// smuggled operations/calculation/validation payload) while being invalid
// or simply not an honest answer to the question that was asked. Two gates
// must both pass before a runner's response is trusted even partially:
//
//   1. isValidFinalResponse(candidate) — schema + wire-safety.
//   2. candidate.question === the ORIGINAL request question, checked with
//      strict equality, never silently rewritten to match.
//
// Failing EITHER gate discards the candidate WHOLESALE — no field-by-field
// repair, no partial trust in retrieved_context/operations/calculation/
// validation/answer, even if some of those fields individually look
// well-formed. A hand-built EARLY_EXIT response carrying only the request's
// own original question is returned instead. This is the opposite of
// serializer.serialize()'s own internal coercion (safeString/safeArray/
// safePlainObject) — that coercion exists to make agent-runtime.mjs's
// Runtime Host never crash on internal bugs; it was never meant to be a
// trust boundary against a caller-controlled Flow's output, and reusing it
// as one here previously let a malformed answer type smuggle through a
// forged retrieved_context/STRUCTURED mode untouched.
//
// createSerializer() is therefore called only in the two cases where doing
// so cannot leak anything untrusted: (a) a final JSON-safe clone of a
// candidate ALREADY CONFIRMED valid and question-bound by both gates above,
// and (b) a hand-built EARLY_EXIT object this module constructs itself. A
// caught error's message/stack and the runner's own execution_trace are
// never read at all — only a fixed, generic Korean message ever reaches
// the response body.

import { createSerializer } from "./agent-runtime.mjs";
import { isValidFinalResponse } from "./final-response-validator.mjs";

const serializer = createSerializer();

const REASON_INTERNAL_ERROR = "요청을 안전하게 처리하지 못했습니다.";

function missingReason(questionParameter) {
  return `${questionParameter} 파라미터가 필요합니다.`;
}
function duplicateReason(questionParameter) {
  return `${questionParameter} 파라미터가 중복되었습니다.`;
}
function blankReason(questionParameter) {
  return `${questionParameter} 파라미터가 비어 있습니다.`;
}

// The only place a FinalResponse is built by hand rather than taken from a
// runner — always schema-valid by construction (question is always a
// string here), so passing it through serializer.serialize() is case (b)
// from the header comment: a final JSON-safe clone of trusted, self-authored
// data, not an attempt to repair anything untrusted.
function buildEarlyExit(question, answer) {
  return serializer.serialize({
    question,
    retrieved_context: [],
    think_trace: { execution_mode: "EARLY_EXIT", operations: [], calculation: {}, validation: {} },
    answer,
  });
}

// `searchParams` is a URLSearchParams (or anything exposing the same
// getAll()) — never a raw query string this module would have to parse
// (and URL-decode) itself; that belongs to whatever framework layer built
// it. Duplicate params are rejected outright rather than picking "the
// first" or "the last" one, since either choice would silently discard
// part of an ambiguous request.
function parseQuestionParam(searchParams, questionParameter) {
  const values = searchParams.getAll(questionParameter);
  if (values.length === 0) return { ok: false, reason: missingReason(questionParameter) };
  if (values.length > 1) return { ok: false, reason: duplicateReason(questionParameter) };

  const question = values[0];
  if (typeof question !== "string" || question.trim() === "") {
    return { ok: false, reason: blankReason(questionParameter) };
  }
  return { ok: true, question };
}

// `runner`: (question: string) => Promise<{final_response?: object}>,
// matching runAgentFlow's own return shape. Required, with no built-in
// default, so a caller can never end up silently wired to nothing (or, once
// it exists, accidentally to a real Flow) without saying so explicitly.
// `questionParameter` defaults to "question" and must be a non-empty
// string — validated eagerly here so a misconfiguration fails at wiring
// time, not on the first real request.
export function createAnswerHandler({ runner, questionParameter = "question" }) {
  if (typeof runner !== "function") {
    throw new TypeError("createAnswerHandler requires a runner function");
  }
  if (typeof questionParameter !== "string" || questionParameter === "") {
    throw new TypeError("createAnswerHandler requires a non-empty questionParameter string");
  }

  return async function handleAnswerRequest(searchParams) {
    const parsed = parseQuestionParam(searchParams, questionParameter);
    if (!parsed.ok) {
      return { status: 400, body: buildEarlyExit("", parsed.reason) };
    }

    try {
      const outcome = await runner(parsed.question);
      // Only final_response is ever read — execution_trace (and anything
      // else a runner's outcome might carry) never reaches the response
      // body, regardless of what it contains.
      const candidate = outcome && typeof outcome === "object" ? outcome.final_response : undefined;

      // Gate 1: schema + wire-safety. A candidate that fails this is
      // discarded wholesale — see the header comment for why this is not
      // "repaired" via serializer.serialize()'s own coercion.
      if (!isValidFinalResponse(candidate)) {
        return { status: 200, body: buildEarlyExit(parsed.question, REASON_INTERNAL_ERROR) };
      }

      // Gate 2: the response must actually be an answer to what was asked.
      // A Flow bug that answers a different (or previous, or fabricated)
      // question is a real failure to surface, not something to paper over
      // by silently substituting the request's question into the reply.
      if (candidate.question !== parsed.question) {
        return { status: 200, body: buildEarlyExit(parsed.question, REASON_INTERNAL_ERROR) };
      }

      // Both gates passed: this is case (a) from the header comment — a
      // final JSON-safe clone of an already-confirmed-valid response.
      return { status: 200, body: serializer.serialize(candidate) };
    } catch {
      // A throwing/rejecting runner is still a VALID request that was
      // received correctly — the failure is internal, so this is 200 with
      // a safe EARLY_EXIT body, not a 5xx. The caught error's own
      // message/stack is deliberately never inspected.
      return { status: 200, body: buildEarlyExit(parsed.question, REASON_INTERNAL_ERROR) };
    }
  };
}
