// Turn M item 3: verifies the remediation matrix mechanically tracks all
// 24 FIX_REQUIRED notes, never forces RESOLVED, and every status has a
// real, non-empty explanation.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MATRIX_PATH = path.join(ROOT, "work/handoff/seed-final-response-owner-review/results/seed-response-remediation-matrix.v0.1.jsonl");
const DECISION_PATH = path.join(ROOT, "work/handoff/seed-final-response-owner-review/results/seed-response-owner-decision.v0.7.jsonl");

let rows;
test.before(async () => { rows = (await readFile(MATRIX_PATH, "utf8")).trim().split("\n").map((l) => JSON.parse(l)); });

test("exactly 24 rows, one per FIX_REQUIRED question_id, no duplicates", async () => {
  const decision = (await readFile(DECISION_PATH, "utf8")).trim().split("\n").map((l) => JSON.parse(l));
  const fixRequiredQids = new Set(decision.filter((r) => r.owner_disposition === "FIX_REQUIRED").map((r) => r.question_id));
  assert.equal(rows.length, 24);
  const matrixQids = new Set(rows.map((r) => r.question_id));
  assert.equal(matrixQids.size, 24);
  assert.deepEqual([...matrixQids].sort(), [...fixRequiredQids].sort());
});

test("every row has a real status (not all forced RESOLVED) and a non-empty explanation", () => {
  const statuses = new Set(rows.map((r) => r.status));
  assert.ok(statuses.has("PARTIAL") || statuses.has("BLOCKED"), "matrix must not force every item to RESOLVED");
  for (const row of rows) {
    assert.ok(["RESOLVED", "PARTIAL", "BLOCKED"].includes(row.status));
    assert.ok(typeof row.post_fix_observation.summary === "string" && row.post_fix_observation.summary.length > 20);
  }
});

test("every row cites at least one common capability_id (A-H), never a per-question code reference", () => {
  for (const row of rows) {
    assert.ok(Array.isArray(row.remediation_capability_ids) && row.remediation_capability_ids.length > 0);
    for (const cap of row.remediation_capability_ids) assert.ok("ABCDEFGH".includes(cap));
  }
});

test("every row's owner_note_sha256 matches a real sha256 of its own owner_note text", async () => {
  const { createHash } = await import("node:crypto");
  for (const row of rows) {
    const actual = createHash("sha256").update(Buffer.from(row.owner_note, "utf8")).digest("hex");
    assert.equal(actual, row.owner_note_sha256);
  }
});

test("every row's post_fix_observation.wire_sha256 matches the real r7 wire file", async () => {
  const { createHash } = await import("node:crypto");
  for (const row of rows) {
    const wirePath = row.post_fix_observation.wire_path;
    assert.ok(wirePath, `${row.question_id} missing post_fix wire_path`);
    const bytes = await readFile(path.join(ROOT, wirePath));
    const actual = createHash("sha256").update(bytes).digest("hex");
    assert.equal(actual, row.post_fix_observation.wire_sha256);
  }
});
