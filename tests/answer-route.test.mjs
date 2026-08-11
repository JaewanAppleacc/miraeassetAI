import assert from "node:assert/strict";
import test from "node:test";
import { GET } from "../app/answer/route.ts";
import { isValidFinalResponse } from "../domain/runtime/final-response-validator.mjs";

function requestFor(query) {
  return new Request(`http://localhost/answer${query}`);
}

test("GET /answer sets the required headers", async () => {
  const response = await GET(requestFor("?question=q"));
  assert.equal(response.headers.get("Content-Type"), "application/json; charset=utf-8");
  assert.equal(response.headers.get("Cache-Control"), "no-store");
});

test("GET /answer with a valid question returns 200 and a schema-valid FinalResponse body", async () => {
  const response = await GET(requestFor("?question=삼성전자 2024년 매출액은?"));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(isValidFinalResponse(body), true);
  assert.deepEqual(Object.keys(body).sort(), ["answer", "question", "retrieved_context", "think_trace"]);
});

test("GET /answer preserves numbers, English abbreviations, and special characters through real URL decoding", async () => {
  const question = "ROE(%) 2024Q1 vs 2023Q1 - 삼성전자·SK하이닉스 비교, 증가율은?";
  const response = await GET(requestFor(`?question=${encodeURIComponent(question)}`));
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.question, question);
});

test("GET /answer with no question param returns 400 with a schema-valid FinalResponse body", async () => {
  const response = await GET(requestFor(""));
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(isValidFinalResponse(body), true);
});

test("GET /answer with a blank question param returns 400", async () => {
  const response = await GET(requestFor("?question=%20%20"));
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(isValidFinalResponse(body), true);
});

test("GET /answer with a duplicated question param returns 400", async () => {
  const response = await GET(requestFor("?question=a&question=b"));
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(isValidFinalResponse(body), true);
});

test("GET /answer never requires ChatGPT auth headers to succeed", async () => {
  // No oai-authenticated-user-* headers are set on this request at all.
  const response = await GET(requestFor("?question=q"));
  assert.equal(response.status, 200);
});
