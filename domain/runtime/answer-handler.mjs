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
//
// TIMEOUT/ABORT: every request gets its own AbortController — never shared
// or reused across requests — that aborts either when `timeoutMs` elapses
// (default 60_000ms, configurable) or when the caller's own `signal` (e.g.
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

const serializer = createSerializer();

const REASON_INTERNAL_ERROR = "요청을 안전하게 처리하지 못했습니다.";
export const DEFAULT_TIMEOUT_MS = 60_000;

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

// `runner`: (question: string, options: {signal, deadline_at, timeout_ms})
// => Promise<{final_response?: object}>, matching runAgentFlow's own return
// shape plus the per-request deadline options every runner now receives.
// Required, with no built-in default, so a caller can never end up silently
// wired to nothing (or, once it exists, accidentally to a real Flow)
// without saying so explicitly. `questionParameter` defaults to "question"
// and must be a non-empty string. `timeoutMs` defaults to 60_000 and must
// be a positive finite number. Both are validated eagerly here so a
// misconfiguration fails at wiring time, not on the first real request.
export function createAnswerHandler({ runner, questionParameter = "question", timeoutMs = DEFAULT_TIMEOUT_MS }) {
  if (typeof runner !== "function") {
    throw new TypeError("createAnswerHandler requires a runner function");
  }
  if (typeof questionParameter !== "string" || questionParameter === "") {
    throw new TypeError("createAnswerHandler requires a non-empty questionParameter string");
  }
  if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError("createAnswerHandler requires a positive, finite timeoutMs");
  }

  // `clientSignal` is the framework layer's own request signal (e.g.
  // app/answer/route.ts passes `request.signal`) — entirely optional; a
  // caller that doesn't have one (or is testing this handler directly)
  // simply gets deadline-only behavior.
  return async function handleAnswerRequest(searchParams, { signal: clientSignal } = {}) {
    const parsed = parseQuestionParam(searchParams, questionParameter);
    if (!parsed.ok) {
      return { status: 400, body: buildEarlyExit("", parsed.reason) };
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
    // argument) — genuinely never called.
    if (controller.signal.aborted) {
      cleanup();
      return { status: 200, body: buildEarlyExit(parsed.question, REASON_INTERNAL_ERROR) };
    }

    try {
      const outcomePromise = runner(parsed.question, {
        signal: controller.signal,
        deadline_at: deadlineAt,
        timeout_ms: timeoutMs,
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
      // A throwing/rejecting/timed-out/aborted runner is still a VALID
      // request that was received correctly — the failure is internal
      // (including a timeout, which is not the caller's fault), so this is
      // 200 with a safe EARLY_EXIT body carrying the ORIGINAL request
      // question, not a 5xx. The caught error's own message/stack — and,
      // for a RequestAbortedError, even the TIMEOUT vs CLIENT_DISCONNECT
      // distinction — is deliberately never inspected here or exposed in
      // the response; only the fixed, generic Korean message reaches it.
      return { status: 200, body: buildEarlyExit(parsed.question, REASON_INTERNAL_ERROR) };
    } finally {
      // Always runs — normal completion, timeout, client abort, or any
      // other thrown error — so no timer or listener from this request is
      // ever left behind.
      cleanup();
    }
  };
}
