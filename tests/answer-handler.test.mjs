import assert from "node:assert/strict";
import test from "node:test";
import { createAnswerHandler } from "../domain/runtime/answer-handler.mjs";
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
