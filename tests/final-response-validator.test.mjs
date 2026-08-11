import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { EXECUTION_ROUTES } from "../domain/contracts.mjs";
import { isValidFinalResponse, validateFinalResponse } from "../domain/runtime/final-response-validator.mjs";

function baseResponse({ think_trace, ...overrides } = {}) {
  return {
    question: "q",
    retrieved_context: [],
    think_trace: {
      execution_mode: "STRUCTURED",
      operations: [],
      calculation: {},
      validation: {},
      ...think_trace,
    },
    answer: "a",
    ...overrides,
  };
}

// --- one execution_mode enum, never two ------------------------------------

test("final-response.schema.json's execution_mode enum is identical to domain/contracts.mjs's EXECUTION_ROUTES", () => {
  const schema = JSON.parse(readFileSync("domain/interfaces/final-response.schema.json", "utf8"));
  const schemaEnum = schema.properties.think_trace.properties.execution_mode.enum;
  assert.deepEqual(schemaEnum, EXECUTION_ROUTES);
});

// --- valid responses for every execution_mode pass --------------------------

for (const mode of ["STRUCTURED", "RETRIEVAL", "BOTH", "EARLY_EXIT"]) {
  test(`a well-formed ${mode} FinalResponse passes schema validation`, () => {
    const errors = validateFinalResponse(baseResponse({ think_trace: { execution_mode: mode } }));
    assert.deepEqual(errors, []);
  });
}

test("the canonical example file passes schema validation", () => {
  const example = JSON.parse(readFileSync("domain/interfaces/examples/final-response.example.json", "utf8"));
  assert.deepEqual(validateFinalResponse(example), []);
});

// --- required top-level fields ----------------------------------------------

for (const field of ["question", "retrieved_context", "think_trace", "answer"]) {
  test(`missing top-level required field "${field}" fails schema validation`, () => {
    const response = baseResponse();
    delete response[field];
    assert.ok(validateFinalResponse(response).length > 0);
  });
}

test("an unknown top-level field fails schema validation", () => {
  const response = baseResponse();
  response.execution_trace = { flow_id: "smuggled" };
  assert.ok(validateFinalResponse(response).length > 0);
});

test("a non-object unknown field name is still rejected by the top-level additionalProperties gate", () => {
  const response = baseResponse();
  response.__unexpected_field = true;
  assert.ok(validateFinalResponse(response).length > 0);
});

// --- top-level field types ---------------------------------------------------

test("a non-string question fails raw schema validation", () => {
  const response = baseResponse({ question: 123 });
  assert.ok(validateFinalResponse(response).length > 0);
});

test("a non-string answer fails raw schema validation", () => {
  const response = baseResponse({ answer: 123 });
  assert.ok(validateFinalResponse(response).length > 0);
});

test("a non-array retrieved_context fails raw schema validation", () => {
  const response = baseResponse({ retrieved_context: {} });
  assert.ok(validateFinalResponse(response).length > 0);
});

// --- think_trace required fields ---------------------------------------------

for (const field of ["execution_mode", "operations", "calculation", "validation"]) {
  test(`missing think_trace field "${field}" fails schema validation`, () => {
    const response = baseResponse();
    delete response.think_trace[field];
    assert.ok(validateFinalResponse(response).length > 0);
  });
}

test("an unrecognized execution_mode value fails raw schema validation (Serializer normalization happens before this check, not instead of it)", () => {
  const response = baseResponse({ think_trace: { execution_mode: "MADE_UP_MODE" } });
  assert.ok(validateFinalResponse(response).length > 0);
});

test("an unknown field inside think_trace fails schema validation", () => {
  const response = baseResponse();
  response.think_trace.fallback_reason = "smuggled";
  assert.ok(validateFinalResponse(response).length > 0);
});

// --- trust-boundary defect fix: schema-shaped is not the same as JSON-safe.
//     Every value nested inside retrieved_context/operations/calculation/
//     validation must actually be representable on the JSON wire — a value
//     that merely "looks like an object/array" (BigInt, function, Symbol,
//     undefined, non-finite number, or a value hiding one of those two
//     levels deep) must be rejected, not waved through because the outer
//     shape matched. ---------------------------------------------------------

test("the exact reported repro (BigInt/function/BigInt/undefined nested at nonobvious positions) is rejected, not accepted", () => {
  const candidate = {
    question: "q",
    retrieved_context: [10n],
    think_trace: {
      execution_mode: "STRUCTURED",
      operations: [() => 1],
      calculation: { x: 10n },
      validation: { u: undefined },
    },
    answer: "a",
  };
  assert.equal(isValidFinalResponse(candidate), false);
  assert.ok(validateFinalResponse(candidate).length > 0);
  // the historical bug: this really would have thrown if fed straight to
  // JSON.stringify — confirm that's still true, i.e. this fixture is a
  // faithful repro and not something that was secretly already JSON-safe.
  assert.throws(() => JSON.stringify(candidate), TypeError);
});

test("a BigInt inside retrieved_context is rejected", () => {
  const response = baseResponse({ retrieved_context: [10n] });
  assert.equal(isValidFinalResponse(response), false);
});

test("a function inside think_trace.operations is rejected", () => {
  const response = baseResponse();
  response.think_trace.operations = [() => 1];
  assert.equal(isValidFinalResponse(response), false);
});

test("a BigInt inside think_trace.calculation is rejected", () => {
  const response = baseResponse();
  response.think_trace.calculation = { x: 10n };
  assert.equal(isValidFinalResponse(response), false);
});

test("undefined inside think_trace.validation is rejected", () => {
  const response = baseResponse();
  response.think_trace.validation = { u: undefined };
  assert.equal(isValidFinalResponse(response), false);
});

test("a Symbol inside think_trace.validation is rejected", () => {
  const response = baseResponse();
  response.think_trace.validation = { s: Symbol("x") };
  assert.equal(isValidFinalResponse(response), false);
});

test("NaN inside think_trace.calculation is rejected", () => {
  const response = baseResponse();
  response.think_trace.calculation = { x: NaN };
  assert.equal(isValidFinalResponse(response), false);
});

test("Infinity and -Infinity inside think_trace.calculation are rejected", () => {
  for (const bad of [Infinity, -Infinity]) {
    const response = baseResponse();
    response.think_trace.calculation = { x: bad };
    assert.equal(isValidFinalResponse(response), false);
  }
});

test("a circular reference nested inside retrieved_context does not throw and is rejected as invalid", () => {
  const cycle = {};
  cycle.self = cycle;
  const response = baseResponse({ retrieved_context: [cycle] });
  assert.doesNotThrow(() => isValidFinalResponse(response));
  assert.equal(isValidFinalResponse(response), false);
  assert.doesNotThrow(() => validateFinalResponse(response));
  assert.ok(validateFinalResponse(response).length > 0);
});

test("a circular think_trace.calculation does not throw and is rejected as invalid", () => {
  const cycle = {};
  cycle.self = cycle;
  const response = baseResponse();
  response.think_trace.calculation = cycle;
  assert.doesNotThrow(() => isValidFinalResponse(response));
  assert.equal(isValidFinalResponse(response), false);
});

test("a getter that throws on access does not escape the validator and is rejected as invalid", () => {
  const poisoned = {};
  Object.defineProperty(poisoned, "boom", {
    enumerable: true,
    get() {
      throw new Error("cannot read this");
    },
  });
  const response = baseResponse();
  response.think_trace.validation = poisoned;
  assert.doesNotThrow(() => isValidFinalResponse(response));
  assert.equal(isValidFinalResponse(response), false);
  assert.doesNotThrow(() => validateFinalResponse(response));
  assert.ok(validateFinalResponse(response).length > 0);
});

test("validateFinalResponse/isValidFinalResponse never throw on adversarial top-level input either", () => {
  const cycle = {};
  cycle.self = cycle;
  for (const candidate of [cycle, 10n, () => 1, Symbol("x"), NaN, Infinity, null, undefined, "not an object", 42]) {
    assert.doesNotThrow(() => validateFinalResponse(candidate));
    assert.doesNotThrow(() => isValidFinalResponse(candidate));
  }
});

test("a well-formed, deeply nested JSON-safe object/array in retrieved_context/calculation/validation still passes", () => {
  const response = baseResponse({
    retrieved_context: [
      { document_id: "exchange_20230428800439", source_locator: "exchange_20230428800439/20230428800439.xml#node=0", nested: { a: [1, "x", null, true, { b: 2.5 }] } },
    ],
  });
  response.think_trace.operations = ["lookup_event", { op: "calculate", inputs: [1, 2, 3] }];
  response.think_trace.calculation = { result: 42, breakdown: { a: 1, b: [1, 2, { c: null }] } };
  response.think_trace.validation = { evidence_supported: true, notes: ["ok"], nested: { deep: { deeper: [1, 2, 3] } } };
  assert.deepEqual(validateFinalResponse(response), []);
  assert.equal(isValidFinalResponse(response), true);
});

// --- wire-shape defect fix: the RAW candidate satisfying the schema is not
//     the same claim as "what actually goes over the wire satisfies the
//     schema". JSON.stringify() silently substitutes a value's toJSON()
//     return value (even when toJSON is a non-enumerable property Ajv would
//     never see while walking `candidate` itself) — so the object that gets
//     schema-checked and the object that gets serialized can legitimately
//     be two different values. Only re-validating the actual parsed wire
//     value closes that gap. -------------------------------------------------

function withNonEnumerableToJSON(candidate, toJSON) {
  const clone = structuredClone(candidate);
  Object.defineProperty(clone, "toJSON", { value: toJSON, enumerable: false, configurable: true });
  return clone;
}

test("a non-enumerable toJSON() that collapses the whole response to {} on the wire is rejected", () => {
  const candidate = withNonEnumerableToJSON(baseResponse(), () => ({}));
  // The raw candidate's own enumerable fields are still schema-valid on
  // their own — this fixture is only interesting because of that.
  assert.doesNotThrow(() => isValidFinalResponse(candidate));
  assert.equal(isValidFinalResponse(candidate), false);
  const errors = validateFinalResponse(candidate);
  assert.ok(errors.length > 0);
  // real confirmation this is a faithful repro, not an already-broken fixture:
  assert.equal(JSON.stringify(candidate), "{}");
});

test("a toJSON() that rewrites execution_mode to an invalid value on the wire is rejected", () => {
  const candidate = withNonEnumerableToJSON(baseResponse(), function () {
    return { ...this, think_trace: { ...this.think_trace, execution_mode: "MADE_UP_MODE" } };
  });
  assert.doesNotThrow(() => isValidFinalResponse(candidate));
  assert.equal(isValidFinalResponse(candidate), false);
  assert.ok(validateFinalResponse(candidate).length > 0);
});

test("a toJSON() that throws does not escape the validator and is rejected as invalid", () => {
  const candidate = withNonEnumerableToJSON(baseResponse(), () => {
    throw new Error("toJSON boom");
  });
  assert.doesNotThrow(() => isValidFinalResponse(candidate));
  assert.equal(isValidFinalResponse(candidate), false);
  assert.doesNotThrow(() => validateFinalResponse(candidate));
  assert.ok(validateFinalResponse(candidate).length > 0);
});

test("a toJSON() returning undefined (so JSON.stringify itself returns undefined, not a string) is rejected without throwing", () => {
  const candidate = withNonEnumerableToJSON(baseResponse(), () => undefined);
  assert.equal(JSON.stringify(candidate), undefined);
  assert.doesNotThrow(() => isValidFinalResponse(candidate));
  assert.equal(isValidFinalResponse(candidate), false);
});

test("a well-formed response with no toJSON at all still passes after the wire round-trip re-check", () => {
  const response = baseResponse({ think_trace: { execution_mode: "BOTH", operations: ["op"], calculation: { a: 1 }, validation: { ok: true } } });
  assert.deepEqual(validateFinalResponse(response), []);
  assert.equal(isValidFinalResponse(response), true);
});
