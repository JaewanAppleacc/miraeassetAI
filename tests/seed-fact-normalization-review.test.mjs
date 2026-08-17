import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { reviewSeedFactNormalizationV02 } from "../scripts/review-seed-fact-normalization-v02.mjs";

const ROOT = path.resolve(new URL("..", import.meta.url).pathname);

test("independently re-resolves all 16 values, labels, units, and exact products", async () => {
  const result = await reviewSeedFactNormalizationV02({ root: ROOT, writeOutputs: false });
  assert.equal(result.audit.length, 16);
  assert.equal(result.approved, 16);
  assert.ok(result.audit.every((item) => item.disposition === "APPROVE" && Object.values(item.checks).every(Boolean)));
  assert.ok(result.audit.every((item) => item.unit_distance <= 1));
  assert.ok(result.decisions.every((item) => item.reviewer === "CODEX_OWNER_DIRECTED_CANONICAL_REVIEW"));
});
