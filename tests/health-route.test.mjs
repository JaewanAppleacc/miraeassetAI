import assert from "node:assert/strict";
import test from "node:test";
import { GET } from "../app/health/route.ts";

test("GET /health returns 200 with exactly {status: ok} and no-store headers", async () => {
  const response = await GET();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Content-Type"), "application/json; charset=utf-8");
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  const body = await response.json();
  assert.deepEqual(body, { status: "ok" });
});
