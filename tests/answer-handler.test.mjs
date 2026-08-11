import assert from "node:assert/strict";
import test from "node:test";
import { createAnswerHandler, DEFAULT_TIMEOUT_MS } from "../domain/runtime/answer-handler.mjs";
import { isValidFinalResponse } from "../domain/runtime/final-response-validator.mjs";

function params(pairs) {
  const searchParams = new URLSearchParams();
  for (const [key, value] of pairs) searchParams.append(key, value);
  return searchParams;
}

function questionOnly(value) {
  return params([["question", value]]);
}

function echoRunner(finalResponseOverrides = {}) {
  return async (question) => ({
    final_response: {
      question,
      retrieved_context: [],
      think_trace: { execution_mode: "STRUCTURED", operations: [], calculation: {}, validation: {} },
      answer: `echo: ${question}`,
      ...finalResponseOverrides,
    },
  });
}

// --- constructor contract ---------------------------------------------------

test("createAnswerHandler requires a runner function", () => {
  assert.throws(() => createAnswerHandler({}), TypeError);
  assert.throws(() => createAnswerHandler({ runner: "not a function" }), TypeError);
});

test("createAnswerHandler rejects an empty questionParameter", () => {
  assert.throws(() => createAnswerHandler({ runner: echoRunner(), questionParameter: "" }), TypeError);
});

test("createAnswerHandler rejects a non-string questionParameter", () => {
  assert.throws(() => createAnswerHandler({ runner: echoRunner(), questionParameter: 42 }), TypeError);
});

// --- valid requests ----------------------------------------------------------

test("a normal Korean question is passed through to the runner and returned as-is", async () => {
  const handle = createAnswerHandler({ runner: echoRunner() });
  const { status, body } = await handle(questionOnly("삼성전자 2024년 3분기 매출액은 얼마인가요?"));
  assert.equal(status, 200);
  assert.equal(body.question, "삼성전자 2024년 3분기 매출액은 얼마인가요?");
  assert.equal(body.answer, "echo: 삼성전자 2024년 3분기 매출액은 얼마인가요?");
  assert.equal(isValidFinalResponse(body), true);
});

test("numbers, English abbreviations, and special characters in the question are preserved exactly", async () => {
  const tricky = "ROE(%) 2024Q1 vs 2023Q1 - 삼성전자·SK하이닉스 비교, 증가율은?";
  const handle = createAnswerHandler({ runner: echoRunner() });
  const { status, body } = await handle(questionOnly(tricky));
  assert.equal(status, 200);
  assert.equal(body.question, tricky);
  assert.equal(isValidFinalResponse(body), true);
});

test("a well-formed FinalResponse from the runner passes through 200 unchanged", async () => {
  const wellFormed = {
    question: "q",
    retrieved_context: [{ document_id: "major_20241115000375" }],
    think_trace: { execution_mode: "BOTH", operations: ["lookup"], calculation: { a: 1 }, validation: { ok: true } },
    answer: "a",
  };
  const handle = createAnswerHandler({ runner: async () => ({ final_response: wellFormed }) });
  const { status, body } = await handle(questionOnly("q"));
  assert.equal(status, 200);
  assert.deepEqual(body, wellFormed);
  assert.equal(isValidFinalResponse(body), true);
});

// --- invalid requests: HTTP 400 -----------------------------------------------

test("a missing question parameter is rejected with 400 and a valid FinalResponse body", async () => {
  const handle = createAnswerHandler({ runner: echoRunner() });
  const { status, body } = await handle(params([]));
  assert.equal(status, 400);
  assert.equal(isValidFinalResponse(body), true);
  assert.equal(body.think_trace.execution_mode, "EARLY_EXIT");
});

test("an empty question value is rejected with 400", async () => {
  const handle = createAnswerHandler({ runner: echoRunner() });
  const { status, body } = await handle(questionOnly(""));
  assert.equal(status, 400);
  assert.equal(isValidFinalResponse(body), true);
});

test("a whitespace-only question value is rejected with 400", async () => {
  const handle = createAnswerHandler({ runner: echoRunner() });
  const { status, body } = await handle(questionOnly("   　  "));
  assert.equal(status, 400);
  assert.equal(isValidFinalResponse(body), true);
});

test("a duplicated question parameter is rejected with 400, even with distinct values", async () => {
  const handle = createAnswerHandler({ runner: echoRunner() });
  const { status, body } = await handle(params([["question", "a"], ["question", "b"]]));
  assert.equal(status, 400);
  assert.equal(isValidFinalResponse(body), true);
});

test("a duplicated question parameter with identical values is still rejected with 400", async () => {
  const handle = createAnswerHandler({ runner: echoRunner() });
  const { status, body } = await handle(params([["question", "a"], ["question", "a"]]));
  assert.equal(status, 400);
  assert.equal(isValidFinalResponse(body), true);
});

// --- runner failures never surface as 5xx or leak internals -----------------

test("a runner that throws synchronously still returns 200 with a safe EARLY_EXIT response", async () => {
  const handle = createAnswerHandler({
    runner: () => {
      throw new Error("SECRET_DB_PASSWORD=hunter2 at /internal/path\n  at boom (secret.js:1:1)");
    },
  });
  const { status, body } = await handle(questionOnly("q"));
  assert.equal(status, 200);
  assert.equal(isValidFinalResponse(body), true);
  assert.equal(body.think_trace.execution_mode, "EARLY_EXIT");
  const serialized = JSON.stringify(body);
  assert.ok(!serialized.includes("SECRET_DB_PASSWORD"));
  assert.ok(!serialized.includes("hunter2"));
  assert.ok(!serialized.includes("secret.js"));
});

test("a runner whose promise rejects still returns 200 with a safe EARLY_EXIT response, not the raw error", async () => {
  const handle = createAnswerHandler({
    runner: async () => {
      throw new Error("internal stack trace leak: at Object.<anonymous> (/app/secret.mjs:42:9)");
    },
  });
  const { status, body } = await handle(questionOnly("q"));
  assert.equal(status, 200);
  assert.equal(isValidFinalResponse(body), true);
  assert.ok(!JSON.stringify(body).includes("secret.mjs"));
});

// A malformed candidate is wholly discarded, never field-by-field repaired:
// no partial trust in retrieved_context, no fabricated STRUCTURED mode, no
// surviving operations/calculation/validation — a bad answer type anywhere
// in the candidate collapses the ENTIRE response to a fresh, hand-built
// EARLY_EXIT built only from the original request question.
test("a malformed answer type together with fake retrieved_context/STRUCTURED mode is wholly discarded as EARLY_EXIT, not repaired field-by-field", async () => {
  const handle = createAnswerHandler({
    runner: async () => ({
      final_response: {
        question: "q",
        retrieved_context: [{ document_id: "major_20241115000375", forged: true }],
        think_trace: { execution_mode: "STRUCTURED", operations: ["fake_op"], calculation: { fabricated: 999 }, validation: { evidence_supported: true } },
        answer: { nested: "not a string" },
      },
    }),
  });
  const { status, body } = await handle(questionOnly("q"));
  assert.equal(status, 200);
  assert.equal(isValidFinalResponse(body), true);
  assert.equal(body.think_trace.execution_mode, "EARLY_EXIT");
  assert.deepEqual(body.retrieved_context, []);
  assert.equal(body.question, "q");
  assert.notEqual(body.answer, undefined);
  assert.notDeepEqual(body.retrieved_context, [{ document_id: "major_20241115000375", forged: true }]);
});

test("a malformed response's operations/calculation/validation are entirely discarded, not selectively kept", async () => {
  const handle = createAnswerHandler({
    runner: async () => ({
      final_response: {
        question: "q",
        retrieved_context: [],
        think_trace: {
          execution_mode: "BOTH",
          operations: ["real_looking_op_1", "real_looking_op_2"],
          calculation: { result: 42, formula: "SUM" },
          validation: { evidence_supported: true, version_valid: true },
        },
        answer: 12345, // wrong type -> whole candidate is invalid
      },
    }),
  });
  const { status, body } = await handle(questionOnly("q"));
  assert.equal(status, 200);
  assert.equal(isValidFinalResponse(body), true);
  assert.deepEqual(body.think_trace.operations, []);
  assert.deepEqual(body.think_trace.calculation, {});
  assert.deepEqual(body.think_trace.validation, {});
  assert.equal(body.think_trace.execution_mode, "EARLY_EXIT");
});

test("a malformed runner response (missing required fields) is discarded to a safe EARLY_EXIT, still 200", async () => {
  const handle = createAnswerHandler({ runner: async () => ({ final_response: { not_a_real_field: true } }) });
  const { status, body } = await handle(questionOnly("q"));
  assert.equal(status, 200);
  assert.equal(isValidFinalResponse(body), true);
  assert.equal(body.think_trace.execution_mode, "EARLY_EXIT");
  assert.equal(body.question, "q");
});

test("a malformed runner response (wrong field types) is discarded to a safe EARLY_EXIT, still 200", async () => {
  const handle = createAnswerHandler({
    runner: async () => ({
      final_response: {
        question: 12345,
        retrieved_context: "not an array",
        think_trace: { execution_mode: "NOT_A_REAL_MODE", operations: null, calculation: [], validation: [] },
        answer: { nested: "object, not a string" },
      },
    }),
  });
  const { status, body } = await handle(questionOnly("q"));
  assert.equal(status, 200);
  assert.equal(isValidFinalResponse(body), true);
  assert.equal(body.think_trace.execution_mode, "EARLY_EXIT");
  assert.equal(body.question, "q");
});

test("a runner that resolves with no final_response at all is discarded to a safe EARLY_EXIT", async () => {
  const handle = createAnswerHandler({ runner: async () => ({}) });
  const { status, body } = await handle(questionOnly("q"));
  assert.equal(status, 200);
  assert.equal(isValidFinalResponse(body), true);
  assert.equal(body.question, "q");
});

test("a runner that resolves with undefined is discarded to a safe EARLY_EXIT", async () => {
  const handle = createAnswerHandler({ runner: async () => undefined });
  const { status, body } = await handle(questionOnly("q"));
  assert.equal(status, 200);
  assert.equal(isValidFinalResponse(body), true);
  assert.equal(body.question, "q");
});

// --- request <-> response question binding -----------------------------------

test("a runner response whose question differs from the request question is rejected wholesale", async () => {
  const handle = createAnswerHandler({
    runner: async () => ({
      final_response: {
        question: "a completely different question",
        retrieved_context: [{ document_id: "major_20241115000375" }],
        think_trace: { execution_mode: "STRUCTURED", operations: ["op"], calculation: { a: 1 }, validation: { ok: true } },
        answer: "this looks like a real, well-formed answer",
      },
    }),
  });
  const { status, body } = await handle(questionOnly("실제 요청 질문"));
  assert.equal(status, 200);
  assert.equal(isValidFinalResponse(body), true);
  assert.equal(body.think_trace.execution_mode, "EARLY_EXIT");
  assert.deepEqual(body.retrieved_context, []);
});

test("a question-mismatch rejection keeps the ORIGINAL request question, not the runner's claimed one, and does not silently overwrite it", async () => {
  const handle = createAnswerHandler({
    runner: async () => ({
      final_response: {
        question: "runner's own claimed question",
        retrieved_context: [],
        think_trace: { execution_mode: "STRUCTURED", operations: [], calculation: {}, validation: {} },
        answer: "a",
      },
    }),
  });
  const { body } = await handle(questionOnly("original request question"));
  assert.equal(body.question, "original request question");
});

test("a fully valid response whose question exactly matches the request passes through unchanged", async () => {
  const wellFormed = {
    question: "정확히 같은 질문",
    retrieved_context: [{ document_id: "major_20241115000375" }],
    think_trace: { execution_mode: "BOTH", operations: ["lookup"], calculation: { a: 1 }, validation: { ok: true } },
    answer: "a",
  };
  const handle = createAnswerHandler({ runner: async () => ({ final_response: wellFormed }) });
  const { status, body } = await handle(questionOnly("정확히 같은 질문"));
  assert.equal(status, 200);
  assert.deepEqual(body, wellFormed);
  assert.equal(isValidFinalResponse(body), true);
});

// --- configurable questionParameter -------------------------------------------

test("a custom questionParameter is used for lookup instead of the default 'question' key", async () => {
  const handle = createAnswerHandler({ runner: echoRunner(), questionParameter: "q" });
  const { status, body } = await handle(params([["q", "custom param question"]]));
  assert.equal(status, 200);
  assert.equal(body.question, "custom param question");
});

test("with a custom questionParameter, the default 'question' key is ignored entirely (missing -> 400)", async () => {
  const handle = createAnswerHandler({ runner: echoRunner(), questionParameter: "q" });
  const { status, body } = await handle(questionOnly("this uses the wrong key now"));
  assert.equal(status, 400);
  assert.equal(isValidFinalResponse(body), true);
});

test("the default questionParameter ('question') is used when none is configured", async () => {
  const handle = createAnswerHandler({ runner: echoRunner() });
  const { status, body } = await handle(questionOnly("default param question"));
  assert.equal(status, 200);
  assert.equal(body.question, "default param question");
});

test("a duplicated custom questionParameter is still rejected with 400", async () => {
  const handle = createAnswerHandler({ runner: echoRunner(), questionParameter: "q" });
  const { status, body } = await handle(params([["q", "a"], ["q", "b"]]));
  assert.equal(status, 400);
  assert.equal(isValidFinalResponse(body), true);
});

// --- execution_trace and other internals never leak into the body -----------

test("the runner's execution_trace never appears in the response body", async () => {
  const handle = createAnswerHandler({
    runner: async (question) => ({
      final_response: {
        question,
        retrieved_context: [],
        think_trace: { execution_mode: "STRUCTURED", operations: [], calculation: {}, validation: {} },
        answer: "a",
      },
      execution_trace: {
        flow_id: "secret-flow-internal-id",
        tool_calls: [{ service: "Validator", method: "validateFacts" }],
        fallback_reason: "SOME_INTERNAL_CODE",
      },
    }),
  });
  const { body } = await handle(questionOnly("q"));
  assert.equal(body.execution_trace, undefined);
  assert.deepEqual(Object.keys(body).sort(), ["answer", "question", "retrieved_context", "think_trace"]);
  assert.ok(!JSON.stringify(body).includes("secret-flow-internal-id"));
});

// --- schema compliance across the board --------------------------------------

test("every /answer body produced above validates against final-response.schema.json (spot re-check)", async () => {
  const handle = createAnswerHandler({ runner: echoRunner() });
  const cases = await Promise.all([
    handle(questionOnly("정상 질문")),
    handle(params([])),
    handle(questionOnly("")),
    handle(questionOnly("   ")),
    handle(params([["question", "a"], ["question", "b"]])),
  ]);
  for (const { body } of cases) {
    assert.equal(isValidFinalResponse(body), true);
  }
});

// --- per-request Timeout/AbortSignal ------------------------------------------

test("createAnswerHandler defaults timeoutMs to 60000", () => {
  assert.equal(DEFAULT_TIMEOUT_MS, 60_000);
});

test("createAnswerHandler rejects a non-positive timeoutMs", () => {
  assert.throws(() => createAnswerHandler({ runner: echoRunner(), timeoutMs: 0 }), TypeError);
  assert.throws(() => createAnswerHandler({ runner: echoRunner(), timeoutMs: -5 }), TypeError);
});

test("createAnswerHandler rejects a non-finite or non-number timeoutMs", () => {
  assert.throws(() => createAnswerHandler({ runner: echoRunner(), timeoutMs: Infinity }), TypeError);
  assert.throws(() => createAnswerHandler({ runner: echoRunner(), timeoutMs: NaN }), TypeError);
  assert.throws(() => createAnswerHandler({ runner: echoRunner(), timeoutMs: "60000" }), TypeError);
});

test("a normal runner that finishes well before the deadline succeeds normally", async () => {
  const handle = createAnswerHandler({
    runner: async (question) => ({
      final_response: {
        question,
        retrieved_context: [],
        think_trace: { execution_mode: "STRUCTURED", operations: [], calculation: {}, validation: {} },
        answer: "on time",
      },
    }),
    timeoutMs: 200,
  });
  const { status, body } = await handle(questionOnly("q"));
  assert.equal(status, 200);
  assert.equal(body.answer, "on time");
  assert.equal(isValidFinalResponse(body), true);
});

test("a runner that never resolves is cut off at the deadline and returns a safe EARLY_EXIT response", async () => {
  const handle = createAnswerHandler({
    runner: () => new Promise(() => {}),
    timeoutMs: 30,
  });
  const started = Date.now();
  const { status, body } = await handle(questionOnly("q"));
  const elapsed = Date.now() - started;
  assert.equal(status, 200);
  assert.ok(elapsed < 1000, `expected a fast timeout response, took ${elapsed}ms`);
  assert.equal(isValidFinalResponse(body), true);
  assert.equal(body.think_trace.execution_mode, "EARLY_EXIT");
  assert.equal(body.question, "q");
  assert.deepEqual(body.retrieved_context, []);
  assert.deepEqual(body.think_trace.operations, []);
  assert.deepEqual(body.think_trace.calculation, {});
  assert.deepEqual(body.think_trace.validation, {});
});

test("the signal passed to the runner becomes aborted at the deadline", async () => {
  let observedSignal;
  let observedAbortedInsideRunner = null;
  const handle = createAnswerHandler({
    runner: (question, options) => {
      observedSignal = options.signal;
      return new Promise((resolve) => {
        options.signal.addEventListener("abort", () => {
          observedAbortedInsideRunner = options.signal.aborted;
          resolve({
            final_response: {
              question,
              retrieved_context: [],
              think_trace: { execution_mode: "EARLY_EXIT", operations: [], calculation: {}, validation: {} },
              answer: "late",
            },
          });
        });
      });
    },
    timeoutMs: 30,
  });
  await handle(questionOnly("q"));
  assert.equal(observedSignal.aborted, true);
  assert.equal(observedAbortedInsideRunner, true);
});

test("the runner also receives deadline_at and timeout_ms options matching the configured timeoutMs", async () => {
  let received;
  const handle = createAnswerHandler({
    runner: async (question, options) => {
      received = options;
      return {
        final_response: {
          question,
          retrieved_context: [],
          think_trace: { execution_mode: "EARLY_EXIT", operations: [], calculation: {}, validation: {} },
          answer: "a",
        },
      };
    },
    timeoutMs: 12345,
  });
  await handle(questionOnly("q"));
  assert.equal(received.timeout_ms, 12345);
  assert.equal(typeof received.deadline_at, "string");
  assert.ok(!Number.isNaN(Date.parse(received.deadline_at)));
});

test("a client-supplied abort signal propagates to the runner's signal and short-circuits the request", async () => {
  const clientController = new AbortController();
  let observedSignal;
  const handle = createAnswerHandler({
    runner: (question, options) => {
      observedSignal = options.signal;
      return new Promise(() => {});
    },
    timeoutMs: 60_000, // long enough that only the client abort could end this quickly
  });
  const resultPromise = handle(questionOnly("q"), { signal: clientController.signal });
  await new Promise((resolve) => setTimeout(resolve, 10));
  clientController.abort();
  const { status, body } = await resultPromise;
  assert.equal(status, 200);
  assert.equal(observedSignal.aborted, true);
  assert.equal(isValidFinalResponse(body), true);
  assert.equal(body.think_trace.execution_mode, "EARLY_EXIT");
});

test("an already-aborted client signal means the runner is NEVER called — not even once", async () => {
  const clientController = new AbortController();
  clientController.abort();
  let runnerCallCount = 0;
  const handle = createAnswerHandler({
    runner: async () => {
      runnerCallCount += 1;
      return new Promise(() => {});
    },
    timeoutMs: 60_000,
  });
  const started = Date.now();
  const { status, body } = await handle(questionOnly("원래 질문"), { signal: clientController.signal });
  assert.ok(Date.now() - started < 1000);
  assert.equal(runnerCallCount, 0, "the runner must never be invoked when the request is already aborted at entry");
  assert.equal(status, 200);
  assert.equal(body.question, "원래 질문");
  assert.equal(isValidFinalResponse(body), true);
  assert.equal(body.think_trace.execution_mode, "EARLY_EXIT");
  assert.ok(!JSON.stringify(body).includes("CLIENT_DISCONNECT"));
});

test("an already-aborted client signal still clears the deadline timer and detaches the client-abort listener (cleanup runs even on the early-return path)", async () => {
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const createdTimers = new Set();
  const clearedTimers = new Set();
  globalThis.setTimeout = (...args) => {
    const id = originalSetTimeout(...args);
    createdTimers.add(id);
    return id;
  };
  globalThis.clearTimeout = (id) => {
    clearedTimers.add(id);
    return originalClearTimeout(id);
  };
  const clientController = new AbortController();
  clientController.abort();
  try {
    const handle = createAnswerHandler({ runner: echoRunner(), timeoutMs: 60_000 });
    await handle(questionOnly("q"), { signal: clientController.signal });
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }
  assert.ok(createdTimers.size > 0);
  for (const id of createdTimers) assert.ok(clearedTimers.has(id));
});

test("a timeout response never leaks the runner's internal error text, or the TIMEOUT/CLIENT_DISCONNECT distinction", async () => {
  const handle = createAnswerHandler({
    runner: (question, options) =>
      new Promise((resolve, reject) => {
        options.signal.addEventListener("abort", () => {
          reject(new Error("SECRET_INTERNAL_DETAIL at /app/secret.mjs:1:1"));
        });
      }),
    timeoutMs: 30,
  });
  const { status, body } = await handle(questionOnly("q"));
  assert.equal(status, 200);
  const serialized = JSON.stringify(body);
  assert.ok(!serialized.includes("SECRET_INTERNAL_DETAIL"));
  assert.ok(!serialized.includes("secret.mjs"));
  assert.ok(!serialized.includes("TIMEOUT"));
  assert.ok(!serialized.includes("CLIENT_DISCONNECT"));
});

test("a late resolve from a timed-out runner does not change the already-returned response", async () => {
  let releaseLate;
  const handle = createAnswerHandler({
    runner: (question) =>
      new Promise((resolve) => {
        releaseLate = () =>
          resolve({
            final_response: {
              question,
              retrieved_context: [],
              think_trace: { execution_mode: "STRUCTURED", operations: [], calculation: {}, validation: {} },
              answer: "should never be seen",
            },
          });
      }),
    timeoutMs: 30,
  });
  const { status, body } = await handle(questionOnly("q"));
  assert.equal(status, 200);
  assert.equal(body.think_trace.execution_mode, "EARLY_EXIT");
  const before = JSON.parse(JSON.stringify(body));
  releaseLate();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(body, before, "the already-returned body must not change after the runner resolves late");
});

test("a late reject from a timed-out runner does not produce a process unhandledRejection", async () => {
  const unhandled = [];
  const onUnhandledRejection = (reason) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandledRejection);
  try {
    let rejectLate;
    const handle = createAnswerHandler({
      runner: () =>
        new Promise((_, reject) => {
          rejectLate = () => reject(new Error("late failure"));
        }),
      timeoutMs: 30,
    });
    const { status } = await handle(questionOnly("q"));
    assert.equal(status, 200);
    rejectLate();
    await new Promise((resolve) => setTimeout(resolve, 20));
  } finally {
    process.removeListener("unhandledRejection", onUnhandledRejection);
  }
  assert.deepEqual(unhandled, []);
});

test("the deadline timer is cleared after a normal completion, not left running", async () => {
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const createdTimers = new Set();
  const clearedTimers = new Set();
  globalThis.setTimeout = (...args) => {
    const id = originalSetTimeout(...args);
    createdTimers.add(id);
    return id;
  };
  globalThis.clearTimeout = (id) => {
    clearedTimers.add(id);
    return originalClearTimeout(id);
  };
  try {
    const handle = createAnswerHandler({
      runner: async (question) => ({
        final_response: {
          question,
          retrieved_context: [],
          think_trace: { execution_mode: "STRUCTURED", operations: [], calculation: {}, validation: {} },
          answer: "a",
        },
      }),
      timeoutMs: 100,
    });
    await handle(questionOnly("q"));
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }
  assert.ok(createdTimers.size > 0, "expected the handler to create at least one timer");
  for (const id of createdTimers) {
    assert.ok(clearedTimers.has(id), "every timer created by the handler must be cleared after normal completion");
  }
});

test("no timer or AbortController is shared across concurrent requests — one request's timeout does not affect another's", async () => {
  const handle = createAnswerHandler({
    runner: async (question, options) => {
      if (question === "slow") {
        await new Promise((resolve) => options.signal.addEventListener("abort", resolve, { once: true }));
        return {
          final_response: {
            question,
            retrieved_context: [],
            think_trace: { execution_mode: "EARLY_EXIT", operations: [], calculation: {}, validation: {} },
            answer: "slow-timed-out",
          },
        };
      }
      return {
        final_response: {
          question,
          retrieved_context: [],
          think_trace: { execution_mode: "STRUCTURED", operations: [], calculation: {}, validation: {} },
          answer: "fast-ok",
        },
      };
    },
    timeoutMs: 30,
  });
  const [slow, fast] = await Promise.all([handle(questionOnly("slow")), handle(questionOnly("fast"))]);
  assert.equal(slow.status, 200);
  assert.equal(isValidFinalResponse(slow.body), true);
  assert.equal(slow.body.question, "slow");
  assert.equal(fast.status, 200);
  assert.equal(fast.body.answer, "fast-ok");
  assert.equal(fast.body.think_trace.execution_mode, "STRUCTURED");
  assert.equal(isValidFinalResponse(fast.body), true);
});
