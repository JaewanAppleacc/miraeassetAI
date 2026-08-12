// GET /answer request handling (CLAUDE.md section 2's frozen API boundary --
// its WIRE shape was updated per an organizer API notice; see
// domain/runtime/answer-wire-response.mjs and domain/interfaces/
// answer-wire-response.schema.json for the new official five-string-field
// external contract this module now returns. FROZEN v1.1's INTERNAL Runtime
// Host contracts -- AgentInput/AgentFlow, FinalResponse, ExecutionTrace --
// are unchanged; only this external wire boundary and this file adapt to
// it), kept framework-independent of Next.js/vinext so it runs under plain
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
// (default "question") and `questionIdParameter` (default "question_id")
// are likewise configurable so a future change to the competition's
// query-parameter names never requires rewriting this module, only its
// configuration.
//
// question_id is a pure REQUEST-BOUNDARY correlation identifier — it is
// echoed from the request's own question_id parameter into the response
// body, verbatim, and is NEVER read from, or influenced by, the runner's
// outcome (internal FinalResponse has no question_id field at all, and
// AgentInput/AgentFlow's official contract is not changed by this file — a
// runner/Flow cannot self-declare the response's question_id). The request
// boundary is authoritative for this value.
//
// TRUST BOUNDARY: a runner's outcome.final_response is adversarial input,
// not data this module already trusts — a Flow bug, a malicious adapter, or
// a bitflip could hand back something that merely LOOKS plausible (a
// forged retrieved_context, a fabricated STRUCTURED execution_mode, a
// smuggled operations/calculation/validation payload) while being invalid
// or simply not an honest answer to the question that was asked. Two gates
// must both pass before a runner's response is trusted even partially:
//
//   1. isValidFinalResponse(candidate) — schema + wire-safety (checked
//      against the INTERNAL final-response.schema.json shape, before any
//      conversion to the external wire shape).
//   2. candidate.question === the ORIGINAL request question, checked with
//      strict equality, never silently rewritten to match.
//
// Failing EITHER gate discards the candidate WHOLESALE — no field-by-field
// repair, no partial trust in retrieved_context/operations/calculation/
// validation/answer, even if some of those fields individually look
// well-formed. A hand-built EARLY_EXIT response carrying only the request's
// own original question_id/question is returned instead (still 200 — a
// contract defect a retry cannot fix is not the same failure class as a
// timeout/transient error, see the HTTP status policy below). This is the
// opposite of serializer.serialize()'s own internal coercion (safeString/
// safeArray/safePlainObject) — that coercion exists to make agent-runtime.
// mjs's Runtime Host never crash on internal bugs; it was never meant to be
// a trust boundary against a caller-controlled Flow's output, and reusing
// it as one here previously let a malformed answer type smuggle through a
// forged retrieved_context/STRUCTURED mode untouched.
//
// createSerializer() is therefore called only in the two cases where doing
// so cannot leak anything untrusted: (a) a final JSON-safe clone of a
// candidate ALREADY CONFIRMED valid and question-bound by both gates above,
// and (b) a hand-built EARLY_EXIT object this module constructs itself.
// Either way, the result is then converted to the external wire shape via
// toAnswerWireResponse() before it ever leaves this module — the internal
// FinalResponse shape (retrieved_context as an array, think_trace as an
// object) never reaches a caller directly. A caught error's message/stack
// and the runner's own execution_trace are never read at all — only a
// fixed, generic Korean message ever reaches the response body.
//
// HTTP STATUS POLICY (organizer notice): 200 for a genuine answer (any
// execution_mode, including a Flow-produced EARLY_EXIT, an information-
// limit response, or a Policy Guard rejection) AND for a contract defect a
// retry cannot fix (malformed runner response, request/response question
// mismatch — both discarded to a safe EARLY_EXIT, still 200, not upgraded
// to a client-facing failure code); 400 for a request parameter error
// (missing/blank/duplicate question_id or question); 503 for this
// handler's own deadline TIMEOUT and for a runner's transient throw/
// rejection (both are retryable failure classes from a caller's
// perspective, unlike a 400 or a contract defect). CLIENT_DISCONNECT is
// grouped with the 503 abort paths — the response can never actually reach
// a disconnected client anyway, so no new external contract meaning is
// invented for it; the existing cleanup/abort control flow below is
// unchanged.
//
// TIMEOUT/ABORT: every request gets its own AbortController — never shared
// or reused across requests — that aborts either when `timeoutMs` elapses
// (default 290_000ms, configurable) or when the caller's own `signal` (e.g.
// app/answer/route.ts's `request.signal`, a client disconnect) aborts,
// whichever happens first. `controller.abort(reason)` is called with a
// RequestAbortedError carrying which of the two it was, so downstream
// ExecutionTrace.fallback_reason can distinguish TIMEOUT from
// CLIENT_DISCONNECT (see abortable.mjs) without ever surfacing that
// distinction — or anything else internal — in the response body. The SAME
// signal is handed to `runner` as `options.signal`, so the Runtime Host and
// every SharedServices call downstream race against this exact deadline,
// not a second, independently-timed one. The runner call itself is ALSO
// raced against this signal here (not just handed the signal and trusted
// to honor it) — a runner/Flow that ignores `signal` entirely still cannot
// hang this handler past `timeoutMs`; its real promise is still observed
// (see raceAgainstAbort in abortable.mjs) so a late settlement can never
// produce an unhandledRejection or change the response already returned.
// The timer is always cleared and the client-signal listener always
// detached in a `finally`, whether the request finished normally, timed
// out, or the client disconnected — no timer or listener outlives its own
// request.

import { createSerializer } from "./agent-runtime.mjs";
import { raceAgainstAbort, RequestAbortedError } from "./abortable.mjs";
import { isValidFinalResponse } from "./final-response-validator.mjs";
import { toAnswerWireResponse } from "./answer-wire-response.mjs";

const serializer = createSerializer();

const REASON_INTERNAL_ERROR = "요청을 안전하게 처리하지 못했습니다.";
// 290 seconds -- kept safely under the official 300-second client-side
// timeout (see domain/evaluation-harness/README.md and the root README's
// GET /answer section) so this handler's own deadline always fires and
// returns a clean 503 EARLY_EXIT before an external caller's socket times
// out on its own, unobserved end.
export const DEFAULT_TIMEOUT_MS = 290_000;

function missingReason(parameterName) {
  return `${parameterName} 파라미터가 필요합니다.`;
}
function duplicateReason(parameterName) {
  return `${parameterName} 파라미터가 중복되었습니다.`;
}
function blankReason(parameterName) {
  return `${parameterName} 파라미터가 비어 있습니다.`;
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

// Builds the EXTERNAL wire body for a hand-built EARLY_EXIT — every non-
// success response (400/503, and the 200 contract-defect fallback) goes
// through this one helper so there is exactly one place that combines
// buildEarlyExit + toAnswerWireResponse. `questionId`/`question` are always
// whatever the request boundary actually established (possibly "" — see
// parseRequestParams below), never fabricated.
function buildWireEarlyExit(questionId, question, answer) {
  return toAnswerWireResponse(questionId, buildEarlyExit(question, answer));
}

// `searchParams` is a URLSearchParams (or anything exposing the same
// getAll()) — never a raw query string this module would have to parse
// (and URL-decode) itself; that belongs to whatever framework layer built
// it. Duplicate params are rejected outright rather than picking "the
// first" or "the last" one, since either choice would silently discard
// part of an ambiguous request.
function parseSingleParam(searchParams, parameterName) {
  const values = searchParams.getAll(parameterName);
  if (values.length === 0) return { ok: false, value: "", reason: missingReason(parameterName) };
  if (values.length > 1) return { ok: false, value: "", reason: duplicateReason(parameterName) };

  const value = values[0];
  if (typeof value !== "string" || value.trim() === "") {
    return { ok: false, value: "", reason: blankReason(parameterName) };
  }
  return { ok: true, value };
}

// Parses BOTH question_id and question independently — each must be
// present exactly once, a string, and non-blank, on its own terms. Either
// failing makes the whole request invalid, but whichever of the two DID
// parse successfully is still echoed back (never fabricated as "success"
// for the request as a whole, but not needlessly discarded either) — only
// a parameter that itself failed to parse becomes "" in the response, per
// the organizer notice's "누락된 question_id/question은 빈 문자열로 안전하게
// 반환한다".
function parseRequestParams(searchParams, questionIdParameter, questionParameter) {
  const questionId = parseSingleParam(searchParams, questionIdParameter);
  const question = parseSingleParam(searchParams, questionParameter);
  if (!questionId.ok || !question.ok) {
    return {
      ok: false,
      questionId: questionId.value,
      question: question.value,
      reason: !questionId.ok ? questionId.reason : question.reason,
    };
  }
  return { ok: true, questionId: questionId.value, question: question.value };
}

// `runner`: (question: string, options: {signal, deadline_at, timeout_ms,
// question_id}) => Promise<{final_response?: object}>, matching
// runAgentFlow's own return shape plus the per-request deadline options
// every runner now receives. `options.question_id` is passed through for a
// future real Flow that wants it for logging/correlation only — it is
// never read back out of the runner's result (see the header comment: the
// request boundary is authoritative for the response's question_id, not
// the runner). Required, with no built-in default, so a caller can never
// end up silently wired to nothing (or, once it exists, accidentally to a
// real Flow) without saying so explicitly. `questionParameter` defaults to
// "question", `questionIdParameter` defaults to "question_id", and both
// must be non-empty strings. `timeoutMs` defaults to DEFAULT_TIMEOUT_MS
// (290_000) and must be a positive finite number. All are validated
// eagerly here so a misconfiguration fails at wiring time, not on the
// first real request.
export function createAnswerHandler({
  runner,
  questionParameter = "question",
  questionIdParameter = "question_id",
  timeoutMs = DEFAULT_TIMEOUT_MS,
}) {
  if (typeof runner !== "function") {
    throw new TypeError("createAnswerHandler requires a runner function");
  }
  if (typeof questionParameter !== "string" || questionParameter === "") {
    throw new TypeError("createAnswerHandler requires a non-empty questionParameter string");
  }
  if (typeof questionIdParameter !== "string" || questionIdParameter === "") {
    throw new TypeError("createAnswerHandler requires a non-empty questionIdParameter string");
  }
  if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError("createAnswerHandler requires a positive, finite timeoutMs");
  }

  // `clientSignal` is the framework layer's own request signal (e.g.
  // app/answer/route.ts passes `request.signal`) — entirely optional; a
  // caller that doesn't have one (or is testing this handler directly)
  // simply gets deadline-only behavior.
  return async function handleAnswerRequest(searchParams, { signal: clientSignal } = {}) {
    const parsed = parseRequestParams(searchParams, questionIdParameter, questionParameter);
    if (!parsed.ok) {
      return { status: 400, body: buildWireEarlyExit(parsed.questionId, parsed.question, parsed.reason) };
    }

    // A fresh AbortController for THIS request only — never shared or
    // reused across concurrent requests, so one request's timeout/abort
    // can never affect another's.
    const controller = new AbortController();

    const onClientAbort = () => {
      if (controller.signal.aborted) return;
      controller.abort(new RequestAbortedError("CLIENT_DISCONNECT"));
    };
    if (clientSignal?.aborted) {
      controller.abort(new RequestAbortedError("CLIENT_DISCONNECT"));
    } else if (clientSignal) {
      clientSignal.addEventListener("abort", onClientAbort, { once: true });
    }

    const startedAtMs = Date.now();
    const deadlineAt = new Date(startedAtMs + timeoutMs).toISOString();
    const timer = setTimeout(() => {
      if (controller.signal.aborted) return;
      controller.abort(new RequestAbortedError("TIMEOUT"));
    }, timeoutMs);
    // Node-specific: never let this timer alone keep the process alive.
    // (Not every runtime this handler runs under has `unref` — e.g. a
    // Workers/browser AbortController's derived timer wouldn't — so this
    // is guarded, not assumed.)
    if (typeof timer.unref === "function") timer.unref();

    function cleanup() {
      clearTimeout(timer);
      if (clientSignal) clientSignal.removeEventListener("abort", onClientAbort);
    }

    // The combined signal can already be aborted at this exact point — the
    // client signal check above only catches an ALREADY-aborted
    // `clientSignal` at entry; it says nothing about the deadline timer,
    // and more importantly this is the one place that must hold no matter
    // WHICH of the two causes fired. The runner must never be invoked even
    // once in that case — not "invoked and then its result discarded", not
    // "invoked and raced away" (see raceAgainstAbort's own already-aborted
    // branch, which still calls into whatever produced its promise
    // argument) — genuinely never called. This is an abort path (deadline/
    // disconnect), never a genuine answer or a param error, so it is 503
    // per the HTTP status policy above.
    if (controller.signal.aborted) {
      cleanup();
      return { status: 503, body: buildWireEarlyExit(parsed.questionId, parsed.question, REASON_INTERNAL_ERROR) };
    }

    try {
      const outcomePromise = runner(parsed.question, {
        signal: controller.signal,
        deadline_at: deadlineAt,
        timeout_ms: timeoutMs,
        question_id: parsed.questionId,
      });

      // Raced against the SAME controller.signal the runner itself was
      // just handed — a runner that ignores `signal` entirely (or whose
      // Flow hangs somewhere that never checks it) still cannot keep this
      // handler waiting past the deadline. `outcomePromise` stays fully
      // observed either way, so a late settlement is discarded, not left
      // to become an unhandledRejection or to retroactively change the
      // response already returned below.
      const outcome = await raceAgainstAbort(outcomePromise, controller.signal);

      // Only final_response is ever read — execution_trace (and anything
      // else a runner's outcome might carry) never reaches the response
      // body, regardless of what it contains.
      const candidate = outcome && typeof outcome === "object" ? outcome.final_response : undefined;

      // Gate 1: schema + wire-safety (against the INTERNAL final-response
      // shape). A candidate that fails this is a contract defect a retry
      // cannot fix — discarded wholesale to a safe EARLY_EXIT, but still
      // 200 (see the HTTP status policy above), not a 5xx. See the header
      // comment for why this is not "repaired" via serializer.serialize()'s
      // own coercion.
      if (!isValidFinalResponse(candidate)) {
        return { status: 200, body: buildWireEarlyExit(parsed.questionId, parsed.question, REASON_INTERNAL_ERROR) };
      }

      // Gate 2: the response must actually be an answer to what was asked.
      // A Flow bug that answers a different (or previous, or fabricated)
      // question is a real failure to surface, not something to paper over
      // by silently substituting the request's question into the reply —
      // also a contract defect a retry cannot fix, so also 200.
      if (candidate.question !== parsed.question) {
        return { status: 200, body: buildWireEarlyExit(parsed.questionId, parsed.question, REASON_INTERNAL_ERROR) };
      }

      // Both gates passed: this is case (a) from the header comment — a
      // final JSON-safe clone of an already-confirmed-valid response,
      // converted to the external wire shape. Whatever execution_mode the
      // Flow actually produced (a genuine answer, an EARLY_EXIT, an
      // information-limit response, a Policy Guard rejection reflected as
      // a safe answer) is a 200 — the organizer notice does not carve out
      // a different status for any of those; they are all "a valid
      // response was produced".
      return { status: 200, body: toAnswerWireResponse(parsed.questionId, serializer.serialize(candidate)) };
    } catch {
      // A throwing/rejecting/timed-out/aborted runner is still a VALID
      // request that was received correctly, but the failure — a deadline
      // TIMEOUT or a runner's transient throw/rejection (including
      // CLIENT_DISCONNECT, grouped here per the HTTP status policy above)
      // — is a class a caller can reasonably retry, so this is 503, not
      // 200. The caught error's own message/stack — and, for a
      // RequestAbortedError, even the TIMEOUT vs CLIENT_DISCONNECT
      // distinction — is deliberately never inspected here or exposed in
      // the response; only the fixed, generic Korean message reaches it.
      return { status: 503, body: buildWireEarlyExit(parsed.questionId, parsed.question, REASON_INTERNAL_ERROR) };
    } finally {
      // Always runs — normal completion, timeout, client abort, or any
      // other thrown error — so no timer or listener from this request is
      // ever left behind.
      cleanup();
    }
  };
}
