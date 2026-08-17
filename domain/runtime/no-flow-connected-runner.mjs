// The GET /answer API boundary needs a safe fallback even when a requested
// question is outside the pinned Thin Flow plan set, or deployment
// artifacts fail construction. This is that fail-closed runner: it
// never fabricates evidence, a calculation, or an answer — it always
// returns a schema-valid EARLY_EXIT FinalResponse stating plainly that no
// analysis Flow is connected yet.
//
// It still goes through the full runAgentFlow pipeline (PolicyGuard,
// ExecutionTrace instrumentation, Serializer), so GET /answer already
// inherits real input screening (e.g. prompt-injection rejection) and a
// real, schema-valid response shape before any real Flow exists — this is
// not a shortcut that bypasses the Runtime Host.
//
// Budget limits are all zero: this Flow calls no SharedServices at all, and
// if a future edit to this file ever tried to, the execution budget would
// reject that call immediately (BUDGET_EXCEEDED, caught by runAgentFlow's
// own try/catch and turned into another safe EARLY_EXIT) rather than
// silently letting an unverified call through.

import { runAgentFlow } from "./agent-runtime.mjs";

const NO_FLOW_CONNECTED_ANSWER = "아직 연결된 분석 Flow가 없어 이 질문에 답변할 수 없습니다.";

const NO_FLOW_CONNECTED_FLOW = Object.freeze({
  id: "no-flow-connected",
  async run(input) {
    return {
      final_response: {
        question: input.question,
        retrieved_context: [],
        think_trace: {
          execution_mode: "EARLY_EXIT",
          operations: [],
          calculation: {},
          validation: {},
        },
        answer: NO_FLOW_CONNECTED_ANSWER,
      },
    };
  },
});

const NO_FLOW_CONNECTED_BUDGET_LIMITS = Object.freeze({
  maxHcxCalls: 0,
  maxRetrievals: 0,
  maxToolCalls: 0,
  timeoutMs: 5000,
});

// Returns a runner matching createAnswerHandler's expected shape:
// (question: string, options: {signal, deadline_at, timeout_ms}) =>
// Promise<{final_response, execution_trace}>. `options.signal` — the
// request-scoped deadline/client-disconnect AbortSignal createAnswerHandler
// creates per request (see abortable.mjs) — is threaded into
// runAgentFlow's SharedContext.signal unchanged, so Flow execution and
// SharedServices calls made by a connected Flow all race
// against the exact same signal createAnswerHandler is itself racing
// against. `deadline_at`/`timeout_ms` are accepted for forward
// compatibility with a future real Flow that wants to reason about how
// much time remains, but this placeholder Flow never awaits anything, so
// it has no use for them itself.
export function createNoFlowConnectedRunner({ context = {} } = {}) {
  return async function runNoFlowConnected(question, options = {}) {
    return runAgentFlow(
      NO_FLOW_CONNECTED_FLOW,
      { question },
      { ...context, signal: options.signal },
      NO_FLOW_CONNECTED_BUDGET_LIMITS,
    );
  };
}
