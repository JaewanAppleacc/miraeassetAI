import assert from "node:assert/strict";
import test from "node:test";
import { buildSeedStructuredCodexReview } from "../scripts/build-seed-structured-codex-review.mjs";

test("independent review covers all 42 items and blocks promotion on Event provenance gaps", async () => {
  const { decisions, summary } = await buildSeedStructuredCodexReview({ writeOutputs: false, reviewedAt: "2026-08-13T00:00:00Z" });
  assert.equal(decisions.length, 42);
  assert.deepEqual(summary.decisions, { APPROVE_RECOMMENDED: 22, FIX_REQUIRED: 20 });
  assert.equal(summary.narrative_fact_approved, 13);
  assert.equal(summary.event_approved, 5);
  assert.equal(summary.event_fix_required, 19);
  assert.equal(summary.promotion_allowed, false);
});

test("LOI event date defect is explicit and the global gate remains closed", async () => {
  const { decisions } = await buildSeedStructuredCodexReview({ writeOutputs: false, reviewedAt: "2026-08-13T00:00:00Z" });
  const loi = decisions.find((record) => record.target_id === "event_cffef01467a71df30fdbb9c6");
  assert.equal(loi.decision, "FIX_REQUIRED");
  assert.ok(loi.findings.includes("EVENT_DATE_MUST_CHANGE_FROM_2023-06-05_TO_2023-06-03"));
  const gate = decisions.find((record) => record.item_type === "GLOBAL_PROMOTION_GATE");
  assert.equal(gate.decision, "FIX_REQUIRED");
});
