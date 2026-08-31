// Uses only SYNTHETIC fixture files written to a temp directory -- never
// reads the real domain/evaluation/releases/gold-phase1-207-v0.1/* files
// (those are exercised only by the real build/run scripts, not by tests).
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { validateDevTuneInputGate, DevTuneGateError, EXPECTED_OWNER_DECISION_SHA256 } from "../domain/agent-comparison/chunking-comparison/dev-tune-input-gate.mjs";

function sha256Hex(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

async function withFixture(rows, manifestOverrides, testFn) {
  const dir = await mkdtemp(path.join(tmpdir(), "p10.1-gate-test-"));
  try {
    const goldPath = path.join(dir, "gold.jsonl");
    const goldContent = `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`;
    await writeFile(goldPath, goldContent);
    const goldSha256 = sha256Hex(Buffer.from(goldContent, "utf8"));
    const manifestPath = path.join(dir, "manifest.json");
    const manifest = {
      owner_decision_sha256: EXPECTED_OWNER_DECISION_SHA256,
      dev_tune_gold_sha256: goldSha256,
      authorized_scope: { dev_tune_agent_use_authorized: true, dev_check_agent_use_authorized: false, holdout_agent_access_authorized: false },
      ...manifestOverrides,
    };
    await writeFile(manifestPath, JSON.stringify(manifest));
    await testFn({ goldJsonlPath: goldPath, manifestPath });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const VALID_ROWS = Array.from({ length: 101 }, (_, i) => ({ question_id: `q${i}`, split: "DEV_TUNE" }));

test("passes when all conditions match exactly", async () => {
  await withFixture(VALID_ROWS, {}, async ({ goldJsonlPath, manifestPath }) => {
    const { goldItems, checks } = await validateDevTuneInputGate({ goldJsonlPath, manifestPath });
    assert.equal(goldItems.length, 101);
    assert.ok(checks.every((c) => c.pass));
  });
});

test("fails closed when row count is not exactly 101", async () => {
  const rows = VALID_ROWS.slice(0, 100);
  await withFixture(rows, {}, async ({ goldJsonlPath, manifestPath }) => {
    await assert.rejects(() => validateDevTuneInputGate({ goldJsonlPath, manifestPath }), DevTuneGateError);
  });
});

test("fails closed when any row has split != DEV_TUNE", async () => {
  const rows = [...VALID_ROWS.slice(0, 100), { question_id: "bad", split: "DEV_CHECK" }];
  await withFixture(rows, {}, async ({ goldJsonlPath, manifestPath }) => {
    await assert.rejects(() => validateDevTuneInputGate({ goldJsonlPath, manifestPath }), DevTuneGateError);
  });
});

test("fails closed when owner_decision_sha256 does not match the pinned value", async () => {
  await withFixture(VALID_ROWS, { owner_decision_sha256: "0".repeat(64) }, async ({ goldJsonlPath, manifestPath }) => {
    await assert.rejects(() => validateDevTuneInputGate({ goldJsonlPath, manifestPath }), DevTuneGateError);
  });
});

test("fails closed when dev_check_agent_use_authorized is true", async () => {
  await withFixture(VALID_ROWS, { authorized_scope: { dev_tune_agent_use_authorized: true, dev_check_agent_use_authorized: true, holdout_agent_access_authorized: false } }, async ({ goldJsonlPath, manifestPath }) => {
    await assert.rejects(() => validateDevTuneInputGate({ goldJsonlPath, manifestPath }), DevTuneGateError);
  });
});

test("fails closed when holdout_agent_access_authorized is true", async () => {
  await withFixture(VALID_ROWS, { authorized_scope: { dev_tune_agent_use_authorized: true, dev_check_agent_use_authorized: false, holdout_agent_access_authorized: true } }, async ({ goldJsonlPath, manifestPath }) => {
    await assert.rejects(() => validateDevTuneInputGate({ goldJsonlPath, manifestPath }), DevTuneGateError);
  });
});

test("fails closed when the gold file's actual bytes do not match the manifest's pinned sha256 (tamper/drift detection)", async () => {
  await withFixture(VALID_ROWS, { dev_tune_gold_sha256: "f".repeat(64) }, async ({ goldJsonlPath, manifestPath }) => {
    await assert.rejects(() => validateDevTuneInputGate({ goldJsonlPath, manifestPath }), DevTuneGateError);
  });
});

test("fails closed when dev_tune_agent_use_authorized is false", async () => {
  await withFixture(VALID_ROWS, { authorized_scope: { dev_tune_agent_use_authorized: false, dev_check_agent_use_authorized: false, holdout_agent_access_authorized: false } }, async ({ goldJsonlPath, manifestPath }) => {
    await assert.rejects(() => validateDevTuneInputGate({ goldJsonlPath, manifestPath }), DevTuneGateError);
  });
});
