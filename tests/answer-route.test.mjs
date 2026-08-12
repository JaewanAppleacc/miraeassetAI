import assert from "node:assert/strict";
import test from "node:test";
import { GET } from "../app/answer/route.ts";
import { isValidAnswerWireResponse } from "../domain/runtime/answer-wire-response.mjs";

function requestFor(query) {
  return new Request(`http://localhost/answer${query}`);
}

function assertWireShape(body) {
  assert.equal(isValidAnswerWireResponse(body), true, `expected a valid wire body, got: ${JSON.stringify(body)}`);
  assert.deepEqual(Object.keys(body).sort(), ["answer", "question", "question_id", "retrieved_context", "think_trace"]);
}

test("GET /answer sets the required headers", async () => {
  const response = await GET(requestFor("?question_id=Q-001&question=q"));
  assert.equal(response.headers.get("Content-Type"), "application/json; charset=utf-8");
  assert.equal(response.headers.get("Cache-Control"), "no-store");
});

test("GET /answer with a valid question_id/question returns 200 and a schema-valid wire body with exactly the 5 required fields", async () => {
  const response = await GET(requestFor("?question_id=Q-001&question=삼성전자 2024년 매출액은?"));
  assert.equal(response.status, 200);
  const body = await response.json();
  assertWireShape(body);
  assert.equal(body.question_id, "Q-001");
});

test("GET /answer preserves numbers, English abbreviations, and special characters through real URL decoding", async () => {
  const question = "ROE(%) 2024Q1 vs 2023Q1 - 삼성전자·SK하이닉스 비교, 증가율은?";
  const response = await GET(requestFor(`?question_id=Q-002&question=${encodeURIComponent(question)}`));
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.question, question);
});

test("GET /answer with no question_id param returns 400 with a schema-valid wire body", async () => {
  const response = await GET(requestFor("?question=q"));
  assert.equal(response.status, 400);
  const body = await response.json();
  assertWireShape(body);
  assert.equal(body.question_id, "");
});

test("GET /answer with no question param returns 400 with a schema-valid wire body", async () => {
  const response = await GET(requestFor("?question_id=Q-001"));
  assert.equal(response.status, 400);
  const body = await response.json();
  assertWireShape(body);
  assert.equal(body.question_id, "Q-001");
});

test("GET /answer with a blank question param returns 400", async () => {
  const response = await GET(requestFor("?question_id=Q-001&question=%20%20"));
  assert.equal(response.status, 400);
  const body = await response.json();
  assertWireShape(body);
});

test("GET /answer with a duplicated question param returns 400", async () => {
  const response = await GET(requestFor("?question_id=Q-001&question=a&question=b"));
  assert.equal(response.status, 400);
  const body = await response.json();
  assertWireShape(body);
});

test("GET /answer with a duplicated question_id param returns 400", async () => {
  const response = await GET(requestFor("?question_id=Q-001&question_id=Q-002&question=q"));
  assert.equal(response.status, 400);
  const body = await response.json();
  assertWireShape(body);
});

test("GET /answer never requires auth headers to succeed", async () => {
  // No authorization/oai-authenticated-user-* headers are set on this request at all.
  const response = await GET(requestFor("?question_id=Q-001&question=q"));
  assert.equal(response.status, 200);
});

test("GET /answer wires request.signal through — an already-aborted request (client disconnect) returns fast with 503 and a valid wire body", async () => {
  const controller = new AbortController();
  controller.abort();
  const request = new Request("http://localhost/answer?question_id=Q-001&question=q", { signal: controller.signal });
  const started = Date.now();
  const response = await GET(request);
  assert.ok(Date.now() - started < 1000);
  assert.equal(response.status, 503);
  const body = await response.json();
  assertWireShape(body);
  assert.equal(JSON.parse(body.think_trace).execution_mode, "EARLY_EXIT");
  assert.equal(body.question, "q");
  assert.equal(body.question_id, "Q-001");
  assert.equal(response.headers.get("Content-Type"), "application/json; charset=utf-8");
  assert.equal(response.headers.get("Cache-Control"), "no-store");
});
