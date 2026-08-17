import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createNodeAgentServer } from "../domain/runtime/node-agent-server.mjs";
import { validateAnswerWireResponse } from "../domain/runtime/answer-wire-response.mjs";

function fakeRuntime() {
  let initialized = false;
  return {
    async initialize() { initialized = true; },
    readiness() { return initialized ? { status: "READY", ready: true } : { status: "IDLE", ready: false }; },
    async run({ question }) {
      return {
        final_response: {
          question,
          retrieved_context: [],
          think_trace: { execution_mode: "EARLY_EXIT", operations: [], calculation: {}, validation: {} },
          answer: "테스트 응답",
        },
      };
    },
  };
}

async function withServer(run) {
  const server = createNodeAgentServer({ runtime: fakeRuntime(), timeoutMs: 1_000 });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("Node server exposes health and artifact-aware readiness", async () => {
  await withServer(async (base) => {
    assert.deepEqual(await (await fetch(`${base}/health`)).json(), { status: "ok" });
    const ready = await fetch(`${base}/ready`);
    assert.equal(ready.status, 200);
    assert.deepEqual(await ready.json(), { status: "READY", ready: true });
  });
});

test("Node server exposes the exact five-string /answer wire", async () => {
  await withServer(async (base) => {
    const url = new URL(`${base}/answer`);
    url.searchParams.set("question_id", "Q-001");
    url.searchParams.set("question", "질문");
    const response = await fetch(url);
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.deepEqual(validateAnswerWireResponse(body), []);
    assert.equal(body.question_id, "Q-001");
    assert.equal(body.question, "질문");
  });
});

test("Node server keeps malformed requests and unknown routes fail-closed", async () => {
  await withServer(async (base) => {
    const malformed = await fetch(`${base}/answer?question_id=Q-001`);
    assert.equal(malformed.status, 400);
    assert.deepEqual(validateAnswerWireResponse(await malformed.json()), []);
    assert.equal((await fetch(`${base}/missing`)).status, 404);
    assert.equal((await fetch(`${base}/answer`, { method: "POST" })).status, 405);
  });
});

test("deployment Runtime imports precompiled validators and contains no dynamic code generation", async () => {
  const generated = await readFile(new URL("../domain/generated/runtime-schema-validators.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(generated, /\brequire\s*\(/);
  assert.doesNotMatch(generated, /\bnew\s+Function\s*\(/);
  assert.doesNotMatch(generated, /\beval\s*\(/);
  for (const relative of [
    "../domain/runtime/answer-wire-response.mjs",
    "../domain/runtime/final-response-validator.mjs",
    "../domain/runtime/structured-store.mjs",
    "../domain/runtime/retriever-store.mjs",
    "../domain/adapters/seed-artifact-schema-validators.mjs",
  ]) {
    const source = await readFile(new URL(relative, import.meta.url), "utf8");
    assert.doesNotMatch(source, /from ["']ajv(?:\/|["'])/, relative);
  }
});
